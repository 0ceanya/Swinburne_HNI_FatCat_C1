import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import { api } from "@/api/client";
import type { Doc, SealedValues } from "@/api/types";
import { sealValues, unsealValues } from "@/tide/tide";

type Opened = { state: "open"; values: SealedValues } | { state: "locked"; reason: string } | { state: "loading" };

/**
 * Sealed fields are ciphertext from Tide's RelationshipAttestation:1 contract. They are decrypted
 * here, in the browser, only for members holding _tide_decryptor; the server never sees plaintext.
 */
export const useSealed = defineStore("sealed", () => {
  const policy = ref<string | null>(null);
  const opened = reactive(new Map<string, Opened>());

  async function sealedPolicy(): Promise<string> {
    if (!policy.value) policy.value = (await api.sealedPolicy()).policy;
    return policy.value;
  }

  /** Encrypt the three fields for a new or edited draft. */
  async function seal(values: SealedValues): Promise<SealedValues> {
    const [counterparty, bankAccount, description] = await sealValues([values.counterparty, values.bankAccount, values.description || " "], await sealedPolicy());
    return { counterparty: counterparty!, bankAccount: bankAccount!, description: description! };
  }

  /** Decrypt several documents in one Tide call. */
  async function open(docs: Doc[], canDecrypt: boolean): Promise<void> {
    const pending = docs.filter((d) => !opened.has(d.id + ":" + d.editVersion));
    if (pending.length === 0) return;
    for (const d of pending) {
      const key = d.id + ":" + d.editVersion;
      if (d.sealing === "plaintext-dev") opened.set(key, { state: "open", values: d.sealed });
      else if (!canDecrypt) opened.set(key, { state: "locked", reason: "You don't have access to this field" });
      else opened.set(key, { state: "loading" });
    }
    const sealedDocs = pending.filter((d) => d.sealing === "tide-relationship-v1" && canDecrypt);
    if (sealedDocs.length === 0) return;
    try {
      const flat = sealedDocs.flatMap((d) => [d.sealed.counterparty, d.sealed.bankAccount, d.sealed.description]);
      const plain = await unsealValues(flat, await sealedPolicy());
      sealedDocs.forEach((d, i) => {
        opened.set(d.id + ":" + d.editVersion, {
          state: "open",
          values: { counterparty: plain[i * 3] ?? "", bankAccount: plain[i * 3 + 1] ?? "", description: (plain[i * 3 + 2] ?? "").trim() },
        });
      });
    } catch (e) {
      for (const d of sealedDocs) opened.set(d.id + ":" + d.editVersion, { state: "locked", reason: e instanceof Error ? e.message : "Could not decrypt" });
    }
  }

  const view = (d: Doc): Opened => opened.get(d.id + ":" + d.editVersion) ?? { state: "loading" };

  /** Props for <SealedValue> for one field of one document. */
  function fieldView(d: Doc, field: keyof SealedValues): { state: "open" | "locked" | "loading"; value?: string; reason?: string } {
    const v = view(d);
    if (v.state === "open") return { state: "open", value: v.values[field] };
    if (v.state === "locked") return { state: "locked", reason: v.reason };
    return { state: "loading" };
  }

  return { seal, open, view, fieldView, sealedPolicy };
});
