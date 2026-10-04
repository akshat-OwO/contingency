import path from "node:path";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * A throwaway harness for the dock prototypes. It shares the app's `@` alias,
 * styles, and React compiler preset, so every prototype renders with the same
 * `ui/` primitives and tokens the Workspace ships, without adding a route to
 * the production app.
 */
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../../src"),
    },
  },
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
});
