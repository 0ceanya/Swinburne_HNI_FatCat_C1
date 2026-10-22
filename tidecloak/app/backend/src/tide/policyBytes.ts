import { container, entries, fromUtf8, getValue, int32LE, tryGetValue, utf8 } from "../lib/tideMemory.js";

/**
 * Tide "Policy" byte layout, built without the browser SDK.
 *
 *   dataToVerify = container([version, contractId, container([modelId...]), keyId,
 *                             approvalType, executionType, container([param...])])
 *   param        = container([name, type, value])   type "str" (UTF-8) or "num" (int32 LE)
 *   policy       = container([dataToVerify])  unsigned, or container([dataToVerify, signature])
 *
 * The network signs `dataToVerify`. Parameters are always written in name order, and every name is
 * lowercase letters only (or the fixed names a built-in contract demands), so the bytes are the same
 * whichever order the network rebuilds them in.
 *
 * Mirrors @tideorg/js `Models.Policy` 0.14.29, whose latest layout is version "4"; the cross-check
 * lives in test/tide/codec.test.ts.
 */
export const POLICY_VERSION = "4";

export type ParamValue = string | number;
export type ApprovalTypeName = "EXPLICIT" | "IMPLICIT";
export type ExecutionTypeName = "PRIVATE" | "PUBLIC";

export interface PolicyFields {
  contractId: string;
  modelIds: string[];
  keyId: string;
  approvalType: ApprovalTypeName;
  executionType: ExecutionTypeName;
  params: Record<string, ParamValue>;
}

function encodeParam(name: string, value: ParamValue): Uint8Array {
  if (typeof value === "string") return container([utf8(name), utf8("str"), utf8(value)]);
  if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) throw new RangeError(`param ${name} is not an int32`);
  return container([utf8(name), utf8("num"), int32LE(value)]);
}

/** Ordinal name order (code unit order), the same as C#'s ordinal comparison. */
export const sortedParamNames = (params: Record<string, ParamValue>) =>
  Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function buildDataToVerify(f: PolicyFields): Uint8Array {
  const params = sortedParamNames(f.params).map((k) => encodeParam(k, f.params[k]!));
  return container([
    utf8(POLICY_VERSION),
    utf8(f.contractId),
    container(f.modelIds.map(utf8)),
    utf8(f.keyId),
    utf8(f.approvalType),
    utf8(f.executionType),
    container(params),
  ]);
}

export const wrapUnsigned = (dataToVerify: Uint8Array): Uint8Array => container([dataToVerify]);
export const wrapSigned = (dataToVerify: Uint8Array, signature: Uint8Array): Uint8Array => container([dataToVerify, signature]);

export interface ParsedPolicy extends PolicyFields {
  version: string;
  dataToVerify: Uint8Array;
  signature: Uint8Array | null;
}

/** Parse a stored policy (signed or unsigned). Throws on anything that is not a Tide policy. */
export function parsePolicy(policy: Uint8Array): ParsedPolicy {
  const dataToVerify = getValue(policy, 0);
  const signature = tryGetValue(policy, 1) ?? null;
  return { ...parseDataToVerify(dataToVerify), signature: signature && signature.length > 0 ? signature : null };
}

/** Parse the signed body of a policy. */
export function parseDataToVerify(dataToVerify: Uint8Array): Omit<ParsedPolicy, "signature"> {
  const version = fromUtf8(getValue(dataToVerify, 0));
  const params: Record<string, ParamValue> = {};
  for (const p of entries(getValue(dataToVerify, 6))) {
    const name = fromUtf8(getValue(p, 0));
    const type = fromUtf8(getValue(p, 1));
    const raw = getValue(p, 2);
    if (type === "str") params[name] = fromUtf8(raw);
    else if (type === "num") params[name] = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(0, true);
    else throw new TypeError(`unsupported param type ${type}`);
  }
  return {
    version,
    contractId: fromUtf8(getValue(dataToVerify, 1)),
    modelIds: entries(getValue(dataToVerify, 2)).map(fromUtf8),
    keyId: fromUtf8(getValue(dataToVerify, 3)),
    approvalType: fromUtf8(getValue(dataToVerify, 4)) as ApprovalTypeName,
    executionType: fromUtf8(getValue(dataToVerify, 5)) as ExecutionTypeName,
    params,
    dataToVerify,
  };
}
