// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- This module is the boundary where span attributes and exits, unknown by Effect's Tracer contract, pass the Diagnostic Log's allowlist.
import { Cause, Exit, Predicate, Tracer } from "effect";

import { renderCause, renderField } from "./diagnostic-log.ts";

/**
 * Spans that hold only what the Diagnostic Log may
 * ([ADR 0089](../../../../docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md)).
 * Spans can leave the machine over OTLP, so the tracer every span comes from
 * applies the same allowlist the logger does.
 */

/** A failure by its shape, as the Diagnostic Log renders it. */
const shareSafeDefect = (reason: Cause.Reason<unknown>, home: string) => {
  const lines = renderCause(Cause.fromReasons([reason]), home);
  const error = new Error(lines[0] ?? "failure");
  error.name = "Failure";
  error.stack = lines.join("\n");
  return error;
};

/** An exit whose failures keep their shape and lose their messages. */
const shareSafeExit = (
  exit: Exit.Exit<unknown, unknown>,
  home: string
): Exit.Exit<unknown, unknown> =>
  Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
    ? exit
    : Exit.failCause(
        Cause.fromReasons(
          exit.cause.reasons.map((reason) =>
            Cause.isInterruptReason(reason)
              ? reason
              : Cause.makeDieReason(shareSafeDefect(reason, home))
          )
        )
      );

/** One attribute through the allowlist, keeping a safe number a number. */
const shareSafeAttribute = (key: string, value: unknown, home: string) => {
  const [, rendered] = renderField(key, value, home);
  return (Predicate.isNumber(value) || Predicate.isBoolean(value)) &&
    rendered === String(value)
    ? value
    : rendered;
};

const shareSafeAttributes = (
  attributes: Record<string, unknown>,
  home: string
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      shareSafeAttribute(key, value, home),
    ])
  );

/**
 * A span that holds only what the Diagnostic Log may: every attribute and
 * event passes the allowlist, and a failure ends the span by its shape. An
 * exporter reads the span it wraps, so nothing else reaches a collector.
 */
export class ShareSafeSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly #inner: Tracer.Span;
  readonly #home: string;

  constructor(inner: Tracer.Span, home: string) {
    this.#inner = inner;
    this.#home = home;
  }

  get name() {
    return this.#inner.name;
  }
  get spanId() {
    return this.#inner.spanId;
  }
  get traceId() {
    return this.#inner.traceId;
  }
  get parent() {
    return this.#inner.parent;
  }
  get annotations() {
    return this.#inner.annotations;
  }
  get status() {
    return this.#inner.status;
  }
  get attributes() {
    return this.#inner.attributes;
  }
  get links() {
    return this.#inner.links;
  }
  get sampled() {
    return this.#inner.sampled;
  }
  get kind() {
    return this.#inner.kind;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.#inner.end(endTime, shareSafeExit(exit, this.#home));
  }

  attribute(key: string, value: unknown): void {
    this.#inner.attribute(key, shareSafeAttribute(key, value, this.#home));
  }

  event(
    name: string,
    startTime: bigint,
    attributes?: Record<string, unknown>
  ): void {
    this.#inner.event(
      name,
      startTime,
      attributes === undefined
        ? undefined
        : shareSafeAttributes(attributes, this.#home)
    );
  }

  /** An event whose fields already passed the allowlist, from a log record. */
  safeEvent(
    name: string,
    startTime: bigint,
    fields: Record<string, string>
  ): void {
    this.#inner.event(name, startTime, fields);
  }

  addLinks(links: readonly Tracer.SpanLink[]): void {
    this.#inner.addLinks(links);
  }
}

/** Wraps a tracer so each of its spans is a `ShareSafeSpan`. */
export const makeShareSafeTracer = (
  inner: Tracer.Tracer,
  home: string
): Tracer.Tracer =>
  Tracer.make({
    context: inner.context,
    span: (options) => new ShareSafeSpan(inner.span(options), home),
  });
