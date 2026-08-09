import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeUiInterface } from "../../src/services/ui-interface";

it.effect("opens the requested web URL", () => {
  let openedUrl: string | undefined;
  const uiInterface = makeUiInterface((url) => {
    openedUrl = url;
    return Promise.resolve();
  });

  return Effect.gen(function* openWebUrl() {
    yield* uiInterface.open("http://localhost:5173");

    expect(openedUrl).toBe("http://localhost:5173");
  });
});

it.effect("maps browser launch failures to UiInterfaceOpenError", () => {
  const cause = new Error("browser unavailable");
  const uiInterface = makeUiInterface(() => Promise.reject(cause));

  return Effect.gen(function* handleOpenFailure() {
    const error = yield* Effect.flip(uiInterface.open("http://localhost:5173"));

    expect(error._tag).toBe("UiInterfaceOpenError");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("http://localhost:5173");
  });
});
