/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** "1" builds the demo: sample data, no backend. */
  readonly VITE_DEMO?: string;
  /** "memory" keeps routes out of the URL (for the embedded demo). */
  readonly VITE_ROUTER?: string;
  /** "true" once the site has a Google sign-in client. */
  readonly VITE_GOOGLE?: string;
  /** "true" once the site has its own email sender, whose email carries a code; otherwise Supabase's carries a link. */
  readonly VITE_EMAIL_CODES?: string;
  /** The site's address (the deploy's SITE_URL). A copy opened at another address sends the visitor there. */
  readonly VITE_SITE_URL?: string;
}
