import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  sortImports: true,
  sortPackageJson: true,
  sortTailwindcss: true,
});
