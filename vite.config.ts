import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths, so the built app works from any folder or static host.
  base: "./",
  server: { port: 5173, strictPort: false },
  build: { outDir: "dist", target: "es2022" },
  test: { include: ["tests/**/*.test.ts"] },
});
