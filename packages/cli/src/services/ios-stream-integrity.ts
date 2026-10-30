import { Effect, Schema } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
// oxlint-disable-next-line eslint/no-redeclare
export const IosFramebufferPacket = Schema.Struct({
  displayPort: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)
  ),
  encodedMs: timestamp,
  height: Schema.Int.check(Schema.isBetween({ maximum: 4096, minimum: 1 })),
  jpeg: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(3 * 1024 * 1024)
  ),
  presentedMs: timestamp,
  sampledMs: timestamp,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sourceSequence: counter,
  startMs: timestamp,
  width: Schema.Int.check(Schema.isBetween({ maximum: 4096, minimum: 1 })),
});
export type IosFramebufferPacket = typeof IosFramebufferPacket.Type;
export type IosStreamGap =
  | "helper-exited"
  | "invalid-packet"
  | "sequence-gap"
  | "source-reset"
  | "stream-silence"
  | "slow-consumer"
  | "no-frames"
  | "display-mismatch"
  | "display-unavailable";
export interface IosStreamInterval {
  readonly generation: string;
  readonly sampledAfterMs: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly firstSampledMs: number | null;
  readonly lastSampledMs: number | null;
  readonly gaps: readonly IosStreamGap[];
  readonly status: "recording" | "stopped" | "incomplete";
}
interface IntegrityState {
  readonly generation: string | null;
  readonly failure: IosStreamGap | null;
  readonly retaining: boolean;
  readonly latest: IosFramebufferPacket | null;
  readonly interval: IosStreamInterval | null;
}

/** Output continuity is distinct from compositor callback coverage. Static screens are valid. */
export const makeIosStreamIntegrity = () => {
  const registry = AtomRegistry.make();
  const state = Atom.make<IntegrityState>({
    failure: null,
    generation: null,
    interval: null,
    latest: null,
    retaining: false,
  }).pipe(Atom.keepAlive);
  registry.get(state);
  const gap = (reason: IosStreamGap) => {
    registry.update(state, (current) => ({
      ...current,
      failure: reason,
      interval:
        current.interval?.status === "recording"
          ? {
              ...current.interval,
              gaps: [...new Set([...current.interval.gaps, reason])],
              status: "incomplete" as const,
            }
          : current.interval,
    }));
  };
  return {
    accept: (generation: string, packet: IosFramebufferPacket) =>
      Effect.sync(() => {
        const current = registry.get(state);
        if (current.generation !== generation) {
          return false;
        }
        const previous = current.latest;
        let reason: IosStreamGap | undefined;
        if (
          packet.encodedMs < packet.sampledMs ||
          packet.sampledMs < packet.startMs ||
          packet.presentedMs > packet.encodedMs
        ) {
          reason = "invalid-packet";
        } else if (previous !== null) {
          if (
            packet.startMs !== previous.startMs ||
            packet.sourceSequence < previous.sourceSequence ||
            packet.sampledMs <= previous.sampledMs
          ) {
            reason = "source-reset";
          } else if (packet.sequence !== previous.sequence + 1) {
            reason = "sequence-gap";
          }
        }
        if (reason !== undefined) {
          gap(reason);
          return false;
        }
        registry.update(state, (value) => ({
          ...value,
          interval:
            value.interval?.status === "recording" &&
            packet.sampledMs >= value.interval.sampledAfterMs
              ? {
                  ...value.interval,
                  firstSampledMs:
                    value.interval.firstSampledMs ?? packet.sampledMs,
                  firstSequence:
                    value.interval.firstSequence ?? packet.sequence,
                  lastSampledMs: packet.sampledMs,
                  lastSequence: packet.sequence,
                }
              : value.interval,
          latest: packet,
        }));
        return true;
      }),
    fail: (reason: IosStreamGap) => Effect.sync(() => gap(reason)),
    failure: () => registry.get(state).failure,
    generation: (generation: string) =>
      Effect.sync(() => {
        // Reconnection can restore the mirror, never repair an interrupted recording.
        gap("source-reset");
        registry.update(state, (current) => ({
          ...current,
          failure: null,
          generation,
          latest: null,
        }));
      }),
    snapshot: () => structuredClone(registry.get(state).interval),
    start: (sampledAfterMs: number) =>
      Effect.sync(() => {
        const current = registry.get(state);
        if (
          !Number.isFinite(sampledAfterMs) ||
          sampledAfterMs < 0 ||
          current.generation === null ||
          current.latest === null ||
          current.retaining
        ) {
          return false;
        }
        registry.set(state, {
          ...current,
          interval: {
            firstSampledMs: null,
            firstSequence: null,
            gaps: [],
            generation: current.generation,
            lastSampledMs: null,
            lastSequence: null,
            sampledAfterMs,
            status: "recording",
          },
          retaining: true,
        });
        return true;
      }),
    stop: () =>
      Effect.sync(() => {
        const { interval } = registry.get(state);
        if (
          interval?.status === "recording" &&
          interval.firstSequence === null
        ) {
          gap("no-frames");
        }
        registry.update(state, (current) => ({
          ...current,
          interval:
            current.interval?.status === "recording"
              ? { ...current.interval, status: "stopped" as const }
              : current.interval,
          retaining: false,
        }));
        return structuredClone(registry.get(state).interval);
      }),
  };
};
