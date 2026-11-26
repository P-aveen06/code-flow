import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCode, fetchCommits, fetchDiff, fetchRepos } from "./api";

vi.mock("./config", () => ({ apiUrl: "https://flow.test/gateway/" }));

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("API client", () => {
  it("builds repo and commit URLs and returns JSON", async () => {
    const repos = [{ name: "shop demo", branch: "main", commit_count: 1 }];
    const history = { repo: "shop demo", branch: "main", commits: [] };
    mockFetch.mockResolvedValueOnce(Response.json(repos)).mockResolvedValueOnce(Response.json(history));

    await expect(fetchRepos()).resolves.toEqual(repos);
    await expect(fetchCommits("shop demo")).resolves.toEqual(history);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://flow.test/gateway/api/repos",
      "https://flow.test/gateway/api/repos/shop%20demo/commits",
    ]);
  });

  it("omits unset diff parameters and sends explicit zero hops and an empty base", async () => {
    mockFetch.mockImplementation(async () => Response.json({}));
    await fetchDiff("shop", "abc");
    await fetchDiff("shop", "abc", { base: "", hops: 0 });

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://flow.test/gateway/api/repos/shop/diff?head=abc",
      "https://flow.test/gateway/api/repos/shop/diff?head=abc&base=&hops=0",
    ]);
  });

  it("encodes code paths and includes line bounds only when provided", async () => {
    mockFetch.mockImplementation(async () => Response.json({}));
    await fetchCode("shop", "abc", "shop/checkout & cart.py", 1, 19);
    await fetchCode("shop", "abc", "shop/cart.py");

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://flow.test/gateway/api/repos/shop/code?sha=abc&file=shop%2Fcheckout+%26+cart.py&start=1&end=19",
      "https://flow.test/gateway/api/repos/shop/code?sha=abc&file=shop%2Fcart.py",
    ]);
  });

  it("reports HTTP errors with the API detail when available", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ detail: "Unknown repo" }, { status: 404 }));
    mockFetch.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }));

    await expect(fetchCommits("missing")).rejects.toThrow("HTTP 404: Unknown repo");
    await expect(fetchRepos()).rejects.toThrow("HTTP 502");
  });

  it("reports an unreachable server and an invalid JSON response", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mockFetch.mockResolvedValueOnce(new Response("<html>"));

    await expect(fetchRepos()).rejects.toThrow("Cannot reach the code-flow server at https://flow.test/gateway/");
    await expect(fetchRepos()).rejects.toThrow("returned invalid JSON");
  });
});
