import { createContext } from "react";

/**
 * Which Platform Runtime the Workspace shows, as the route names it. A native
 * platform carries its session id, or `new` before one is chosen.
 */
export type WorkspacePlatform =
  | { readonly _tag: "web" }
  | { readonly _tag: "android"; readonly session: string }
  | { readonly _tag: "ios"; readonly session: string };

export type WorkspacePlatformTag = WorkspacePlatform["_tag"];

export const NEW_NATIVE_SESSION = "new";

export const webPlatform: WorkspacePlatform = { _tag: "web" };

/**
 * The platform the route selects. iOS wins over Android when both are named,
 * as it did before the switcher existed.
 */
export const workspacePlatformFromSearch = (search: {
  readonly android?: string | undefined;
  readonly ios?: string | undefined;
}): WorkspacePlatform => {
  if (search.ios !== undefined) {
    return { _tag: "ios", session: search.ios || NEW_NATIVE_SESSION };
  }
  if (search.android !== undefined) {
    return { _tag: "android", session: search.android || NEW_NATIVE_SESSION };
  }
  return webPlatform;
};

/** Moves the Workspace to a platform; `replace` keeps the history entry. */
export type SelectWorkspacePlatform = (
  platform: WorkspacePlatform,
  options?: { readonly replace?: boolean }
) => void;

export interface WorkspacePlatformContextValue {
  readonly platform: WorkspacePlatform;
  /** Opens a platform from the switcher, at the session it last showed. */
  readonly onSwitch: (tag: WorkspacePlatformTag) => void;
}

export const WorkspacePlatformContext =
  createContext<WorkspacePlatformContextValue | null>(null);

/** The route search that names a platform, and nothing else. */
export interface WorkspacePlatformSearch {
  readonly android?: string;
  readonly ios?: string;
}

export const workspacePlatformSearch = (
  platform: WorkspacePlatform
): WorkspacePlatformSearch => {
  if (platform._tag === "android") {
    return { android: platform.session };
  }
  if (platform._tag === "ios") {
    return { ios: platform.session };
  }
  return {};
};
