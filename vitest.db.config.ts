import { defineConfig } from "vitest/config";

// Database tests: need a Postgres at DATABASE_URL (see scripts/local-postgres.sh).
export default defineConfig({
  test: {
    include: ["supabase/tests/**/*.test.ts"],
    globalSetup: ["supabase/tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
