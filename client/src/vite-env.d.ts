/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the FinTrack API, e.g. http://localhost:4000 (see client/.env.example). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
