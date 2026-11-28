import { describe, expect, it, vi } from "vitest";
import { proxyToApi } from "./pagesProxy";

describe("Pages /api proxy", () => {
  it("forwards the path, query, method, body and cookies to the API without following redirects", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: "https://github.com/login", "set-cookie": "cf_oauth_state=x; Path=/api/auth" },
    }));
    const request = new Request("https://code-flow.pages.dev/api/repos?x=1", {
      method: "POST",
      headers: { cookie: "cf_session=abc", "x-requested-with": "code-flow", host: "code-flow.pages.dev" },
      body: JSON.stringify({ url: "https://github.com/o/r" }),
    });

    const response = await proxyToApi(request, { RENDER_API_ORIGIN: "https://api.onrender.test/" }, send);

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("cf_oauth_state=x");
    const [url, init] = send.mock.calls[0];
    expect(url).toBe("https://api.onrender.test/api/repos?x=1");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("cf_session=abc");
    expect(headers.get("x-forwarded-host")).toBe("code-flow.pages.dev");
    expect(headers.has("host")).toBe(false);
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"url":"https://github.com/o/r"}');
  });

  it("explains a missing API origin", async () => {
    const response = await proxyToApi(new Request("https://site.test/api/me"), {});
    expect(response.status).toBe(500);
    expect((await response.json()).detail).toContain("RENDER_API_ORIGIN");
  });
});
