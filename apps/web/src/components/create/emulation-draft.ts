import type {
  DraftEmulation,
  SessionEmulation,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

import type { EmulationPatch } from "@/components/browser/emulation-patch";
import { viewportForIdentity } from "@/components/create/browser-workspace-state";

export type { EmulationPatch } from "@/components/browser/emulation-patch";

/** What a browser with no declared identity renders at. */
const DEFAULT_VIEWPORT: Viewport = {
  deviceScaleFactor: 1,
  height: 720,
  width: 1280,
};

/**
 * The Emulation Create View has composed but no session has applied yet. It is
 * one value rather than a control per setting, so the first navigation can
 * send exactly what the author sees instead of reading each control back
 * separately as its own React state settles ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const initialEmulationDraft: DraftEmulation = {
  permissions: [],
  userAgentProfile: "default",
  viewport: DEFAULT_VIEWPORT,
};

export const emulationDraftAtom = Atom.make<DraftEmulation>(
  initialEmulationDraft
);

/**
 * What one patch field means, matching the wire contract: absent leaves the
 * value as it is, `null` clears it, and anything else replaces it.
 */
const patched = <T>(current: T | undefined, next: T | null | undefined) => {
  if (next === undefined) {
    return current;
  }
  return next === null ? undefined : next;
};

/** A decision list is replaced whole: `null` decides nothing at all. */
const patchedPermissions = (
  current: DraftEmulation["permissions"],
  next: EmulationPatch["permissions"]
): DraftEmulation["permissions"] => {
  if (next === undefined) {
    return current;
  }
  return next === null ? [] : next;
};

/** Rebuild the draft without the keys a cleared setting must not carry. */
const exactDraft = (draft: DraftEmulation): DraftEmulation => {
  let result: DraftEmulation = {
    permissions: draft.permissions,
    userAgentProfile: draft.userAgentProfile,
    viewport: draft.viewport,
  };
  if (draft.colorScheme !== undefined) {
    result = { ...result, colorScheme: draft.colorScheme };
  }
  if (draft.geolocation !== undefined) {
    result = { ...result, geolocation: draft.geolocation };
  }
  if (draft.locale !== undefined) {
    result = { ...result, locale: draft.locale };
  }
  if (draft.timezoneId !== undefined) {
    result = { ...result, timezoneId: draft.timezoneId };
  }
  return result;
};

/**
 * Choosing an identity moves every signal it implies together: a mobile
 * identity brings its own viewport and device scale factor, so the draft can
 * never hold a phone user agent over a desktop viewport (ADR 0013). A later
 * explicit viewport edit overwrites them.
 */
export const draftWithIdentity = (
  draft: DraftEmulation,
  userAgentProfile: UserAgentProfileId
): DraftEmulation => ({
  ...draft,
  userAgentProfile,
  viewport: viewportForIdentity(userAgentProfile, draft.viewport),
});

/** An explicit viewport edit, which outranks whatever the identity applied. */
export const draftWithViewport = (
  draft: DraftEmulation,
  viewport: Viewport
): DraftEmulation => ({ ...draft, viewport });

export const draftWithPatch = (
  draft: DraftEmulation,
  patch: EmulationPatch
): DraftEmulation =>
  exactDraft({
    ...draft,
    colorScheme: patched(draft.colorScheme, patch.colorScheme),
    geolocation: patched(draft.geolocation, patch.geolocation),
    locale: patched(draft.locale, patch.locale),
    permissions: patchedPermissions(draft.permissions, patch.permissions),
    timezoneId: patched(draft.timezoneId, patch.timezoneId),
  });

/**
 * The draft as the picker reads an applied Emulation, so the controls show one
 * answer whether a session is open or not: before a session exists the draft
 * *is* what the next navigation will apply.
 */
export const draftSessionEmulation = ({
  // The profile id is Create View's own handle on the identity, where a
  // session reports the concrete identity it resolved to, so it is dropped
  // rather than translated here.
  userAgentProfile: _profile,
  ...emulation
}: DraftEmulation): SessionEmulation => emulation;

/**
 * Adopt what a session already emulates into the draft. Selecting a session
 * that a previous visit configured must not leave the draft claiming settings
 * the session does not have — the next navigation applies the draft. Identity
 * and viewport stay with the draft: those controls own them, and the session
 * has already been told about every change to them.
 */
export const draftFromSessionEmulation = (
  draft: DraftEmulation,
  emulation: SessionEmulation
): DraftEmulation =>
  exactDraft({
    ...draft,
    colorScheme: emulation.colorScheme,
    geolocation: emulation.geolocation,
    locale: emulation.locale,
    permissions: emulation.permissions,
    timezoneId: emulation.timezoneId,
  });
