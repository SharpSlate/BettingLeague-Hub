import { createContext, useContext } from "react";
import type { Api } from "./types.ts";

/**
 * The demo runs when asked for, or when the build has no Supabase settings.
 * Each backend is loaded on demand, so the real site doesn't ship the sample data
 * and the demo doesn't ship the Supabase client.
 */
export async function makeApi(): Promise<Api> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (import.meta.env.VITE_DEMO === "1" || !url || !key) {
    const { DemoApi } = await import("./demo-api.ts");
    return new DemoApi();
  }
  const { SupabaseApi } = await import("./supabase-api.ts");
  return new SupabaseApi(url, key);
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}
