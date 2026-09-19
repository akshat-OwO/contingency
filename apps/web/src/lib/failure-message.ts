import { BrowserRpcError } from "@contingency/protocol";
import { Option, Schema } from "effect";

/**
 * The shapes a rejected RPC promise can arrive in that carry a sentence: an
 * `Error`, a decoded `BrowserRpcError`, or a bare string.
 *
 * These are parsed rather than trusted. The failure channel of a browser
 * promise holds whatever the transport threw, and a value whose `message` is
 * an object is what rendered `[object Object]` in the dock (#211).
 */
const MessageBearingFailure = Schema.Struct({ message: Schema.String });

const decodeMessageBearing = Schema.decodeUnknownOption(MessageBearingFailure);
const decodeString = Schema.decodeUnknownOption(Schema.String);
const decodeRpcError = Schema.decodeUnknownOption(BrowserRpcError);

/** A sentence has to have something in it to be worth showing. */
const spoken = (message: string): Option.Option<string> =>
  message.trim() === "" ? Option.none() : Option.some(message);

/**
 * One failure, rendered as a sentence. This is total by construction: every
 * input returns a string, so a `string` prop holding its result can never
 * render an object.
 *
 * The caller names the fallback, because only the caller knows what the user
 * just did. A transport failure with nothing to say is still a connection
 * problem, and a refused gesture should name the gesture.
 */
export const failureMessage = <Failure>(
  failure: Failure,
  fallback: string
): string =>
  decodeMessageBearing(failure).pipe(
    Option.map(({ message }) => message),
    Option.orElse(() => decodeString(failure)),
    Option.flatMap(spoken),
    Option.getOrElse(() => fallback)
  );

/**
 * The codes that mean the thing acted on has moved on: another process
 * verified the recording, deleted it, or claimed it. The Workspace names the
 * lifecycle for these rather than blaming the connection.
 */
const LIFECYCLE_REFUSALS: ReadonlySet<BrowserRpcError["code"]> = new Set([
  "agent_flow_conflict",
  "agent_flow_not_found",
  "agent_session_conflict",
  "agent_session_not_found",
  "recording_conflict",
  "recording_unavailable",
]);

/** Whether the server refused because the recording's lifecycle moved on. */
export const isLifecycleRefusal = <Failure>(failure: Failure): boolean =>
  decodeRpcError(failure).pipe(
    Option.map(({ code }) => LIFECYCLE_REFUSALS.has(code)),
    Option.getOrElse(() => false)
  );
