import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeDriver, ProbeError } from "./driver.ts";
import type { Request, Transport } from "./driver.ts";

const target = "com.android.settings";
const capture = {
  height: 100,
  nodes: [],
  observation: "observation-1",
  package: target,
  screenshot: "cG5n",
  width: 100,
};
const fixture = () => {
  const requests: Request[] = [];
  let fault = "";
  let session = "session-1";
  let missing = false;
  let version = 1;
  let wrongCorrelation = false;
  const transport: Transport = (request) =>
    Effect.suspend(() => {
      requests.push(request);
      if (fault === "disconnect") {
        return Effect.fail(new ProbeError("disconnected"));
      }
      let result:
        | typeof capture
        | { dispatched: boolean }
        | { api: number; capabilities: string[]; target: string } = {
        dispatched: true,
      };
      if (request.op === "hello") {
        result = {
          api: 36,
          capabilities: missing
            ? []
            : ["semantic", "screenshot", "coordinate", "private-input"],
          target,
        };
      } else if (request.op === "observe") {
        result = capture;
      }
      const response = {
        id: wrongCorrelation ? "another-request" : request.id,
        result,
        session,
        version,
      };
      return Effect.succeed(fault ? { ...response, error: fault } : response);
    });
  const driver = makeDriver({
    secret: (variable) =>
      variable === "PASSWORD"
        ? Effect.succeed("private-test-value")
        : Effect.fail(new ProbeError("variable_missing")),
    serial: "selected-device",
    target,
    transport,
  });
  return {
    driver,
    requests,
    setFault: (code: string) => {
      fault = code;
    },
    setMissing: () => {
      missing = true;
    },
    setSession: (id: string) => {
      session = id;
    },
    setVersion: (next: number) => {
      version = next;
    },
    setWrongCorrelation: () => {
      wrongCorrelation = true;
    },
  };
};
const errorCode = <A>(operation: Effect.Effect<A, ProbeError>) =>
  Effect.runPromise(
    Effect.match(operation, {
      onFailure: (error) => error.code,
      onSuccess: () => "success",
    })
  );

describe("isolated Android protocol client", () => {
  it("requires capabilities and a fresh observation after connecting", async () => {
    const { driver, requests } = fixture();
    await Effect.runPromise(driver.connect);
    expect(
      await errorCode(
        driver.dispatch(capture.observation, { kind: "coordinate", x: 1, y: 1 })
      )
    ).toBe("observation_stale");
    expect(requests.map((request) => request.op)).toEqual(["hello"]);
  });
  it("blocks missing capabilities", async () => {
    const { driver, setMissing } = fixture();
    setMissing();
    expect(await errorCode(driver.connect)).toBe("capability_missing");
    const status1 = await Effect.runPromise(driver.status);
    expect(status1.paused).toBe(true);
  });
  it("rejects protocol versions and mismatched request correlation", async () => {
    const incompatible = fixture();
    incompatible.setVersion(2);
    expect(await errorCode(incompatible.driver.connect)).toBe(
      "protocol_incompatible"
    );
    const wrongRequest = fixture();
    wrongRequest.setWrongCorrelation();
    expect(await errorCode(wrongRequest.driver.connect)).toBe(
      "protocol_incompatible"
    );
  });
  it("refuses diagnostic faults when the helper did not advertise them", async () => {
    const { driver, requests } = fixture();
    await Effect.runPromise(driver.connect);
    expect(await errorCode(driver.failNextCapture)).toBe("capability_missing");
    expect(requests.map((request) => request.op)).toEqual(["hello"]);
  });
  it("consumes targets before dispatch and retains only Variable references", async () => {
    const { driver, requests } = fixture();
    await Effect.runPromise(driver.connect);
    const observed = await Effect.runPromise(driver.observe);
    const action = {
      kind: "fill" as const,
      target: "field",
      variable: "PASSWORD",
    };
    const record = await Effect.runPromise(
      driver.dispatch(observed.observation, action)
    );
    expect(requests.at(-1)?.value).toBe("private-test-value");
    expect(JSON.stringify(record)).not.toContain("private-test-value");
    expect(record.action).toEqual(action);
    expect(await errorCode(driver.dispatch(observed.observation, action))).toBe(
      "observation_stale"
    );
    expect(requests.filter((request) => request.op === "action")).toHaveLength(
      1
    );
  });
  it.each([
    "disconnect",
    "helper_failed",
    "capture_failed",
    "ownership_denied",
    "ownership_ambiguous",
  ])(
    "invalidates observations after %s and requires recovery observation",
    async (failure) => {
      const { driver, requests, setFault } = fixture();
      await Effect.runPromise(driver.connect);
      await Effect.runPromise(driver.observe);
      setFault(failure);
      expect(await errorCode(driver.observe)).toBe(
        failure === "disconnect" ? "disconnected" : failure
      );
      const count = requests.length;
      expect(
        await errorCode(
          driver.dispatch(capture.observation, {
            kind: "click",
            target: "field",
          })
        )
      ).toBe("observation_stale");
      expect(requests).toHaveLength(count);
      const status2 = await Effect.runPromise(driver.status);
      expect(status2.observation).toBe("");
      setFault("");
      await Effect.runPromise(driver.observe);
      const status3 = await Effect.runPromise(driver.status);
      expect(status3.paused).toBe(false);
    }
  );
  it("rejects another helper session and does not replay", async () => {
    const { driver, setSession } = fixture();
    await Effect.runPromise(driver.connect);
    await Effect.runPromise(driver.observe);
    setSession("session-2");
    expect(
      await errorCode(
        driver.dispatch(capture.observation, { kind: "coordinate", x: 1, y: 1 })
      )
    ).toBe("session_stale");
    const status4 = await Effect.runPromise(driver.status);
    expect(status4.paused).toBe(true);
  });
  it("refuses known unauthorized launches before transport", async () => {
    const { driver, requests } = fixture();
    await Effect.runPromise(driver.connect);
    await Effect.runPromise(driver.observe);
    const count = requests.length;
    expect(await errorCode(driver.launch("com.android.chrome"))).toBe(
      "launch_unauthorized"
    );
    expect(requests).toHaveLength(count);
    const status5 = await Effect.runPromise(driver.status);
    expect(status5.paused).toBe(true);
  });
  it("serializes concurrent dispatch so only one action consumes the observation", async () => {
    const { driver, requests } = fixture();
    await Effect.runPromise(driver.connect);
    await Effect.runPromise(driver.observe);
    const verdicts = await Promise.all([
      errorCode(
        driver.dispatch(capture.observation, { kind: "click", target: "field" })
      ),
      errorCode(
        driver.dispatch(capture.observation, { kind: "click", target: "field" })
      ),
    ]);
    expect(verdicts.toSorted()).toEqual(["observation_stale", "success"]);
    expect(requests.filter((request) => request.op === "action")).toHaveLength(
      1
    );
  });
  it("closes idempotently and rejects retained handles", async () => {
    const { driver, requests } = fixture();
    await Effect.runPromise(driver.connect);
    await Effect.runPromise(driver.close);
    await Effect.runPromise(driver.close);
    expect(requests.filter((request) => request.op === "close")).toHaveLength(
      1
    );
    expect(await errorCode(driver.observe)).toBe("closed");
  });
});
