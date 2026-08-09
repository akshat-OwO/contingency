import { Context, Data, Effect, Layer } from "effect";
import open from "open";

export class UiInterfaceOpenError extends Data.TaggedError(
  "UiInterfaceOpenError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface UiInterfaceShape {
  readonly open: (url: string) => Effect.Effect<void, UiInterfaceOpenError>;
}

export const UiInterface = Context.Service<UiInterfaceShape>(
  "@contingency/UiInterface"
);

export const makeUiInterface = (
  openUrl: (url: string) => Promise<unknown> = open
): UiInterfaceShape => {
  const openInterface = Effect.fn("UiInterface.open")((url: string) =>
    Effect.tryPromise({
      catch: (cause) =>
        new UiInterfaceOpenError({
          cause,
          message: `Unable to open ${url}`,
        }),
      try: () => openUrl(url),
    }).pipe(Effect.asVoid)
  );

  return UiInterface.of({ open: openInterface });
};

export const UiInterfaceLive = Layer.succeed(UiInterface, makeUiInterface());
