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

/**
 * Uploads a built `.app` folder as the Workspace does. Contingency installs
 * only an uploaded build, and one upload serves one session, so each session
 * that installs the fixture uploads it again. Returns the upload's identity;
 * its `appPath` is the server's temporary copy.
 */
export const uploadIosApp = async (baseUrl, bundle) => {
  const { readdir, readFile } = await import("node:fs/promises");
  const parent = path.dirname(bundle);
  const entries = await readdir(bundle, {
    recursive: true,
    withFileTypes: true,
  });
  const parts = [];
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const full = path.join(entry.parentPath, entry.name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Frames are written in order.
    const bytes = await readFile(full);
    const name = Buffer.from(path.relative(parent, full));
    const header = Buffer.alloc(4 + name.length + 8);
    header.writeUInt32BE(name.length, 0);
    name.copy(header, 4);
    header.writeBigUInt64BE(BigInt(bytes.length), 4 + name.length);
    parts.push(header, bytes);
  }
  const response = await fetch(new URL("/target-app-builds/ios", baseUrl), {
    body: Buffer.concat(parts),
    headers: { origin: new URL(baseUrl).origin },
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`iOS build upload refused: ${body.message}`);
  }
  return body;
};
