import { TeachingBrowserAttachment } from "@contingency/protocol";
import type {
  BrowserCheck,
  BrowserNetworkRequest,
} from "@contingency/protocol";
import { Option, Predicate, Schema } from "effect";
import type { DragEvent } from "react";

export const attachmentMime = "application/x-contingency-browser-attachment";
export const requestAttachment = (
  request: BrowserNetworkRequest,
  intent:
    | { readonly purpose: "context" }
    | {
        readonly purpose: "requirement";
        readonly path: readonly (string | number)[];
        readonly expected: Schema.Json;
      }
): TeachingBrowserAttachment => {
  const path = intent.purpose === "requirement" ? intent.path : [];
  const url = new URL(request.url);
  const id = globalThis.crypto.randomUUID();
  const array = path.findLastIndex((segment) => Predicate.isNumber(segment));
  const expectedValue = Schema.decodeUnknownOption(
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
  )(intent.purpose === "requirement" ? intent.expected : undefined).pipe(
    Option.getOrUndefined
  );
  const check: BrowserCheck = {
    demonstrated: intent.purpose === "requirement",
    expectation: {
      itemPath:
        array === -1
          ? []
          : path
              .slice(0, array + 1)
              .map((segment) => (Predicate.isNumber(segment) ? "*" : segment)),
      predicates: [
        expectedValue === undefined
          ? {
              id: globalThis.crypto.randomUUID(),
              operator: "exists",
              path: array === -1 ? path : path.slice(array + 1),
            }
          : {
              expected: expectedValue,
              id: globalThis.crypto.randomUUID(),
              operator: "equals",
              path: array === -1 ? path : path.slice(array + 1),
            },
      ],
    },
    id,
    kind: "response",
    request: {
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      query: {},
    },
    response: "matching",
    timeoutMs: 10_000,
    when: "After the triggering action",
  };
  const attachment: TeachingBrowserAttachment = {
    candidate: check,
    id,
    label: `${request.method} ${url.pathname}${path.length === 0 ? "" : ` · ${path.join(".")}`}`,
  };
  return intent.purpose === "requirement"
    ? { ...attachment, requirement: check }
    : attachment;
};
export const storageAttachment = (
  origin: string,
  name: string,
  kind: "cookie" | "local" | "session",
  cookiePath?: string
): TeachingBrowserAttachment => {
  const id = globalThis.crypto.randomUUID();
  const check: BrowserCheck = {
    change: "created",
    cookiePath,
    demonstrated: false,
    expectation: {
      itemPath: [],
      predicates: [
        { id: globalThis.crypto.randomUUID(), operator: "exists", path: [] },
      ],
    },
    id,
    kind,
    name,
    origin,
    timeoutMs: 10_000,
    when: "After the triggering action",
  };
  const candidate: BrowserCheck =
    kind === "cookie" ? check : { ...check, format: "raw" };
  return { candidate, id, label: `${kind} · ${name}` };
};
export const dragAttachment = (
  event: DragEvent,
  attachment: TeachingBrowserAttachment
) => {
  event.dataTransfer.setData(attachmentMime, JSON.stringify(attachment));
  event.dataTransfer.effectAllowed = "copy";
};
export const readAttachment = (
  event: DragEvent
): TeachingBrowserAttachment | undefined => {
  try {
    return Schema.decodeUnknownSync(TeachingBrowserAttachment)(
      JSON.parse(event.dataTransfer.getData(attachmentMime))
    );
  } catch {
    return undefined;
  }
};
