// Lets the Node TypeScript check (npm run typecheck) understand the Edge Functions,
// which run on Deno. Supabase's runtime provides the real Deno APIs and npm: imports.
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  const env: { get(name: string): string | undefined };
}
declare module "npm:@supabase/supabase-js@2" {
  export * from "@supabase/supabase-js";
}
