// Environment and Supabase clients for the Edge Functions (Deno).
import { createClient } from "npm:@supabase/supabase-js@2";

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/** Origins allowed to call the functions from a browser, e.g. "https://bappel2.github.io". */
export const siteOrigins = () => Deno.env.get("SITE_ORIGIN") ?? "*";

/** The service-role client: bypasses RLS. Never hand its results to a member unfiltered. */
export function serviceClient() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client acting as the caller, so database functions see auth.uid(). */
export function userClient(req: Request) {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The signed-in caller, or null. */
export async function currentUser(req: Request): Promise<{ id: string } | null> {
  if (!req.headers.get("Authorization")) return null;
  const { data, error } = await userClient(req).auth.getUser();
  return error || !data.user ? null : { id: data.user.id };
}

export async function isAdmin(userId: string): Promise<boolean> {
  const { data } = await serviceClient().from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  return data?.is_admin === true;
}
