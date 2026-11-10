/**
 * The documentation topics that ship in the package (ADR 0063). A developer
 * reads them on npm, GitHub, or the `/docs` site; an agent reads the same
 * files as MCP resources or through the `docs_get` operation, so there is one
 * source for both.
 *
 * This module has no dependencies, so the docs site build reads the same list.
 */

export const DOCS_URI_PREFIX = "contingency://docs/";

/** Sidebar groups on the `/docs` site, in display order. */
export const DOC_CATEGORIES = ["Start", "Guides", "Reference"] as const;

export type DocCategory = (typeof DOC_CATEGORIES)[number];

export const DOC_TOPICS = [
  {
    category: "Start",
    description:
      "Read first in every session: what Contingency is, the start steps, the rules that always apply, and which guide to read for each kind of work.",
    title: "Getting started",
    topic: "getting-started",
  },
  {
    category: "Guides",
    description:
      "Guide: run Flows in an Interactive Run, assess with evidence, complete the Run, and delegate steps to System One Pursuits.",
    title: "Run Flows",
    topic: "run",
  },
  {
    category: "Guides",
    description:
      "Guide: prepare and hand off Teaching so the user records a journey, then learn it.",
    title: "Teach a journey",
    topic: "teach",
  },
  {
    category: "Guides",
    description:
      "Guide: learn a Flow from the user's Source Document in a Guided Run.",
    title: "Guided Run",
    topic: "guided-run",
  },
  {
    category: "Guides",
    description:
      "Guide: start an Android or iOS device session and work within its support limits.",
    title: "Device sessions",
    topic: "device",
  },
  {
    category: "Guides",
    description:
      "Guide: browser devtools and the browser state each Run kind may change: Emulation, cookies, storage, routes, headers, and mutating evaluation.",
    title: "Browser state",
    topic: "browser-state",
  },
  {
    category: "Reference",
    description:
      "What Contingency can and can't do: Platform Runtimes and the Support Matrix, Teaching, Guided Run, Dry Run, Interactive Run, Scan Requirements, Browser Checks, Emulation, and the Execution Boundary.",
    title: "Capabilities",
    topic: "capabilities",
  },
  {
    category: "Reference",
    description:
      "Every Setting: config.json locations, precedence, each key with its environment variable, type, and default, and the environment-only Settings.",
    title: "Settings",
    topic: "settings",
  },
  {
    category: "Reference",
    description:
      "Variables: declaring Flow inputs, what runtime means, how values are supplied, and ignored legacy secret declarations.",
    title: "Variables",
    topic: "variables",
  },
  {
    category: "Reference",
    description:
      "Fixed limits: sessions, Teaching Recordings, browser observation, and agent_code_execute programs.",
    title: "Limits",
    topic: "limits",
  },
  {
    category: "Reference",
    description:
      "System One and Nev: how the user installs a Local System One with contingency system-one setup, endpoint precedence, startup, updates, rollback, and removal.",
    title: "System One",
    topic: "system-one",
  },
] as const satisfies readonly {
  readonly category: DocCategory;
  readonly description: string;
  readonly title: string;
  readonly topic: string;
}[];

export type DocTopic = (typeof DOC_TOPICS)[number]["topic"];

export const docUri = <Topic extends DocTopic>(topic: Topic) =>
  `${DOCS_URI_PREFIX}${topic}` as const;

/**
 * Packaged resources that are not docs topics but read well as pages: the
 * `/docs` site publishes them beside the topics under their own MCP URIs.
 */
export const DOC_SITE_RESOURCES = [
  {
    category: "Reference",
    description:
      "The learn-flow procedure: learn a Teaching Recording into a Flow, Dry Run it, and record the user's verification.",
    file: "learn-flow.md",
    page: "learn-flow",
    uri: "contingency://prompt/learn-flow",
  },
  {
    category: "Reference",
    description:
      "Writing reference: document structure, clear prose, and instructions agents can follow. Read before writing a Flow.",
    file: "writing.md",
    page: "writing",
    uri: "contingency://reference/writing",
  },
] as const satisfies readonly {
  readonly category: DocCategory;
  readonly description: string;
  readonly file: string;
  readonly page: string;
  readonly uri: string;
}[];

/** Every `/docs` page name: the topics, then the published resources. */
export const DOC_SITE_PAGES: readonly string[] = [
  ...DOC_TOPICS.map(({ topic }) => topic),
  ...DOC_SITE_RESOURCES.map(({ page }) => page),
];

/** The `/docs` site's mount path on every Contingency web server. */
export const DOCS_SITE_PATH = "/docs";

/** The page `/docs` opens. */
export const DOCS_HOME_PAGE: DocTopic = "getting-started";
