/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** "1" builds the demo: sample data, no backend. */
  readonly VITE_DEMO?: string;
  /** "memory" keeps routes out of the URL (for the embedded demo). */
  readonly VITE_ROUTER?: string;
}
