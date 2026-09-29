import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// The site builds to web/dist as static files for GitHub Pages. Asset paths are
// relative so the same build works under /BettingLeague/ or any other folder.
// A build is either the demo (VITE_DEMO=1) or the real site with its Supabase
// settings; a real build missing them fails here rather than shipping the demo.
export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, root, "VITE_"), ...process.env };
  if (command === "build" && env.VITE_DEMO !== "1" && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)) {
    throw new Error("Building the site needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. For the demo, set VITE_DEMO=1.");
  }
  return {
    root,
    base: "./",
    plugins: [react()],
    resolve: {
      alias: { "@rules": fileURLToPath(new URL("../supabase/functions/_shared/rules/index.ts", import.meta.url)) },
    },
    build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
    server: { port: 5173, host: "127.0.0.1" },
    preview: { port: 4173, host: "127.0.0.1" },
  };
});
