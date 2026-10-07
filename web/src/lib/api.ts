import { createContext, useContext } from "react";
import type { Api } from "./types.ts";

/**
 * The example league anyone can look around before starting one, published in the
 * site's demo/ folder (VITE_DEMO=public). It's the demo, opened straight into its league
 * as the commissioner, with links back to the real site.
 */
export const PUBLIC_DEMO = import.meta.env.VITE_DEMO === "public";

/** From the example league, the real site's front page: the folder above demo/. */
export const REAL_SITE = "../";

/**
 * The demo runs when the build asks for it (VITE_DEMO=1, or "public"), or in local
 * development with no Supabase settings. A production build without them is an error,
 * never a silent demo: the demo takes any email and password. (vite.config.ts refuses to
 * build one; this is the second line.) Each backend is loaded on demand, so the real site
 * doesn't ship the sample data and the demo doesn't ship the Supabase client.
 */
export async function makeApi(): Promise<Api> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (import.meta.env.VITE_DEMO === "1" || PUBLIC_DEMO || (import.meta.env.DEV && (!url || !key))) {
    const { DemoApi } = await import("./demo-api.ts");
    return new DemoApi({ visitor: PUBLIC_DEMO });
  }
  if (!url || !key) throw new Error("This copy of the site was built without its backend settings.");
  const { SupabaseApi } = await import("./supabase-api.ts");
  return new SupabaseApi(url, key);
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}
