import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { config, makeKey, makeMe, makeRequest } from "@/test/fixtures";

const calls: string[] = [];
const tideMock = {
  approveRequest: vi.fn(async () => { calls.push("tide.approve"); return "MINE"; }),
  mergeApprovals: vi.fn(() => new Uint8Array([1])),
  commitRelease: vi.fn(async () => { calls.push("tide.commitRelease"); return "sk_live_SECRET"; }),
  commitSeal: vi.fn(async () => "CIPHERTEXT"),
  draftSeal: vi.fn(), draftRelease: vi.fn(), onPopupBlocked: vi.fn(), initTide: vi.fn(), login: vi.fn(), logout: vi.fn(), secureFetch: vi.fn(),
};
vi.mock("@/tide/tide", () => tideMock);

const apiMock = {
  request: vi.fn(),
  approve: vi.fn(async () => { calls.push("api.approve"); return makeRequest({ status: "ready", approvals: [...makeRequest().approvals, { memberId: "u-owner", name: "Nguyễn Văn An", at: "", dokenVerified: true }] }); }),
  finishKit: vi.fn(async () => { calls.push("api.kit"); return { policy: "P", approvals: [] }; }),
  finish: vi.fn(async () => { calls.push("api.finish"); return { request: makeRequest({ status: "completed", closedReason: "Unlocked for Trần Bình" }), key: makeKey({ releaseCount: 1 }) }; }),
  reject: vi.fn(async () => makeRequest({ status: "rejected", rejection: { memberId: "u-owner", name: "Nguyễn Văn An", reason: "No ticket", at: "" } })),
  cancel: vi.fn(async () => makeRequest({ status: "cancelled" })),
};
vi.mock("@/api/client", () => ({ api: apiMock, ApiError: class extends Error {} }));

const { default: RequestView } = await import("./RequestView.vue");
const { useSession } = await import("@/stores/session");

const ACCOUNTANT = { id: "u-acct", displayName: "Trần Bình", tiers: ["viewer", "drafter"] as const };

async function render(meOver: object = {}, reqOver: object = {}) {
  setActivePinia(createPinia());
  const session = useSession();
  session.me = makeMe(meOver as never);
  session.config = config;
  apiMock.request.mockResolvedValue({ request: makeRequest(reqOver), key: makeKey() });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { template: "<div />" } }] });
  const wrapper = mount(RequestView, { props: { id: "req_1" }, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

const button = (w: Awaited<ReturnType<typeof render>>, text: string) => w.findAll("button").find((b) => b.text().includes(text));

describe("Request screen", () => {
  beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

  it("shows the key, its level, who asked and why, and who has approved", async () => {
    const w = await render();
    expect(w.text()).toContain("Unlock: AWS root");
    expect(w.text()).toContain("Level 4 · Critical · 3 people");
    expect(w.text()).toContain("Close the old billing account");
    expect(w.text()).toContain("Lê Cường");
    expect(w.text()).toContain("waiting for another board member");
    expect(w.text()).toContain("1 of 3");
  });

  it("another board member approves in Tide first, then the server records it", async () => {
    const w = await render();
    await button(w, "Approve")!.trigger("click");
    await flushPromises();
    expect(calls).toEqual(["tide.approve", "api.approve"]);
    expect(apiMock.approve).toHaveBeenCalledWith("req_1", "MINE");
    expect(w.text()).toContain("Trần Bình can finish now");
  });

  it("the requester cannot approve their own request: they wait, and can cancel", async () => {
    const w = await render(ACCOUNTANT);
    expect(button(w, "Approve")).toBeUndefined();
    expect(w.text()).toContain("Waiting for 1 more approval");
    await button(w, "Cancel this request")!.trigger("click");
    await flushPromises();
    expect(apiMock.cancel).toHaveBeenCalledWith("req_1");
  });

  it("once approved, only the requester can finish; the secret appears, then hides", async () => {
    const other = await render({}, { status: "ready", approvals: [...makeRequest().approvals, { memberId: "u-owner", name: "Nguyễn Văn An", at: "", dokenVerified: true }] });
    expect(button(other, "unlock it")).toBeUndefined();

    const w = await render(ACCOUNTANT, { status: "ready" });
    await button(w, "Approve in Tide and unlock it")!.trigger("click");
    await flushPromises();
    expect(calls).toEqual(["tide.approve", "api.kit", "tide.commitRelease", "api.finish"]);
    expect(w.text()).toContain("Unlocked for you");
    expect(w.find("[data-testid=secret]").text()).not.toContain("sk_live_SECRET");
    await button(w, "Show")!.trigger("click");
    expect(w.find("[data-testid=secret]").text()).toBe("sk_live_SECRET");
    await button(w, "Hide now")!.trigger("click");
    expect(w.text()).not.toContain("sk_live_SECRET");
    expect(w.text()).toContain("Each unlock needs a new request");
  });

  it("a member who already approved cannot approve again", async () => {
    const w = await render({ id: "u-dir", displayName: "Lê Cường" });
    expect(button(w, "Approve")).toBeUndefined();
    expect(w.text()).toContain("You approved this request.");
  });

  it("rejecting needs a reason", async () => {
    const w = await render();
    await button(w, "Reject")!.trigger("click");
    const submit = w.findAll("button").filter((b) => b.text() === "Reject").at(-1)!;
    expect(submit.attributes("disabled")).toBeDefined();
    await w.find("textarea").setValue("No ticket");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(apiMock.reject).toHaveBeenCalledWith("req_1", "No ticket");
    expect(w.text()).toContain('rejected: "No ticket"');
  });

  it("a finished seal says the key is in the vault", async () => {
    const w = await render({}, { operation: "seal", status: "completed", approvals: [] });
    expect(w.text()).toContain("Seal into the vault: AWS root");
    expect(w.text()).toContain("Sealed. The key is in the vault");
  });
});
