import { createContext, useContext } from "react";
import type { Api } from "./types.ts";

/**
 * The demo runs when the build asks for it (VITE_DEMO=1), or in local development
 * with no Supabase settings. A production build without them is an error, never a
 * silent demo: the demo takes any email and password. (vite.config.ts refuses to build
 * one; this is the second line.) Each backend is loaded on demand, so the real site
 * doesn't ship the sample data and the demo doesn't ship the Supabase client.
 */
export async function makeApi(): Promise<Api> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (import.meta.env.VITE_DEMO === "1" || (import.meta.env.DEV && (!url || !key))) {
    const { DemoApi } = await import("./demo-api.ts");
    return new DemoApi();
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
