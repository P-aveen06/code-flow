// Cloudflare Pages forwards /api/* to the code-flow API on Render with this function,
// so the browser talks to one origin and the GitHub sign-in cookie is first-party.
// Pages `_redirects` cannot proxy to another domain, which is why this is code.

export interface ProxyEnv {
  RENDER_API_ORIGIN?: string;
}

export async function proxyToApi(
  request: Request, env: ProxyEnv, send: typeof fetch = fetch,
): Promise<Response> {
  const origin = env.RENDER_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin) {
    return Response.json({ detail: "RENDER_API_ORIGIN is not set for this Pages project." }, { status: 500 });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return send(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    // Pass the API's redirects (GitHub sign-in) and Set-Cookie headers to the browser untouched.
    redirect: "manual",
  });
}
