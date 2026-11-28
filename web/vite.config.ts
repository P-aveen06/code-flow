import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  envDir: "..",
  server: {
    // With VITE_API_URL=/ the app calls /api on its own origin, as on Cloudflare Pages,
    // so the GitHub sign-in cookie is first-party. Vite forwards those calls to the API.
    proxy: { "/api": loadEnv(mode, "..", "").CODEFLOW_API_PROXY || "http://localhost:8787" },
  },
}));
