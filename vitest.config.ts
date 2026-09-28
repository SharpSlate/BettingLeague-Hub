import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The site imports the shared rules as "@rules" (see web/vite.config.ts).
  resolve: {
    alias: { "@rules": fileURLToPath(new URL("./supabase/functions/_shared/rules/index.ts", import.meta.url)) },
  },
  test: {
    include: ["supabase/functions/_shared/**/*.test.ts", "supabase/functions/**/*.test.ts", "web/src/**/*.test.ts"],
  },
});
