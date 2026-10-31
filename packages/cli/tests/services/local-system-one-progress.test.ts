import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeLocalSystemOneProgress } from "../../src/services/local-system-one-progress.ts";

for (const tty of [true, false]) {
  it.effect(
    `renders ${tty ? "TTY" : "plain"} downloads with virtual rates`,
    () =>
      Effect.gen(function* progressOutput() {
        const lines: string[] = [];
        const progress = makeLocalSystemOneProgress(tty, (line) =>
          Effect.sync(() => {
            lines.push(line);
          })
        );
        yield* progress.stage("Environment");
        const bar = yield* progress.download("Kev archive", 1000);
        yield* TestClock.adjust("1 second");
        yield* bar.update(100);
        yield* TestClock.adjust("1 second");
        yield* bar.update(150);
        yield* bar.update(1000, 1000, true);
        yield* bar.finish;
        expect(lines).toEqual(
          tty
            ? [
                "Environment...\n",
                "\r\u001B[2KKev archive: [                    ] 0 B / 1000 B 0% 0 B/s",
                "\r\u001B[2KKev archive: [==                  ] 100 B / 1000 B 10% 100 B/s",
                "\r\u001B[2KKev archive: [===                 ] 150 B / 1000 B 15% 75 B/s",
                "\r\u001B[2KKev archive: [====================] 1000 B / 1000 B 100% 500 B/s\n",
              ]
            : [
                "Environment...\n",
                "Kev archive: 0 B / 1000 B 0% 0 B/s\n",
                "Kev archive: 100 B / 1000 B 10% 100 B/s\n",
                "Kev archive: 1000 B / 1000 B 100% 500 B/s\n",
              ]
        );
      })
  );
}

it.effect(
  "throttles TTY redraws and closes an interrupted unknown-size download",
  () =>
    Effect.gen(function* interruptedProgress() {
      const lines: string[] = [];
      const progress = makeLocalSystemOneProgress(true, (line) =>
        Effect.sync(() => {
          lines.push(line);
        })
      );
      const bar = yield* progress.download("Model weights");
      yield* bar.update(1024);
      expect(lines).toHaveLength(1);
      yield* TestClock.adjust("100 millis");
      yield* bar.update(1024);
      yield* bar.finish;
      yield* bar.finish;
      expect(lines).toEqual([
        "\r\u001B[2KModel weights: [                    ] 0 B ?% 0 B/s",
        "\r\u001B[2KModel weights: [                    ] 1.0 KiB ?% 10.0 KiB/s",
        "\n",
      ]);
    })
);

it.effect(
  "prints unknown-size downloads only at start and completion off a TTY",
  () =>
    Effect.gen(function* unknownLength() {
      const lines: string[] = [];
      const progress = makeLocalSystemOneProgress(false, (line) =>
        Effect.sync(() => {
          lines.push(line);
        })
      );
      const bar = yield* progress.download("Kev archive");
      yield* TestClock.adjust("1 second");
      yield* bar.update(100);
      yield* bar.update(200, undefined, true);
      expect(lines).toEqual([
        "Kev archive: 0 B ?% 0 B/s\n",
        "Kev archive: 200 B ?% 200 B/s\n",
      ]);
    })
);

it.effect("keeps reporting when a model stream discovers more files", () =>
  Effect.gen(function* growingTotal() {
    const lines: string[] = [];
    const progress = makeLocalSystemOneProgress(false, (line) =>
      Effect.sync(() => {
        lines.push(line);
      })
    );
    const bar = yield* progress.download("Model weights");
    yield* TestClock.adjust("1 second");
    yield* bar.update(100, 100);
    yield* bar.update(100, 1000);
    yield* bar.update(200, 1000);
    yield* bar.update(1000, 1000);
    yield* bar.update(1000, 1000, true);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe("Model weights: 100 B / 1000 B 10% 100 B/s\n");
    expect(lines[3]).toBe("Model weights: 200 B / 1000 B 20% 200 B/s\n");
    expect(lines[4]).toBe("Model weights: 1000 B / 1000 B 100% 1000 B/s\n");
  })
);
