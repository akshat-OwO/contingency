import {
  CONTRACT_URL,
  agentBrowserContract,
} from "../helpers/agent-browser-contract.ts";
import { makeInMemoryAgentBrowser } from "../helpers/in-memory-agent-browser.ts";

agentBrowserContract(
  "in-memory",
  () => makeInMemoryAgentBrowser({ url: CONTRACT_URL }),
  (test) => test
);
