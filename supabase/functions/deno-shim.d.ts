// Lets the Node TypeScript check (npm run typecheck) understand the Edge Functions,
// which run on Deno. Supabase's runtime provides the real Deno APIs and npm: imports.
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  const env: { get(name: string): string | undefined };
}
declare module "npm:@supabase/supabase-js@2" {
  export * from "@supabase/supabase-js";
}
declare module "npm:nodemailer@6.9.16" {
  interface Transport {
    sendMail(message: { from: string; to: string; bcc: string[]; replyTo?: string; subject: string; text: string }): Promise<unknown>;
  }
  const nodemailer: { createTransport(options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }): Transport };
  export default nodemailer;
}
