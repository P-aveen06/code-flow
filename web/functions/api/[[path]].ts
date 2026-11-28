import { proxyToApi, type ProxyEnv } from "../../src/pagesProxy";

// Cloudflare Pages Function for every /api/* path. See src/pagesProxy.ts.
export function onRequest({ request, env }: { request: Request; env: ProxyEnv }) {
  return proxyToApi(request, env);
}
