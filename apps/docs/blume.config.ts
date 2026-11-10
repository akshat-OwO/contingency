import { defineConfig } from "blume";

/** The Workspace's Geist, self-hosted from the same package. */
const geist = {
  name: "Geist",
  variants: [
    {
      src: "./node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
      weight: "100..900",
    },
  ],
};

/**
 * The human-readable `/docs` site, built from the CLI's packaged Markdown
 * (`scripts/stage.ts`) and served by every Contingency web server. Theme
 * tokens follow the Workspace's shadcn values in `apps/web/src/styles.css`.
 */
export default defineConfig({
  ai: { openInChat: false },
  content: { root: "content" },
  deployment: { base: "/docs" },
  description:
    "Contingency teaches, runs, and verifies browser and device journeys for coding agents.",
  // A local site has no analytics to receive the rating.
  feedback: false,
  navigation: { repo: false },
  theme: {
    accent: { dark: "oklch(0.922 0 0)", light: "oklch(0.205 0 0)" },
    fonts: { body: geist, display: geist },
    mode: "system",
    radius: "md",
  },
  title: "Contingency",
});
