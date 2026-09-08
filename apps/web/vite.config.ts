import path from "node:path";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
      target: "react",
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    proxy: {
      // A Run's derived video is served by the CLI, not by Vite. Without
      // this the player asks the dev server for `/runs/...`, gets the SPA's
      // index.html back, and reports an unplayable video.
      "/runs": { target: "http://127.0.0.1:7777" },
      "/ws": {
        target: "http://127.0.0.1:7777",
        ws: true,
      },
    },
    strictPort: true,
  },
});
