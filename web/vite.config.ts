import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site builds to web/dist as static files for GitHub Pages. Asset paths are
// relative so the same build works under /BettingLeague/ or any other folder.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@rules": fileURLToPath(new URL("../supabase/functions/_shared/rules/index.ts", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
});
