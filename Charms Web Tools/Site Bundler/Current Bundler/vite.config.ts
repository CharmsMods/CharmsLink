import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022"
  },
  test: {
    environment: "jsdom",
    include: ["src/test/**/*.test.ts"]
  }
});
