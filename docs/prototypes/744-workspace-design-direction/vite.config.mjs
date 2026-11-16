// Serves the prototype with the Workspace's own React and pinned UI SDK, so it
// renders on the same parts the spike swapped in (#742).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const webApp = fileURLToPath(
  new URL("../../../apps/web/index.html", import.meta.url)
);
const shared = /^(react|react-dom|@ui-sdk\/(react|core))(\/|$)/;

export default {
  root,
  cacheDir: join(tmpdir(), "contingency-prototype-744"),
  plugins: [
    {
      name: "resolve-from-workspace",
      enforce: "pre",
      resolveId(source, _importer, options) {
        return shared.test(source)
          ? this.resolve(source, webApp, { ...options, skipSelf: true })
          : null;
      },
    },
  ],
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  server: {
    host: "127.0.0.1",
    port: 4744,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
};
