import { createHash } from "node:crypto";
import path from "node:path";

import { Effect, FileSystem } from "effect";

// Reviewed Lighthouse 13.5.0 registry. Recheck its imports, aliases and
// lookupLocale fallback before accepting a new registry, even on a patch bump.
const lighthouseRegistryHash =
  "e65c850b9033461a1f014ffb71377f28b3277c6273cc8af6a9592f3a5de3c589";

export const vendorEnglishLocales = Effect.fn("vendorEnglishLocales")(
  function* englishLocales(
    name: string,
    version: string | undefined,
    target: string
  ) {
    if (name !== "lighthouse" && name !== "@paulirish/trace_engine") {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const localization =
      name === "lighthouse" ? path.join(target, "shared/localization") : target;
    if (name === "lighthouse") {
      const registryPath = path.join(localization, "locales.js");
      const registry = yield* fs.readFileString(registryPath);
      if (
        createHash("sha256").update(registry).digest("hex") !==
        lighthouseRegistryHash
      ) {
        return yield* Effect.fail(
          new Error(
            "Lighthouse locales.js changed; review English locale packaging before updating its registry hash."
          )
        );
      }
      // en is an alias for en-US. en-XL is a test pseudolocale, not a fallback.
      // Lighthouse's lookupLocale falls back to en-US for unsupported requests.
      yield* fs.writeFileString(
        registryPath,
        `${registry.slice(0, registry.indexOf("import ar from"))}import enUS from './locales/en-US.json' with { type: 'json' };\nconst locales = {'en-US': enUS, en: enUS};\nexport {locales};\n`
      );
    } else if (version !== "0.0.65") {
      // This release has no locale loader: insight UIStrings are inline and
      // Lighthouse localizes them through its own message registry. Review a
      // new version before assuming its JSON is still unused at runtime.
      return yield* Effect.fail(
        new Error(
          "trace_engine changed; review its locale loading before trimming locale JSON."
        )
      );
    }
    const directory = path.join(localization, "locales");
    // Assert the English asset exists before removing any other locale data.
    yield* fs.readFileString(path.join(directory, "en-US.json"));
    for (const file of yield* fs.readDirectory(directory)) {
      if (file.endsWith(".json") && file !== "en-US.json") {
        yield* fs.remove(path.join(directory, file));
      }
    }
  }
);
