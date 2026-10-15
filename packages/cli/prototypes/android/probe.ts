import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Option } from "effect";

import { ProbeError } from "./driver.ts";
import type { Action, Observation } from "./driver.ts";
import { withSession } from "./session.ts";
import { adb } from "./transport.ts";
import type { CommandEntry } from "./transport.ts";

const [
  serial = "",
  target = "",
  directory = "",
  scenario = "observe",
  argument = "",
  second = "",
] = process.argv.slice(2);
const root = path.resolve(
  ".cursor/skills/verify-contingency/artifacts/android-463"
);
const destination = path.resolve(directory);
const within = path.relative(root, destination);
const privateValue = randomUUID();
const commands: CommandEntry[] = [];
const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => new ProbeError("artifact_failed"),
    try: work,
  });
const retain = (name: string, observation: Observation) =>
  Effect.gen(function* retainObservation() {
    const { screenshot, ...record } = observation;
    yield* io(() =>
      writeFile(
        path.resolve(destination, `${name}.json`),
        JSON.stringify(record, null, 2),
        { mode: 0o600 }
      )
    );
    yield* io(() =>
      writeFile(
        path.resolve(destination, `${name}.png`),
        Buffer.from(screenshot, "base64"),
        { mode: 0o600 }
      )
    );
  });
const result = (operation: Effect.Effect<unknown, ProbeError>) =>
  Effect.match(operation, {
    onFailure: (error) => ({ error: error.code }),
    onSuccess: (value) => value,
  });
const program = Effect.gen(function* probe() {
  if (
    !serial ||
    !target ||
    !directory ||
    within.startsWith("..") ||
    within === ""
  ) {
    return yield* Effect.fail(
      new ProbeError(
        "usage: nub probe.ts SERIAL TARGET ARTIFACT_SUBDIRECTORY [SCENARIO ARGUMENT SECOND]"
      )
    );
  }
  yield* io(() => mkdir(destination, { mode: 0o700, recursive: true }));
  yield* withSession({
    journal: (entry) => commands.push(entry),
    secret: (variable) =>
      variable === "PROBE_INPUT"
        ? Effect.succeed(privateValue)
        : Effect.fail(new ProbeError("variable_missing")),
    serial,
    target,
    use: (driver) =>
      Effect.gen(function* proof() {
        if (scenario === "launch-unavailable") {
          const journal = [
            {
              operation: "authorized_launch",
              outcome: yield* result(
                driver
                  .launch(target)
                  .pipe(Effect.map(() => ({ dispatched: true })))
              ),
              serial,
              target,
            },
          ];
          yield* io(() =>
            writeFile(
              path.resolve(destination, "journal.json"),
              JSON.stringify(journal, null, 2),
              { mode: 0o600 }
            )
          );
          return;
        }
        const before = yield* driver.observe;
        yield* retain("before", before);
        const journal: unknown[] = [
          { observation: before.observation, operation: "observe", serial },
        ];
        if (
          scenario === "click" ||
          scenario === "private" ||
          scenario === "coordinate"
        ) {
          let action: Action;
          if (scenario === "click") {
            action = { kind: "click", target: argument };
          } else if (scenario === "private") {
            action = {
              kind: "fill",
              target: argument,
              variable: "PROBE_INPUT",
            };
          } else {
            action = {
              kind: "coordinate",
              x: Number(argument),
              y: Number(second),
            };
          }
          journal.push(
            {
              action,
              operation: "dispatch",
              outcome: yield* result(
                driver.dispatch(before.observation, action)
              ),
              serial,
            },
            {
              operation: "stale_replay",
              outcome: yield* result(
                driver.dispatch(before.observation, action)
              ),
              serial,
            }
          );
        }
        if (scenario === "launch-authorized") {
          yield* adb(serial, ["shell", "input", "keyevent", "3"], (entry) =>
            commands.push(entry)
          );
          journal.push({
            operation: "authorized_launch",
            outcome: yield* result(
              driver
                .launch(target)
                .pipe(Effect.map(() => ({ dispatched: true })))
            ),
            serial,
            target,
          });
        }
        if (scenario === "launch-denied") {
          journal.push({
            operation: "launch",
            outcome: yield* result(driver.launch("com.android.chrome")),
            serial,
          });
        }
        if (scenario === "helper-failure") {
          yield* adb(serial, [
            "shell",
            "am",
            "force-stop",
            "dev.contingency.probe",
          ]);
          journal.push({
            command: [
              "adb",
              "-s",
              serial,
              "shell",
              "am",
              "force-stop",
              "dev.contingency.probe",
            ],
            operation: "helper_failure",
            outcome: yield* result(
              driver.observe.pipe(
                Effect.map((observed) => ({
                  observation: observed.observation,
                }))
              )
            ),
          });
        }
        if (scenario === "cross-app") {
          yield* adb(serial, [
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            "com.android.chrome/com.google.android.apps.chrome.Main",
          ]);
          journal.push({
            operation: "unexpected_transition",
            outcome: yield* result(
              driver.observe.pipe(
                Effect.map((observed) => ({
                  observation: observed.observation,
                }))
              )
            ),
            serial,
          });
        }
        if (scenario === "capture-failure") {
          yield* driver.failNextCapture;
          journal.push(
            {
              operation: "fault_capture",
              outcome: yield* result(
                driver.observe.pipe(
                  Effect.map((observed) => ({
                    observation: observed.observation,
                  }))
                )
              ),
            },
            { operation: "failure_status", state: yield* driver.status }
          );
        }
        if (scenario === "capture-off") {
          yield* adb(serial, ["shell", "input", "keyevent", "223"], (entry) =>
            commands.push(entry)
          );
          journal.push(
            {
              operation: "screen_off_capture",
              outcome: yield* result(
                driver.observe.pipe(
                  Effect.map((observed) => ({
                    observation: observed.observation,
                  }))
                )
              ),
              serial,
            },
            {
              operation: "screen_off_status",
              state: yield* driver.status,
            }
          );
          yield* adb(serial, ["shell", "input", "keyevent", "224"], (entry) =>
            commands.push(entry)
          );
        }
        if (scenario === "disconnect") {
          yield* adb(serial, ["emu", "kill"]);
          journal.push({
            operation: "disconnect",
            outcome: yield* result(
              driver.observe.pipe(
                Effect.map((observed) => ({
                  observation: observed.observation,
                }))
              )
            ),
            serial,
          });
        }
        journal.push({ operation: "status", state: yield* driver.status });
        const after = yield* driver.observe.pipe(
          Effect.match({
            onFailure: (error) => {
              journal.push({
                error: error.code,
                operation: "after_observation",
              });
              return Option.none<Observation>();
            },
            onSuccess: Option.some,
          })
        );
        if (Option.isSome(after)) {
          yield* retain("after", after.value);
          journal.push({
            observation: after.value.observation,
            operation: "observe",
            serial,
          });
        }
        if (scenario === "private") {
          const diagnostics = yield* adb(serial, [
            "logcat",
            "-d",
            "-t",
            "2000",
          ]);
          const leaked = diagnostics.includes(privateValue);
          journal.push({
            diagnosticsContainedPrivateValue: leaked,
            operation: "privacy_check",
          });
          if (leaked) {
            return yield* Effect.fail(new ProbeError("privacy_failed"));
          }
        }
        const text = JSON.stringify(journal, null, 2);
        if (text.includes(privateValue)) {
          return yield* Effect.fail(new ProbeError("privacy_failed"));
        }
        yield* io(() =>
          writeFile(path.resolve(destination, "journal.json"), text, {
            mode: 0o600,
          })
        );
      }),
  }).pipe(
    Effect.tapError((error) =>
      io(() =>
        writeFile(
          path.resolve(destination, "failure.json"),
          JSON.stringify({ error: error.code, serial, target }, null, 2),
          { mode: 0o600 }
        )
      ).pipe(Effect.orDie)
    ),
    Effect.ensuring(
      io(() =>
        writeFile(
          path.resolve(destination, "commands.json"),
          JSON.stringify(commands, null, 2),
          { mode: 0o600 }
        )
      ).pipe(Effect.orDie)
    )
  );
});
await Effect.runPromise(
  program.pipe(
    Effect.match({
      onFailure: (error) => {
        process.exitCode = 1;
        process.stderr.write(`${JSON.stringify({ error: error.code })}\n`);
      },
      onSuccess: () => {
        process.exitCode = 0;
      },
    })
  )
);
