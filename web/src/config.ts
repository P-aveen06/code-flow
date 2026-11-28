export function readApiUrl(env: { readonly VITE_API_URL?: string }): string {
  return env.VITE_API_URL || "http://localhost:8787";
}

export const apiUrl = readApiUrl(import.meta.env);
