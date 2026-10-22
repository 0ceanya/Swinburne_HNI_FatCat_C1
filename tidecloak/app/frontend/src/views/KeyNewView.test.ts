import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { TideSetup } from "@/api/types";
import { config, makeKey, makeMe, makeRequest } from "@/test/fixtures";

const tideMock = {
  draftSeal: vi.fn(async () => "SEAL_DRAFT"),
  toBase64: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  onPopupBlocked: vi.fn(), initTide: vi.fn(), login: vi.fn(), logout: vi.fn(), secureFetch: vi.fn(),
};
vi.mock("@/tide/tide", () => tideMock);

const setup = (signed: number[]): TideSetup => ({
  isRealmAdmin: true, directoryAvailable: true, boardSize: 3,
  policies: [1, 2, 3].map((threshold) => ({ threshold, signed: signed.includes(threshold), signatureVerified: true, signedBy: null, signedAt: null, keysUsing: 0, unsigned: "" })),
});
const apiMock = {
  tideSetup: vi.fn(async () => setup([1, 2, 3])),
  registerKey: vi.fn(async () => ({ key: makeKey({ status: "pending_seal" }), request: makeRequest({ id: "req_9", operation: "seal" }) })),
};
vi.mock("@/api/client", () => ({ api: apiMock, ApiError: class extends Error {} }));

const { default: KeyNewView } = await import("./KeyNewView.vue");
const { useSession } = await import("@/stores/session");

async function render() {
  setActivePinia(createPinia());
  const session = useSession();
  session.me = makeMe();
  session.config = config;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { template: "<div />" } }] });
  await router.push("/vault/new");
  const wrapper = mount(KeyNewView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe("Add a key", () => {
  beforeEach(() => { vi.clearAllMocks(); apiMock.tideSetup.mockImplementation(async () => setup([1, 2, 3])); });

  it("each key type suggests its level, and the form says how many board members it needs", async () => {
    const { wrapper } = await render();
    expect((wrapper.find("#k-level").element as HTMLSelectElement).value).toBe("3");
    await wrapper.find("#k-kind").setValue("cloud_root");
    expect((wrapper.find("#k-level").element as HTMLSelectElement).value).toBe("4");
    expect(wrapper.text()).toContain("3 of 3 board members: level 4 is capped at the board size");
    await wrapper.find("#k-kind").setValue("api_key");
    expect(wrapper.text()).toContain("Needs 2 of 3 board members");
  });

  it("encrypts in the browser and sends the server only the draft, never the secret", async () => {
    const { wrapper, router } = await render();
    await wrapper.find("#k-name").setValue("Viettel MySign");
    await wrapper.find("#k-secret").setValue("PIN-246810");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(tideMock.draftSeal).toHaveBeenCalledWith("PIN-246810");
    const sent = (apiMock.registerKey.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: "Viettel MySign", kind: "digital_signature", level: 3, request: "SEAL_DRAFT" });
    expect(JSON.stringify(sent)).not.toContain("PIN-246810");
    expect(router.currentRoute.value.fullPath).toBe("/requests/req_9");
  });

  it("will not register a key whose network policy is not signed yet", async () => {
    apiMock.tideSetup.mockImplementation(async () => setup([1, 2]));
    const { wrapper } = await render();
    await wrapper.find("#k-name").setValue("Bank token");
    await wrapper.find("#k-secret").setValue("x");
    expect(wrapper.text()).toContain("policy for 3 approvals is not signed yet");
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeDefined();
  });
});
