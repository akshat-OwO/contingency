import { existsSync } from "node:fs";

import { Console, Data, Effect } from "effect";
// The npm-install machinery Playwright itself runs on `npm install`, exported
// on the package's own surface; see ./types/playwright-core-corebundle.d.ts.
import { registry as playwrightRegistry } from "playwright-core/lib/coreBundle";

const { installBrowsersForNpmInstall } = playwrightRegistry;

/**
 * Why a first-use download failed. The message names the way past it, because
 * an author whose download could not start still needs a browser.
 */
export class ChromiumInstallError extends Data.TaggedError(
  "ChromiumInstallError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * The browsers a Run or a Create session needs. A headless launch with no
 * channel resolves to the headless shell build, and the full build backs every
 * other mode, so both are named rather than discovered missing later.
 */
const BROWSERS = ["chromium", "chromium-headless-shell"] as const;

/** The one-line hint that finishes every install failure. */
const MANUAL_INSTALL =
  "Run `npx playwright-core install chromium` to install it yourself.";

/**
 * A browser is there when Playwright finished installing it: the installer
 * writes its completion marker into the browser's directory only once the
 * download and unpack have both landed.
 */
const isInstalled = (name: string): boolean => {
  // Called off its registry rather than destructured: it reads `_executables`
  // through `this`.
  const executable = playwrightRegistry.registry.findExecutable(name);
  return existsSync(
    playwrightRegistry.browserDirectoryToMarkerFilePath(executable.directory)
  );
};

/**
 * Install Contingency's pinned Chromium when it is not on this machine yet.
 *
 * The CLI drives Chromium through `playwright-core` as a library, and a
 * library downloads no browsers of its own. Rather than asking every user to
 * run an install command first, the first launch — a Run or a Create session
 * — pays the download once, with progress printed by Playwright's own
 * installer. An existing installation costs a filesystem check per browser.
 */
export const ensureChromiumInstalled: Effect.Effect<
  void,
  ChromiumInstallError
> = Effect.suspend(() => {
  if (BROWSERS.every(isInstalled)) {
    return Effect.void;
  }
  return Console.error(
    "Contingency needs its Chromium build, which is not installed yet. Downloading it now; this happens once."
  ).pipe(
    Effect.andThen(
      Effect.tryPromise({
        catch: (cause) =>
          new ChromiumInstallError({
            cause,
            message: `The Chromium download failed. ${MANUAL_INSTALL}`,
          }),
        try: () => installBrowsersForNpmInstall([...BROWSERS]),
      })
    ),
    Effect.andThen(Effect.void)
  );
});
