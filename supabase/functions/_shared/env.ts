// Environment and Supabase clients for the Edge Functions (Deno).
import { createClient } from "npm:@supabase/supabase-js@2";

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/** Supabase's newer keys arrive as a JSON object keyed by name; the legacy ones as plain strings. */
function key(legacy: string, dict: string): string {
  const plain = Deno.env.get(legacy);
  if (plain) return plain;
  try {
    const all = JSON.parse(Deno.env.get(dict) ?? "{}") as Record<string, string>;
    const v = all.default ?? Object.values(all)[0];
    if (v) return v;
  } catch {
    /* fall through */
  }
  throw new Error(`missing environment variable ${legacy} or ${dict}`);
}

/** Origins allowed to call the functions from a browser, e.g. "https://sharpslate.github.io". */
export const siteOrigins = () => Deno.env.get("SITE_ORIGIN") ?? "*";

/** The service-role client: bypasses RLS. Never hand its results to a member unfiltered. */
export function serviceClient() {
  return createClient(env("SUPABASE_URL"), key("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client acting as the caller, so database functions see auth.uid(). */
export function userClient(req: Request) {
  return createClient(env("SUPABASE_URL"), key("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS"), {
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

/** Whether the user is a commissioner of the league. */
export async function isCommissioner(userId: string, leagueId: string): Promise<boolean> {
  const { data } = await serviceClient().rpc("is_commissioner_internal", { p_user: userId, p_league: leagueId });
  return data === true;
}

/** Whether the user is a site admin: runs the shared games, lines and pulls (not anyone's league). */
export async function isAdmin(userId: string): Promise<boolean> {
  const { data } = await serviceClient().from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  return data?.is_admin === true;
}
