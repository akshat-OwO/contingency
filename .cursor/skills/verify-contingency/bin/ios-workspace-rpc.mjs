import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { ws: WebSocket } = require("playwright-core/lib/utilsBundle");

/** Internal opt-in Workspace RPC. Public MCP continues to refuse iOS. */
export const iosRpc = (baseUrl, tag, payload) =>
  // oxlint-disable-next-line promise/avoid-new -- A socket reply is the RPC completion event.
  new Promise((resolve, reject) => {
    const url = new URL("/ws", baseUrl);
    url.protocol = "ws:";
    const socket = new WebSocket(url, { origin: new URL(baseUrl).origin });
    const guard = setTimeout(() => socket.terminate(), 180_000);
    let settled = false;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      socket.removeAllListeners();
      socket.close();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    socket.once("close", () =>
      finish(new Error(`iOS Workspace RPC closed without a reply: ${tag}`))
    );
    socket.once("error", (error) => finish(error));
    socket.once("open", () =>
      socket.send(
        JSON.stringify({ _tag: "Request", headers: [], id: "1", payload, tag })
      )
    );
    socket.on("message", (bytes) => {
      const messages = JSON.parse(bytes.toString());
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message._tag === "Defect") {
          finish(new Error(JSON.stringify(message.defect)));
          return;
        }
        if (message._tag !== "Exit" || String(message.requestId) !== "1") {
          continue;
        }
        if (message.exit._tag === "Success") {
          finish(null, message.exit.value);
        } else {
          finish(new Error(JSON.stringify(message.exit.cause)));
        }
      }
    });
  });
