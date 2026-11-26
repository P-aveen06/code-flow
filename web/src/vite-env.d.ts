/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_FLAGSMITH_API_URL?: string;
  readonly VITE_CODEFLOW_FLAGSMITH_ENV_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
