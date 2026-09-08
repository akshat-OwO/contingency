import { Context, Data, Effect, Layer } from "effect";
import open from "open";

export class UiInterfaceOpenError extends Data.TaggedError(
  "UiInterfaceOpenError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface UiInterfaceService {
  readonly open: (url: string) => Effect.Effect<void, UiInterfaceOpenError>;
}

export const UiInterface = Context.Service<UiInterfaceService>(
  "@contingency/UiInterface"
);

export const makeUiInterface = <OpenResult>(
  openUrl: (url: string) => Promise<OpenResult>
): UiInterfaceService => ({
  open: Effect.fn("UiInterface.open")((url: string) =>
    Effect.tryPromise({
      catch: (cause) =>
        new UiInterfaceOpenError({
          cause,
          message: `Unable to open ${url}`,
        }),
      try: () => openUrl(url),
    }).pipe(Effect.asVoid)
  ),
});

export const UiInterfaceLive = Layer.succeed(
  UiInterface,
  makeUiInterface(open)
);
