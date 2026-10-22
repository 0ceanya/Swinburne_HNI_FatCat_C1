import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { webcrypto } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { SignatureReceipt } from "../domain/document.js";
import { toBase64, utf8Bytes } from "./util.js";
import { parseDataToVerify } from "../tide/policyBytes.js";
import { verifyRealmSignature, type RealmKeys } from "../tide/signatures.js";
import type { CaSigningGateway } from "../usecases/ports.js";

type CryptoKeyPair = webcrypto.CryptoKeyPair;
type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Stand-in for a remote-signing CA (VNPT SmartCA, Viettel MySign). The CA keeps its own key; in
 * production that key is the company's legally certified one and never leaves the CA.
 *
 * The behaviour worth copying into a real integration: the CA refuses to sign unless the request
 * carries the Tide network's signature over the approval statement for this exact content hash. Then
 * no single person at the company can get the CA to sign by calling it directly.
 */
export class MockCa implements CaSigningGateway {
  private keyPair: Promise<CryptoKeyPair>;

  constructor(private keyPath: string | null, private realmKeys: RealmKeys, private clock: () => Date = () => new Date()) {
    this.keyPair = this.loadOrCreate();
  }

  private async loadOrCreate(): Promise<CryptoKeyPair> {
    const subtle = webcrypto.subtle;
    if (this.keyPath && existsSync(this.keyPath)) {
      const jwk = JSON.parse(readFileSync(this.keyPath, "utf8"));
      const privateKey = await subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
      const publicKey = await subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
      return { privateKey, publicKey } as CryptoKeyPair;
    }
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    if (this.keyPath) {
      mkdirSync(dirname(this.keyPath), { recursive: true });
      writeFileSync(this.keyPath, JSON.stringify(await subtle.exportKey("jwk", pair.privateKey)), { mode: 0o600 });
    }
    return pair;
  }

  async signInvoice(input: { contentHash: string; statement: Uint8Array; tideSignature: Uint8Array }): Promise<SignatureReceipt> {
    if (!(await verifyRealmSignature(this.realmKeys, input.tideSignature, input.statement))) {
      throw new DomainError("CA_REFUSED", "Mock CA: no valid Tide approval signature, so the CA will not sign", 422);
    }
    // The CA must also see that the approved statement is about this content hash.
    let approvedHash: unknown;
    try { approvedHash = parseDataToVerify(input.statement).params.contenthash; } catch { approvedHash = null; }
    if (approvedHash !== input.contentHash) {
      throw new DomainError("CA_REFUSED", "Mock CA: the Tide approval is for different content", 422);
    }
    const { privateKey } = await this.keyPair;
    const message = utf8Bytes(`SIGNGUARD-MOCK-CA:e-invoice:${input.contentHash}`);
    const signature = new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
    return { provider: "mock-ca", signature: toBase64(signature), signedAt: this.clock().toISOString(), covers: `SIGNGUARD-MOCK-CA:e-invoice:<contentHash>`, keyId: "mock-ca-1" };
  }

  async publicKeyJwk(): Promise<JsonWebKey> {
    const { publicKey } = await this.keyPair;
    return webcrypto.subtle.exportKey("jwk", publicKey);
  }
}
