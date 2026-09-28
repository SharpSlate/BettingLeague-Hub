import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["supabase/functions/_shared/**/*.test.ts", "supabase/functions/**/*.test.ts", "web/src/**/*.test.ts"],
  },
});
