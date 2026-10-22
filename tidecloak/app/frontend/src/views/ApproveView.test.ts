import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { makeDoc, makeMe, makeRequest } from "@/test/fixtures";

const calls: string[] = [];
const tideMock = {
  approveSigningRequest: vi.fn(async () => { calls.push("tide.approve"); return "APPROVED"; }),
  executeSigningRequest: vi.fn(async () => { calls.push("tide.execute"); return "SIG"; }),
  openSigningRequest: vi.fn(async () => "INIT"),
  sealValues: vi.fn(), unsealValues: vi.fn(async (v: string[]) => v), onPopupBlocked: vi.fn(), initTide: vi.fn(),
  login: vi.fn(), logout: vi.fn(), secureFetch: vi.fn(),
};
vi.mock("@/tide/tide", () => tideMock);

const apiMock = {
  request: vi.fn(), document: vi.fn(), sealedPolicy: vi.fn(),
  approve: vi.fn(async () => { calls.push("api.approve"); return makeRequest({ status: "quorum_met", approvals: [...makeRequest().approvals, { memberId: "u-owner", name: "Nguyễn An", countedAs: "owner", at: "", proof: { kind: "tide-enclave" } }], outstanding: [] }); }),
  recordSignature: vi.fn(async () => { calls.push("api.signature"); return { request: makeRequest({ status: "signed", outstanding: [] }) }; }),
  reject: vi.fn(async () => makeRequest({ status: "rejected", rejection: { name: "Nguyễn An", reason: "x", at: "" } })),
  openOnTide: vi.fn(),
};
vi.mock("@/api/client", () => ({ api: apiMock, ApiError: class extends Error {} }));

const { default: ApproveView } = await import("./ApproveView.vue");
const { useSession } = await import("@/stores/session");

async function render(meOver = {}, reqOver = {}) {
  setActivePinia(createPinia());
  const session = useSession();
  session.me = makeMe(meOver);
  apiMock.request.mockResolvedValue({ request: makeRequest(reqOver), signingRule: "RULE" });
  apiMock.document.mockResolvedValue({ document: makeDoc(), requests: [] });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { template: "<div />" } }] });
  const wrapper = mount(ApproveView, { props: { requestId: "req_1" }, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

const button = (w: Awaited<ReturnType<typeof render>>, text: string) => w.findAll("button").find((b) => b.text().includes(text))!;

describe("Approve sheet", () => {
  beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

  it("shows the amount large, the rule, the sealed payee and who still needs to approve", async () => {
    const w = await render();
    expect(w.find(".amount-hero").text()).toBe("640.000.000 ₫");
    expect(w.text()).toContain("Over 500M");
    expect(w.text()).toContain("Công ty TNHH Minh Phát");
    expect(w.text()).toContain("waiting for Owner");
    expect(w.text()).toContain("2 of 3");
  });

  it("the owner approves in Tide, and as the last approver the network signature follows", async () => {
    const w = await render();
    await button(w, "Approve").trigger("click");
    await flushPromises();
    expect(calls).toEqual(["tide.approve", "api.approve", "tide.execute", "api.signature"]);
    expect(apiMock.approve).toHaveBeenCalledWith("req_1", makeRequest().contentHash, { request: "APPROVED", baseVersion: 2 });
  });

  it("the drafter cannot approve their own request: the button is disabled and the reason is shown", async () => {
    const w = await render({ id: "u-acct", tiers: ["drafter", "director"], displayName: "Trần Bình" });
    expect(button(w, "Approve").attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("you cannot approve it");
  });

  it("someone whose tier is not needed sees which tier is", async () => {
    const w = await render({ id: "u-viewer", tiers: ["viewer"] });
    expect(button(w, "Approve").attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("This request needs: Owner");
  });

  it("a person who already approved cannot approve again", async () => {
    const w = await render({ id: "u-dir", tiers: ["director"] });
    expect(button(w, "Approve").attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("You have approved this request.");
  });

  it("a request not yet open on Tide offers to open it, and Approve waits", async () => {
    const w = await render({}, { tideRequest: null });
    expect(w.text()).toContain("has not opened this request on the Tide network");
    expect(button(w, "Approve").attributes("disabled")).toBeDefined();
  });

  it("rejecting needs a reason", async () => {
    const w = await render();
    await button(w, "Reject").trigger("click");
    const submit = w.findAll("button").filter((b) => b.text() === "Reject").at(-1)!;
    expect(submit.attributes("disabled")).toBeDefined();
    await w.find("textarea").setValue("Unknown payee");
    await submit.trigger("submit");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(apiMock.reject).toHaveBeenCalledWith("req_1", "Unknown payee");
  });

  it("a dev-mode request is labelled as not network-signed", async () => {
    const w = await render({}, { mode: "unsigned-dev", tideRequest: null });
    expect(w.text()).toContain("NOT signed by the Tide network");
  });
});
