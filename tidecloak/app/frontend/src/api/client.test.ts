import { describe, expect, it, vi } from "vitest";

vi.mock("@/tide/tide", () => ({ secureFetch: vi.fn() }));
const { api, ApiError, setFetcher } = await import("./client");

describe("API client", () => {
  it("sends JSON to /api with the hash in the approve PATH, so the DPoP proof covers it", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "req_1" }), { status: 200 }));
    setFetcher(fetcher);
    await api.approve("req_1", "abc123", { request: "R", baseVersion: 3 });
    expect(fetcher).toHaveBeenCalledWith("/api/signing-requests/req_1/approve/abc123", expect.objectContaining({ method: "POST", body: JSON.stringify({ request: "R", baseVersion: 3 }) }));
  });

  it("turns the server's error envelope into an ApiError with a stable code", async () => {
    setFetcher(async () => new Response(JSON.stringify({ error: { code: "INITIATOR_CANNOT_APPROVE", message: "The person who submitted a document cannot approve it" } }), { status: 403 }));
    const err = await api.approve("req_1", "abc", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "INITIATOR_CANNOT_APPROVE" });
  });

  it("explains a network failure instead of throwing a raw TypeError", async () => {
    setFetcher(async () => { throw new TypeError("Failed to fetch"); });
    await expect(api.me()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("copes with a non-JSON error body", async () => {
    setFetcher(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(api.me()).rejects.toMatchObject({ status: 502, code: "HTTP_502" });
  });
});
