import { createContext, useContext } from "react";
import { DemoApi } from "./demo-api.ts";
import { SupabaseApi } from "./supabase-api.ts";
import type { Api } from "./types.ts";

/** The demo runs when asked for, or when the build has no Supabase settings. */
export function makeApi(): Api {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (import.meta.env.VITE_DEMO === "1" || !url || !key) return new DemoApi();
  return new SupabaseApi(url, key);
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}
