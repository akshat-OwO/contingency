/* oxlint-disable no-await-in-loop -- Non-model preflight follows the same client bridge and Workspace user path. */
import assert from "node:assert/strict";

import { unpack } from "./runtime.mjs";

export const scriptedProbe = async ({ mcp, task, context, url, iface }) => {
  let id = 0;
  const operation = async (name, args = {}) => {
    const request = {
      id: (id += 1),
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    };
    if (iface === "single-tool") {
      request.params = {
        arguments: {
          code: `return await tools.${name}(${JSON.stringify(args)});`,
        },
        name: "agent_code_execute",
      };
    }
    const response = await fetch(mcp.url, {
      body: JSON.stringify(request),
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const result = unpack(await response.json());
    if (iface === "single-tool") {
      if (result.status === "intervention") {
        return result;
      }
      assert.equal(result.status, "completed", JSON.stringify(result));
      return result.value;
    }
    return result;
  };
  const op = () => `scripted-probe-${id}`;
  const snap = (sessionId) =>
    operation("agent_browser_snapshot", { format: "structured", sessionId });
  const target = async (sessionId, name, type, text) => {
    const observed = await snap(sessionId);
    const node = observed.nodes.find((entry) => entry.name === name);
    assert.ok(node, `Missing ${name}`);
    const action = { ref: node.ref, type: type ?? "click" };
    if (text !== undefined) {
      action.text = text;
    }
    return operation("agent_browser_act", {
      action,
      operationId: op(),
      sessionId,
    });
  };
  if (task === "dry-run") {
    const started = await operation("agent_flow_skill_dry_run_start", {
      inputs: [
        { changed: true, name: "city", secret: false, value: "Mumbai" },
        { changed: true, name: "area", secret: false, value: "South" },
      ],
      operationId: op(),
      recordingId: context.recordingId,
      url: new URL("eval-delivery.html", url).href,
    });
    const { session } = started;
    await target(session.id, "City", "fill", "Mumbai");
    await target(session.id, "Area", "fill", "South");
    await target(session.id, "Confirm delivery");
    const observed = await snap(session.id);
    await operation("agent_run_assess", {
      evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
      explanation: "Delivering to South, Mumbai was observed",
      operationId: op(),
      outcome: "working",
      outcomeComplete: true,
      sessionId: session.id,
    });
    await operation("agent_run_complete", {
      operationId: op(),
      sessionId: session.id,
    });
    const teaching = await operation("agent_session_get", {
      sessionId: context.teachingId,
    });
    await operation("agent_session_get", {
      afterCursor: teaching.eventCursor,
      sessionId: context.teachingId,
      waitMs: 1,
    });
    return "Dry Run verified for Delivering to South, Mumbai";
  }
  const started = await operation("agent_run_start", {
    inputs: [],
    operationId: op(),
    referencedSkills: task === "takeover" ? [] : ["eval-checkout"],
    requestedTask:
      task === "takeover"
        ? "Add anvil, user changes cart, add workbench"
        : "Place mock order",
    url: new URL(task === "takeover" ? "shop.html" : "eval-checkout.html", url)
      .href,
  });
  if (task === "takeover") {
    await target(started.id, "Add Giant anvil to cart");
    const session = await operation("agent_session_get", {
      sessionId: started.id,
    });
    await operation("agent_session_get", {
      afterCursor: session.eventCursor,
      sessionId: started.id,
      waitMs: 1,
    });
    await target(started.id, "SKU", "fill", "BENCH-002");
    await target(started.id, "Add SKU to cart");
    await target(started.id, "Cart");
    return "Cart contains Safety goggles and Workbench";
  }
  await operation("agent_variable_request", {
    flowSkillName: "eval-checkout",
    name: "PASSWORD",
    operationId: op(),
    sessionId: started.id,
  });
  await operation("agent_session_get", { sessionId: started.id });
  const observed = await snap(started.id);
  await operation("agent_variable_enter", {
    flowSkillName: "eval-checkout",
    name: "PASSWORD",
    operationId: op(),
    ref: observed.nodes.find((node) => node.name === "Payment password").ref,
    sessionId: started.id,
  });
  const before = await snap(started.id);
  const boundary = await operation("agent_browser_act", {
    action: {
      ref: before.nodes.find((node) => node.name === "Place mock order").ref,
      type: "click",
    },
    intent: { irreversible: true },
    operationId: op(),
    sessionId: started.id,
  });
  await operation("agent_session_get", { sessionId: started.id });
  if (task === "checkout") {
    await operation("agent_browser_resume", {
      boundaryId: boundary.intervention.id,
      format: "structured",
      sessionId: started.id,
    });
  }
  return task === "checkout"
    ? "Order confirmed"
    : "User refused; no order placed";
};
