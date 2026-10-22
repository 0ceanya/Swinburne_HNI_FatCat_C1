import { DECRYPT_ROLE, ENCRYPT_ROLE } from "../domain/tier.js";
import { buildDataToVerify, wrapUnsigned, type PolicyFields } from "./policyBytes.js";

/** Built into every ORK: counts approvers holding a realm role. No deployment needed. */
export const THRESHOLD_CONTRACT = "GenericRealmAccessThresholdRole:1";
/** Built into every ORK on `main`: who may encrypt/decrypt one record's data. */
export const RELATIONSHIP_CONTRACT = "RelationshipAttestation:1";
/** The model of a request that asks the network to sign a policy. */
export const POLICY_SIGN_MODEL = "Policy:1";
/** Identifies an approval statement. It authorises nothing: no request uses this model. */
export const STATEMENT_MODEL = "BasicCustom<SignGuardApproval>:BasicCustom<1>";
/** Every sealed field is tagged with this one assignment id. */
export const SEALED_ASSIGNMENT_ID = "signguard-sealed-v1";
/** Every realm user holds `appUser` (default role); the contract also requires the tide role. */
export const SEALED_SUBJECT_ROLE = "appUser";

/**
 * A signing rule: "the network may sign a policy (an approval statement) once `threshold`
 * approvers holding realm role `role` have approved it in Tide's enclave". A realm admin signs each
 * rule once, under the realm's admin policy.
 */
export function signingRuleFields(vendorId: string, clientId: string, role: string, threshold: number): PolicyFields {
  return {
    contractId: THRESHOLD_CONTRACT,
    modelIds: [POLICY_SIGN_MODEL],
    keyId: vendorId,
    approvalType: "EXPLICIT",
    executionType: "PUBLIC",
    params: { resource: clientId, role, threshold },
  };
}

export interface StatementInput {
  vendorId: string;
  clientId: string;
  org: string;
  requestId: string;
  docId: string;
  docNumber: string;
  docType: string;
  amountDong: string;
  contentHash: string;
  band: string;
  policyVersion: number;
  initiatorVuid: string;
  auditSeq: number;
  auditHead: string;
}

/**
 * The approval statement the network signs: "these approvers approved document X with content hash
 * H, for amount A, under rule R of policy version V; the audit log stood at head Q". It is shaped as
 * a policy because signing a policy is how the network signs arbitrary statements (the pattern in
 * Tide's attestation template), but it can never authorise anything: its role does not exist and
 * its threshold is unreachable.
 */
export function statementFields(s: StatementInput): PolicyFields {
  return {
    contractId: THRESHOLD_CONTRACT,
    modelIds: [STATEMENT_MODEL],
    keyId: s.vendorId,
    approvalType: "EXPLICIT",
    executionType: "PUBLIC",
    params: {
      amount: s.amountDong,
      audithead: s.auditHead,
      auditseq: String(s.auditSeq),
      band: s.band,
      contenthash: s.contentHash,
      docid: s.docId,
      docnumber: s.docNumber,
      doctype: s.docType,
      initiator: s.initiatorVuid,
      org: s.org,
      policyversion: String(s.policyVersion),
      requestid: s.requestId,
      resource: s.clientId,
      role: "sgstatementonly",
      threshold: 99,
    },
  };
}

/** One policy for every sealed field: holders of appUser with _tide_encryptor/_tide_decryptor. */
export function sealedFieldsPolicyFields(vendorId: string): PolicyFields {
  return {
    contractId: RELATIONSHIP_CONTRACT,
    modelIds: ["PolicyEnabledEncryption:1", "PolicyEnabledDecryption:1"],
    keyId: vendorId,
    approvalType: "IMPLICIT",
    executionType: "PRIVATE",
    params: {
      assignmentId: SEALED_ASSIGNMENT_ID,
      roles: JSON.stringify([ENCRYPT_ROLE, DECRYPT_ROLE]),
      subjectId: SEALED_SUBJECT_ROLE,
      subjectType: "Role",
    },
  };
}

export const unsignedPolicy = (f: PolicyFields) => wrapUnsigned(buildDataToVerify(f));
