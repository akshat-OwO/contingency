// The Flows page (#755): `/flow` replaces the Flows Drawer. A catalog sidebar
// on the left, and the selected Flow split in two beside it: its rendered
// markdown, then its Runs with a Run Summary and video.
import { Button } from "@ui-sdk/react/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import { Input } from "@ui-sdk/react/input";
import {
  Slider,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
} from "@ui-sdk/react/slider";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import {
  Tree,
  TreeGroup,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
} from "@ui-sdk/react/tree";
import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  AndroidIcon,
  AppleIcon,
  ChevronIcon,
  DraftIcon,
  EyeOffIcon,
  ExternalIcon,
  FileIcon,
  FolderIcon,
  ForwardIcon,
  PauseIcon,
  PlayIcon,
  PointerIcon,
  RecordIcon,
  SearchIcon,
  VerifiedIcon,
  WebIcon,
} from "./icons";

type Platform = "web" | "android" | "ios";
type Assessment = "working" | "not-working" | "inconclusive" | "blocked";
type Scope = "local" | "global";

/** One span of a Run's video. Idle Gaps play condensed (ADR 0046). */
interface Segment {
  readonly kind: "action" | "idle" | "hidden" | "takeover";
  /** Seconds of the real Run this span covers. */
  readonly real: number;
  readonly label: string;
}

interface Run {
  readonly id: string;
  readonly kind: "Dry Run" | "Interactive Run";
  readonly platform: Platform;
  readonly title: string;
  readonly assessment: Assessment;
  readonly when: string;
  readonly explanation: string;
  readonly findings: readonly {
    readonly outcome: Assessment;
    readonly text: string;
  }[];
  readonly modifications?: readonly string[];
  readonly flows: readonly string[];
  readonly video: readonly Segment[];
}

interface Recording {
  readonly id: string;
  readonly when: string;
  readonly keyframes: number;
  readonly phase: "Learned, Dry Run next" | "Dry Run passed" | "Cleaned up";
}

interface Flow {
  readonly name: string;
  readonly scope: Scope;
  readonly group: readonly string[];
  readonly platform: Platform;
  readonly verified: boolean;
  readonly description: string;
  readonly stamped: readonly (readonly [string, string])[];
  readonly files: readonly { readonly path: string; readonly body: string }[];
  readonly runs: readonly Run[];
  readonly recordings: readonly Recording[];
}

const PLATFORM: Record<
  Platform,
  { readonly name: string; readonly Icon: () => ReactNode }
> = {
  android: { Icon: AndroidIcon, name: "Android" },
  ios: { Icon: AppleIcon, name: "iOS" },
  web: { Icon: WebIcon, name: "Web" },
};

const ASSESSMENT: Record<Assessment, string> = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
};

const a = (real: number, label: string): Segment => ({
  kind: "action",
  label,
  real,
});
const idle = (real: number, label = "Agent thinking"): Segment => ({
  kind: "idle",
  label,
  real,
});

/* -------------------------------------------------------------- sample data */

const CHECKOUT_MD = `# checkout

Buy one item from the demo store as a signed-in shopper, and stop at the order confirmation.

## Inputs

- \`email\`: the shopper's sign-in email.
- \`password\`: the shopper's password.

## Procedure

1. Open the store and sign in with \`email\` and \`password\`.
   Done when: the header shows **Account**.
2. Search for "wool socks" and open the first result.
   Done when: the product page shows an **Add to cart** button.
3. Add one pair to the cart and open the cart.
   Done when: the cart lists exactly one item.
4. Check out with the saved test card. See [payment.md](payment.md) for the cards the store accepts.
   Done when: the page shows **Thanks for your order** and an order number.`;

const PAYMENT_MD = `# payment

The demo store runs Stripe in test mode. Use these cards only.

- \`4242 4242 4242 4242\`: succeeds.
- \`4000 0000 0000 9995\`: declined, insufficient funds.

A 3-D Secure prompt can appear on the first order of a session. Approve it; it is part of the journey, not a failure.`;

const LOGIN_MD = `# login

Sign in to Contingency Public Login with an existing account.

## Inputs

- \`email\`
- \`password\`

## Procedure

1. Open Contingency Public Login.
   Done when: the **Sign in** button shows.
2. Enter \`email\` and \`password\`, then tap **Sign in**.
   Done when: the heading **Welcome back** shows.`;

const ONBOARDING_MD = `# onboarding

Create a new account and finish the first-run tour.

Learned in a Guided Run from \`docs/onboarding.md\`. Where the app disagreed with the document, the user's answer was kept.

## Inputs

- \`new_email\`: an address no account uses yet.

## Procedure

1. Open the app and tap **Create account**.
   Done when: the email field has focus.
2. Enter \`new_email\` and a password, then continue.
   Done when: the plan picker shows.
3. Choose **Starter**. The app offers no Free plan.
   Done when: **Starter** is selected.
4. Turn on notifications when the system asks.
   Done when: the home tab shows.`;

const SEARCH_MD = `# search

Search the store and narrow the results with filters.

## Procedure

1. Search for "jacket".
   Done when: at least one result shows.
2. Filter to size **M** and a price under **$80**.
   Done when: every result is size M and under $80.`;

const SETTINGS_MD = `# settings

Turn on dark mode in the app settings.

## Procedure

1. Open **Settings** from the profile tab.
   Done when: the **Appearance** row shows.
2. Set **Appearance** to **Dark**.
   Done when: the app's background turns dark.`;

const SSO_MD = `# sign-in-sso

Sign in through the company identity provider.

## Procedure

1. Open the app and choose **Continue with SSO**.
   Done when: the identity provider's page shows.
2. Sign in and approve the request.
   Done when: the app shows the signed-in home page.`;

const FLOWS: readonly Flow[] = [
  {
    description:
      "Buy one item from the demo store as a signed-in shopper, and stop at the order confirmation.",
    files: [
      { body: CHECKOUT_MD, path: "flow.md" },
      { body: PAYMENT_MD, path: "payment.md" },
    ],
    group: ["shop"],
    name: "checkout",
    platform: "web",
    recordings: [
      {
        id: "rec_7Hc2",
        keyframes: 48,
        phase: "Cleaned up",
        when: "5 days ago",
      },
    ],
    runs: [
      {
        assessment: "working",
        explanation:
          "The order went through and the confirmation page showed order #10482. The order email's link opened a 404, which the Flow does not check.",
        findings: [
          {
            outcome: "working",
            text: "Thanks for your order shows with order #10482.",
          },
          {
            outcome: "not-working",
            text: "The View order link in the confirmation email returns 404.",
          },
        ],
        flows: ["checkout"],
        id: "run_Q81x",
        kind: "Interactive Run",
        platform: "web",
        title: "Buy wool socks and check the confirmation email",
        video: [
          a(6, "Open shop.localhost"),
          a(9, "Sign in as qa@shop.localhost"),
          idle(34),
          a(7, "Search for wool socks"),
          a(5, "Add to cart"),
          idle(21, "Waiting on Confirmation"),
          a(8, "Place order · $14.00"),
          a(6, "Open the confirmation email"),
        ],
        when: "2 hours ago",
      },
      {
        assessment: "working",
        explanation:
          "Every step reached its Done when outcome in a fresh browser context.",
        findings: [
          {
            outcome: "working",
            text: "All four Done when outcomes were observed.",
          },
        ],
        flows: ["checkout"],
        id: "run_M2ra",
        kind: "Dry Run",
        platform: "web",
        title: "Dry Run of checkout",
        video: [
          a(6, "Open shop.localhost"),
          a(10, "Sign in"),
          idle(18),
          a(7, "Search for wool socks"),
          a(6, "Add to cart"),
          a(9, "Check out with 4242 4242 4242 4242"),
        ],
        when: "5 days ago",
      },
      {
        assessment: "inconclusive",
        explanation:
          "The 3-D Secure prompt did not load, so the user took control and approved it. A Dry Run with a Takeover cannot pass.",
        findings: [
          {
            outcome: "inconclusive",
            text: "Step 4 was finished by the user, not the agent.",
          },
        ],
        flows: ["checkout"],
        id: "run_K0pd",
        kind: "Dry Run",
        platform: "web",
        title: "Dry Run of checkout",
        video: [
          a(6, "Open shop.localhost"),
          a(10, "Sign in"),
          a(7, "Search for wool socks"),
          a(6, "Add to cart"),
          idle(42, "3-D Secure prompt loading"),
          { kind: "takeover", label: "You approved 3-D Secure", real: 14 },
          a(5, "Confirm the order page"),
        ],
        when: "6 days ago",
      },
    ],
    scope: "local",
    stamped: [
      ["Hosts", "shop.localhost · pay.stripe.com"],
      ["Emulation", "Desktop 1280×800 · en-US · light"],
    ],
    verified: true,
  },
  {
    description: "Search the store and narrow the results with filters.",
    files: [{ body: SEARCH_MD, path: "flow.md" }],
    group: ["shop"],
    name: "search",
    platform: "web",
    recordings: [
      {
        id: "rec_2bLk",
        keyframes: 21,
        phase: "Cleaned up",
        when: "3 weeks ago",
      },
    ],
    runs: [
      {
        assessment: "working",
        explanation: "Both filters applied and every result matched them.",
        findings: [
          { outcome: "working", text: "12 results, all size M under $80." },
        ],
        flows: ["search"],
        id: "run_W5te",
        kind: "Dry Run",
        platform: "web",
        title: "Dry Run of search",
        video: [
          a(5, "Search for jacket"),
          idle(9),
          a(6, "Filter to size M"),
          a(5, "Set price under $80"),
        ],
        when: "3 weeks ago",
      },
    ],
    scope: "local",
    stamped: [
      ["Hosts", "shop.localhost"],
      ["Emulation", "Desktop 1280×800 · en-US · light"],
    ],
    verified: true,
  },
  {
    description:
      "Sign in to Contingency Public Login with an existing account.",
    files: [{ body: LOGIN_MD, path: "flow.md" }],
    group: ["auth"],
    name: "login",
    platform: "android",
    recordings: [
      {
        id: "rec_9Fq1",
        keyframes: 17,
        phase: "Cleaned up",
        when: "2 days ago",
      },
    ],
    runs: [
      {
        assessment: "working",
        explanation:
          "Signed in and Welcome back showed. The password screen is secure, so it is hidden in the video.",
        findings: [
          { outcome: "working", text: "Welcome back showed after sign-in." },
        ],
        flows: ["login"],
        id: "run_A7nn",
        kind: "Dry Run",
        platform: "android",
        title: "Dry Run of login",
        video: [
          a(7, "Open Contingency Public Login"),
          a(6, "Enter qa@example.com"),
          { kind: "hidden", label: "Secure screen", real: 9 },
          a(5, "Tap Sign in"),
          idle(12),
        ],
        when: "2 days ago",
      },
    ],
    scope: "local",
    stamped: [
      ["Target App", "com.contingency.publiclogin · 1.4.0"],
      ["Emulation", "Pixel_9 · Android 16 · portrait"],
      ["Starting Data", "Clear"],
    ],
    verified: true,
  },
  {
    description: "Create a new account and finish the first-run tour.",
    files: [{ body: ONBOARDING_MD, path: "flow.md" }],
    group: [],
    name: "onboarding",
    platform: "ios",
    recordings: [
      {
        id: "rec_3Vw8",
        keyframes: 33,
        phase: "Learned, Dry Run next",
        when: "1 hour ago",
      },
    ],
    runs: [
      {
        assessment: "not-working",
        explanation:
          "The plan picker offered Starter and Pro, but the drafted Flow still said Free. The Flow was edited after this Dry Run.",
        findings: [
          {
            outcome: "not-working",
            text: "Step 3 asked for a Free plan the app does not offer.",
          },
        ],
        flows: ["onboarding"],
        id: "run_N4cs",
        kind: "Dry Run",
        platform: "ios",
        title: "Dry Run of onboarding",
        video: [
          a(6, "Open the app"),
          a(8, "Tap Create account"),
          a(9, "Enter a new email"),
          idle(26),
          a(4, "Look for the Free plan"),
        ],
        when: "40 minutes ago",
      },
    ],
    scope: "local",
    stamped: [
      ["Target App", "dev.contingency.onboarding · 0.9.2"],
      ["Emulation", "iPhone 17 · iOS 26.5"],
      ["Starting Data", "Clear"],
    ],
    verified: false,
  },
  {
    description: "Turn on dark mode in the app settings.",
    files: [{ body: SETTINGS_MD, path: "flow.md" }],
    group: ["account"],
    name: "settings",
    platform: "android",
    recordings: [
      {
        id: "rec_6Tz4",
        keyframes: 12,
        phase: "Learned, Dry Run next",
        when: "10 minutes ago",
      },
    ],
    runs: [],
    scope: "local",
    stamped: [
      ["Target App", "com.contingency.publiclogin · 1.4.0"],
      ["Emulation", "Pixel_9 · Android 16 · portrait"],
    ],
    verified: false,
  },
  {
    description: "Sign in through the company identity provider.",
    files: [{ body: SSO_MD, path: "flow.md" }],
    group: [],
    name: "sign-in-sso",
    platform: "web",
    recordings: [],
    runs: [],
    scope: "global",
    stamped: [
      ["Hosts", "app.example.com · login.example.com"],
      ["Emulation", "Desktop 1440×900 · en-US"],
    ],
    verified: true,
  },
];

/** Runs that used no Flow, or several, belong to the Catalog Root itself. */
const ROOT_RUNS: readonly Run[] = [
  {
    assessment: "working",
    explanation:
      "Found a red wool jacket in size M for $74 and added it to the cart. Stopped before paying, as asked.",
    findings: [
      { outcome: "working", text: "Cart holds one Red Wool Jacket, M, $74." },
    ],
    flows: [],
    id: "run_R3dj",
    kind: "Interactive Run",
    modifications: ["Mocked /api/recommendations with an empty list"],
    platform: "web",
    title: "Find a red jacket under $80",
    video: [
      a(5, "Search for red jacket"),
      idle(15),
      a(6, "Filter to size M, under $80"),
      idle(19, "Waiting on Domain Scope"),
      a(7, "Open Red Wool Jacket"),
      a(4, "Add to cart"),
    ],
    when: "1 hour ago",
  },
  {
    assessment: "blocked",
    explanation:
      "search passed. checkout stopped at sign-in: the password Variable was refused.",
    findings: [
      { outcome: "working", text: "search: results matched the filters." },
      { outcome: "blocked", text: "checkout: no password was supplied." },
    ],
    flows: ["search", "checkout"],
    id: "run_P9mm",
    kind: "Interactive Run",
    platform: "web",
    title: "Search, then check out the first result",
    video: [
      a(5, "Search for jacket"),
      a(6, "Filter to size M"),
      idle(31, "Waiting on password"),
    ],
    when: "yesterday",
  },
];

const playback = (s: Segment) =>
  s.kind === "idle" ? Math.min(2, s.real / 10) : s.real;
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const realLength = (run: Run) => run.video.reduce((t, s) => t + s.real, 0);

/* ------------------------------------------------------------------- inline */

/** A tiny markdown renderer: enough for a Flow's entry and supporting docs. */
const inline = (text: string, onLink: (href: string) => void): ReactNode[] =>
  text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**"))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link)
      return (
        <button
          className="md-link"
          key={i}
          onClick={() => onLink(link[2] ?? "")}
          type="button"
        >
          {link[1]}
        </button>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });

const Markdown = ({
  source,
  onLink,
}: {
  readonly source: string;
  readonly onLink: (href: string) => void;
}) => {
  const out: ReactNode[] = [];
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(<h3 key={i}>{line.slice(3)}</h3>);
      i++;
    } else if (line.startsWith("# ")) {
      // The title is already the pane's heading.
      i++;
    } else if (/^\d+\. /.test(line)) {
      const items: { text: string; done?: string }[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? "")) {
        const item: { text: string; done?: string } = {
          text: (lines[i] ?? "").replace(/^\d+\. /, ""),
        };
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "")) {
          const more = (lines[i] ?? "").trim();
          if (more.startsWith("Done when:")) item.done = more.slice(10).trim();
          else item.text += ` ${more}`;
          i++;
        }
        items.push(item);
      }
      out.push(
        <ol className="md-steps" key={`ol${i}`}>
          {items.map((item, n) => (
            <li key={n}>
              <span aria-hidden="true" className="md-step-num">
                {n + 1}
              </span>
              <div>
                <p>{inline(item.text, onLink)}</p>
                {item.done ? (
                  <p className="md-done">
                    <span>Done when</span> {inline(item.done, onLink)}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      );
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
        items.push((lines[i] ?? "").slice(2));
        i++;
      }
      out.push(
        <ul className="md-list" key={`ul${i}`}>
          {items.map((t, n) => (
            <li key={n}>{inline(t, onLink)}</li>
          ))}
        </ul>
      );
    } else {
      out.push(<p key={i}>{inline(line, onLink)}</p>);
      i++;
    }
  }
  return <div className="md">{out}</div>;
};

/* ------------------------------------------------------------------ sidebar */

const FlowMark = ({ flow }: { readonly flow: Flow }) =>
  flow.verified ? (
    <span className="flow-mark verified" title="Verified">
      <VerifiedIcon />
    </span>
  ) : (
    <span className="flow-mark" title="Drafted">
      <DraftIcon />
    </span>
  );

interface Node {
  readonly value: string;
  readonly label: string;
  readonly flow?: Flow;
  readonly children?: readonly Node[];
}

const toTree = (flows: readonly Flow[], scope: Scope): Node[] => {
  const groups = new Map<string, Flow[]>();
  const top: Node[] = [];
  for (const flow of flows) {
    const g = flow.group[0];
    if (g === undefined)
      top.push({ flow, label: flow.name, value: `${scope}:${flow.name}` });
    else groups.set(g, [...(groups.get(g) ?? []), flow]);
  }
  return [
    ...[...groups].map(([g, list]) => ({
      children: list.map((flow) => ({
        flow,
        label: flow.name,
        value: `${scope}:${flow.name}`,
      })),
      label: g,
      value: `${scope}/group:${g}`,
    })),
    ...top,
  ];
};

const TreeRows = ({
  nodes,
  sessionFlow,
}: {
  readonly nodes: readonly Node[];
  readonly sessionFlow: string | undefined;
}) =>
  nodes.map((node) => {
    const { flow } = node;
    const Icon = flow ? PLATFORM[flow.platform].Icon : null;
    return (
      <TreeItem key={node.value} value={node.value}>
        <TreeItemLabel className="tree-row">
          {node.children ? (
            <>
              <TreeItemIndicator className="tree-chev">
                <ChevronIcon />
              </TreeItemIndicator>
              <span className="tree-glyph">
                <FolderIcon />
              </span>
              <span className="tree-name">{node.label}</span>
              <span className="tree-count">{node.children.length}</span>
            </>
          ) : flow && Icon ? (
            <>
              <span className="tree-glyph" title={PLATFORM[flow.platform].name}>
                <Icon />
              </span>
              <span className="tree-name">{node.label}</span>
              {sessionFlow === flow.name ? (
                <span className="tree-tag">This session</span>
              ) : null}
              <FlowMark flow={flow} />
            </>
          ) : null}
        </TreeItemLabel>
        {node.children ? (
          <TreeGroup>
            <TreeRows nodes={node.children} sessionFlow={sessionFlow} />
          </TreeGroup>
        ) : null}
      </TreeItem>
    );
  });

const Sidebar = ({
  flows,
  selected,
  sessionFlow,
  onSelect,
}: {
  readonly flows: readonly Flow[];
  readonly selected: string;
  readonly sessionFlow: string | undefined;
  readonly onSelect: (value: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const match = (f: Flow) => f.name.includes(query.trim().toLowerCase());
  const local = flows.filter((f) => f.scope === "local" && match(f));
  const global = flows.filter((f) => f.scope === "global" && match(f));
  const groups = toTree(local, "local")
    .filter((n) => n.children)
    .map((n) => n.value);
  const tree = (scope: Scope, list: readonly Flow[]) => (
    <Tree
      aria-label={`${scope === "local" ? "Local" : "Global"} Flows`}
      className="tree"
      // Searching opens every Group so a match is never hidden in one.
      defaultExpanded={groups}
      key={query === "" ? "all" : "search"}
      onValueChange={(value: string | null) => {
        if (value && !value.includes("/group:")) onSelect(value);
      }}
      value={selected}
    >
      <TreeRows nodes={toTree(list, scope)} sessionFlow={sessionFlow} />
    </Tree>
  );
  return (
    <aside aria-label="Catalog" className="flows-sidebar island">
      <div className="sidebar-head">
        <h1>Flows</h1>
        <span className="count quiet">{flows.length}</span>
      </div>
      <label className="search">
        <SearchIcon />
        <Input
          aria-label="Search Flows"
          className="search-input"
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search Flows"
          value={query}
        />
      </label>
      <div className="sidebar-scroll">
        <section aria-labelledby="root-local" className="root">
          <h2 className="root-head" id="root-local">
            contingency/ <span className="hint">Local</span>
          </h2>
          {local.length > 0 ? (
            tree("local", local)
          ) : (
            <p className="hint root-empty">No Flow matches.</p>
          )}
          {query === "" && ROOT_RUNS.length > 0 ? (
            <button
              aria-pressed={selected === "local:@root"}
              className="tree-row root-runs"
              onClick={() => onSelect("local:@root")}
              type="button"
            >
              <span className="tree-glyph">
                <RecordIcon />
              </span>
              <span className="tree-name">Runs without one Flow</span>
              <span className="tree-count">{ROOT_RUNS.length}</span>
            </button>
          ) : null}
        </section>
        <Collapsible className="root" defaultOpen={false}>
          <CollapsibleTrigger className="root-head root-toggle">
            <span className="tree-chev">
              <ChevronIcon />
            </span>
            ~/.contingency <span className="hint">Global · read-only</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {global.length > 0 ? (
              tree("global", global)
            ) : (
              <p className="hint root-empty">No Flow matches.</p>
            )}
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </aside>
  );
};

/* --------------------------------------------------------------- doc pane */

const DocPane = ({
  flow,
  scope,
}: {
  readonly flow: Flow;
  readonly scope: Scope;
}) => {
  const [file, setFile] = useState("flow.md");
  const Icon = PLATFORM[flow.platform].Icon;
  return (
    <section aria-labelledby="doc-title" className="pane doc-pane island">
      <header className="pane-head">
        <div className="chips">
          {flow.verified ? (
            <span className="chip" data-status="ready">
              <VerifiedIcon />
              Verified
            </span>
          ) : (
            <span className="chip" data-status="draft">
              <DraftIcon />
              Drafted
            </span>
          )}
          <span className="chip" data-status="neutral">
            <Icon />
            {PLATFORM[flow.platform].name}
          </span>
          {scope === "global" ? (
            <span className="chip" data-status="neutral">
              Global
            </span>
          ) : null}
        </div>
        <h2 className="mono" id="doc-title">
          {[...flow.group, flow.name].join(" / ")}
        </h2>
        <dl className="stamped" title="Stamped by Contingency">
          {flow.stamped.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </header>
      <Tabs
        className="doc-tabs"
        onValueChange={(v: string | null) => {
          if (v) setFile(v);
        }}
        value={file}
      >
        <TabsList aria-label="Flow files" className="file-tabs">
          {flow.files.map((f) => (
            <TabsTab className="file-tab" key={f.path} value={f.path}>
              <FileIcon />
              {f.path}
            </TabsTab>
          ))}
        </TabsList>
        {flow.files.map((f) => (
          <TabsPanel className="pane-body" key={f.path} value={f.path}>
            <Markdown
              onLink={(href) => {
                if (flow.files.some((x) => x.path === href)) setFile(href);
              }}
              source={f.body}
            />
          </TabsPanel>
        ))}
      </Tabs>
    </section>
  );
};

const RootDocPane = ({ run }: { readonly run: Run | undefined }) => (
  <section aria-labelledby="doc-title" className="pane doc-pane island">
    <header className="pane-head">
      <div className="chips">
        <span className="chip" data-status="neutral">
          Catalog Root
        </span>
      </div>
      <h2 className="mono" id="doc-title">
        Runs without one Flow
      </h2>
      <p className="lede">
        An Interactive Run that used no Flow, or several, belongs to the Catalog
        Root itself.
      </p>
    </header>
    {run ? (
      <div className="pane-body md">
        <h3>Requested task</h3>
        <p>{run.title}.</p>
        <h3>Flows it used</h3>
        {run.flows.length === 0 ? (
          <p className="hint">None. The agent worked from the task alone.</p>
        ) : (
          <ul className="md-list">
            {run.flows.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null}
  </section>
);

/* ---------------------------------------------------------------- video */

/** Where playback time `t` falls: its span, how far into it, and real time. */
const locate = (run: Run, t: number) => {
  let start = 0;
  let realBefore = 0;
  for (const s of run.video) {
    const len = playback(s);
    if (t < start + len || s === run.video.at(-1)) {
      const into = Math.min(1, Math.max(0, (t - start) / len));
      return { current: s, into, realNow: realBefore + s.real * into };
    }
    start += len;
    realBefore += s.real;
  }
  return { current: undefined, into: 0, realNow: 0 };
};

/** One frame of the Run video, for the player and the seek preview. */
const Frame = ({
  native,
  current,
  realNow,
}: {
  readonly native: boolean;
  readonly current: Segment | undefined;
  readonly realNow: number;
}) => (
  <>
    {native ? (
      <div className="phone">
        <div className="bar" style={{ width: "40%" }} />
        <div className="card" />
        <div className="bar" />
        <div className="bar" style={{ width: "70%" }} />
      </div>
    ) : (
      <div className="mini-page">
        <div className="bar" style={{ width: "28%" }} />
        <div className="hero-block" />
        <div className="grid">
          <div />
          <div />
          <div />
        </div>
      </div>
    )}
    {current?.kind === "action" && !native ? (
      <span
        aria-hidden="true"
        className="agent-cursor"
        style={{
          left: `${20 + ((realNow * 37) % 60)}%`,
          top: `${30 + ((realNow * 23) % 50)}%`,
        }}
      >
        <PointerIcon />
      </span>
    ) : null}
    {current?.kind === "hidden" ? (
      <div className="video-veil">
        <EyeOffIcon />
        <span className="veil-text">Hidden: secure screen</span>
      </div>
    ) : null}
    {current?.kind === "idle" ? (
      <span className="video-badge">
        <ForwardIcon />
        Fast-forwarded {clock(current.real)}
      </span>
    ) : null}
    {current?.kind === "takeover" ? (
      <span className="video-badge" data-tone="takeover">
        <PointerIcon />
        You had control
      </span>
    ) : null}
  </>
);

const KIND: Record<Segment["kind"], string> = {
  action: "Agent action",
  hidden: "Hidden Interval",
  idle: "Idle Gap",
  takeover: "Takeover",
};

const Video = ({ run }: { readonly run: Run }) => {
  const total = run.video.reduce((t, s) => t + playback(s), 0);
  /** The pointer over the seek bar: its x in the track, and the time there. */
  const [hover, setHover] = useState<{
    readonly x: number;
    readonly width: number;
    readonly t: number;
  } | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(
      () =>
        setT((x) => {
          if (x + 0.1 >= total) {
            setPlaying(false);
            return total;
          }
          return x + 0.1;
        }),
      100
    );
    return () => clearInterval(id);
  }, [playing, total]);

  const { current, realNow } = locate(run, t);
  const native = run.platform !== "web";
  const peek = hover ? locate(run, hover.t) : null;

  return (
    <div className="video">
      <div className="video-frame" data-native={native || undefined}>
        <div className="video-screen">
          <Frame current={current} native={native} realNow={realNow} />
          {!playing && t === 0 ? (
            <button
              aria-label="Play Run video"
              className="video-big-play"
              onClick={() => setPlaying(true)}
              type="button"
            >
              <PlayIcon />
            </button>
          ) : null}
        </div>
        <p className="video-caption" aria-live="off">
          {current?.label}
        </p>
      </div>
      <div className="video-controls">
        <Button
          aria-label={playing ? "Pause" : "Play"}
          className="icon-btn"
          onClick={() => {
            if (t >= total) setT(0);
            setPlaying(!playing);
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Slider
          className="scrub"
          max={total}
          min={0}
          onValueChange={(v: number) => {
            setPlaying(false);
            setT(v);
          }}
          step={0.1}
          value={t}
        >
          <SliderControl
            className="scrub-control"
            onPointerLeave={() => setHover(null)}
            onPointerMove={(e) => {
              const track = e.currentTarget.querySelector(".scrub-track");
              if (!(track instanceof HTMLElement)) return;
              const box = track.getBoundingClientRect();
              const x = Math.min(box.width, Math.max(0, e.clientX - box.left));
              setHover({ t: (x / box.width) * total, width: box.width, x });
            }}
          >
            <SliderTrack className="scrub-track">
              <span aria-hidden="true" className="scrub-segments">
                {run.video.map((s, i) => (
                  <span
                    data-kind={s.kind}
                    key={i}
                    style={{ flexGrow: playback(s) }}
                  />
                ))}
              </span>
              <SliderIndicator className="scrub-fill" />
              {hover && peek ? (
                // Pointer-only preview; the thumb's value text covers keyboard
                // and screen reader users.
                <span
                  aria-hidden="true"
                  className="scrub-peek island"
                  data-native={native || undefined}
                  style={{
                    left: `clamp(var(--peek-half), ${hover.x}px, ${hover.width}px - var(--peek-half))`,
                  }}
                >
                  <span className="peek-frame video-screen">
                    <Frame
                      current={peek.current}
                      native={native}
                      realNow={peek.realNow}
                    />
                  </span>
                  <span className="peek-text">
                    <span className="peek-label">{peek.current?.label}</span>
                    <span className="peek-meta">
                      <span className="mono">{clock(peek.realNow)}</span>
                      {peek.current ? (
                        <span
                          className="peek-kind"
                          data-kind={peek.current.kind}
                        >
                          {KIND[peek.current.kind]}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </span>
              ) : null}
              {hover ? (
                <span
                  aria-hidden="true"
                  className="scrub-hover-line"
                  style={{ left: hover.x }}
                />
              ) : null}
              <SliderThumb
                aria-label="Seek"
                className="scrub-thumb"
                aria-valuetext={`${clock(realNow)} of the Run`}
              />
            </SliderTrack>
          </SliderControl>
        </Slider>
        <span className="mono video-time">
          {clock(realNow)} / {clock(realLength(run))}
        </span>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------- runs */

type Entry =
  | { readonly kind: "run"; readonly run: Run }
  | { readonly kind: "recording"; readonly recording: Recording };

const AssessmentChip = ({ value }: { readonly value: Assessment }) => (
  <span className="chip" data-assessment={value}>
    <span aria-hidden="true" className="dot" />
    {ASSESSMENT[value]}
  </span>
);

const RunSummary = ({
  run,
  onFlow,
}: {
  readonly run: Run;
  readonly onFlow: (name: string) => void;
}) => (
  <article aria-label="Run Summary" className="summary">
    <Video key={run.id} run={run} />
    <div className="summary-head">
      <AssessmentChip value={run.assessment} />
      <span className="hint">
        {run.kind} · {PLATFORM[run.platform].name} · {run.when} ·{" "}
        {clock(realLength(run))}
      </span>
    </div>
    <h3 className="summary-title">{run.title}</h3>
    <p className="summary-text">{run.explanation}</p>
    <section aria-label="Findings" className="findings">
      <h4 className="eyebrow">
        {run.findings.length === 1
          ? "1 finding"
          : `${run.findings.length} findings`}
      </h4>
      <ul>
        {run.findings.map((f) => (
          <li key={f.text}>
            <AssessmentChip value={f.outcome} />
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </section>
    {run.modifications ? (
      <section aria-label="Browser Modifications" className="findings">
        <h4 className="eyebrow">Browser Modifications</h4>
        <ul>
          {run.modifications.map((m) => (
            <li key={m}>
              <span className="mono mod">{m}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
    {run.flows.length > 1 ? (
      <section aria-label="Flows" className="findings">
        <h4 className="eyebrow">Flows</h4>
        <div className="chips">
          {run.flows.map((f) => (
            <Button className="flow-pill" key={f} onClick={() => onFlow(f)}>
              {f}
            </Button>
          ))}
        </div>
      </section>
    ) : null}
    <footer className="summary-foot">
      <code className="run-id">{run.id}</code>
      {run.kind === "Dry Run" ? (
        <span className="hint">
          A Dry Run's evidence stays with its Teaching Recording.
        </span>
      ) : (
        <Button className="pill-btn">
          <ExternalIcon />
          Open full Run Summary
        </Button>
      )}
    </footer>
  </article>
);

const RecordingSummary = ({ recording }: { readonly recording: Recording }) => (
  <article aria-label="Teaching Recording" className="summary">
    <div className="summary-head">
      <span className="chip" data-status="neutral">
        <RecordIcon />
        Teaching Recording
      </span>
      <span className="hint">
        Taught {recording.when} · {recording.keyframes} keyframes
      </span>
    </div>
    <h3 className="summary-title mono">{recording.id}</h3>
    <p className="callout">
      {recording.phase === "Cleaned up"
        ? "Cleanup removed the video, Trace and events after the Flow was verified. Only the manifest is left."
        : "Sensitive learning evidence. Cleanup deletes it once you verify the Flow, after a passing Dry Run."}
    </p>
  </article>
);

const RunsPane = ({
  entries,
  onFlow,
  emptyNote,
  onShow,
}: {
  readonly entries: readonly Entry[];
  readonly onFlow: (name: string) => void;
  readonly emptyNote: string;
  readonly onShow?: (id: string) => void;
}) => {
  const id = (e: Entry) => (e.kind === "run" ? e.run.id : e.recording.id);
  const [selected, setSelected] = useState(() =>
    entries[0] ? id(entries[0]) : ""
  );
  const current = entries.find((e) => id(e) === selected) ?? entries[0];
  const runs = entries.filter((e) => e.kind === "run").length;
  return (
    <section aria-labelledby="runs-title" className="pane runs-pane island">
      <header className="pane-head row">
        <h2 id="runs-title">Runs</h2>
        <span className="count quiet">{runs}</span>
      </header>
      {entries.length === 0 ? (
        <div className="pane-empty">
          <span className="glyph-box">
            <RecordIcon />
          </span>
          <p>{emptyNote}</p>
        </div>
      ) : (
        <>
          <ul aria-label="Runs and recordings" className="run-list">
            {entries.map((e) => (
              <li key={id(e)}>
                <Button
                  aria-pressed={id(e) === id(current ?? e)}
                  className="run-row"
                  onClick={() => {
                    setSelected(id(e));
                    onShow?.(id(e));
                  }}
                >
                  {e.kind === "run" ? (
                    <>
                      <AssessmentChip value={e.run.assessment} />
                      <span className="option-text">
                        <span className="opt-title">{e.run.title}</span>
                        <span className="opt-sub">
                          {e.run.kind} · {e.run.when}
                        </span>
                      </span>
                      <span className="mono hint">
                        {clock(realLength(e.run))}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="chip" data-status="neutral">
                        <RecordIcon />
                        Recording
                      </span>
                      <span className="option-text">
                        <span className="opt-title">{e.recording.phase}</span>
                        <span className="opt-sub">
                          Teaching · {e.recording.when}
                        </span>
                      </span>
                      <span />
                    </>
                  )}
                </Button>
              </li>
            ))}
          </ul>
          <div className="pane-body">
            {current?.kind === "run" ? (
              <RunSummary onFlow={onFlow} run={current.run} />
            ) : current ? (
              <RecordingSummary recording={current.recording} />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
};

/* ------------------------------------------------------------------- page */

export const FlowsPage = ({
  nav,
  actions,
  selected,
  onSelect,
  sessionFlow,
  empty,
}: {
  readonly nav: ReactNode;
  readonly actions: ReactNode;
  /** `<scope>:<name>`, or `local:@root` for the Catalog Root's own Runs. */
  readonly selected: string | undefined;
  readonly onSelect: (value: string) => void;
  readonly sessionFlow: string | undefined;
  readonly empty: boolean;
}) => {
  const flows = empty ? [] : FLOWS;
  const value =
    selected ??
    (sessionFlow && flows.some((f) => f.name === sessionFlow)
      ? `local:${sessionFlow}`
      : flows[0]
        ? `${flows[0].scope}:${flows[0].name}`
        : "");
  const [scope, name] = value.split(":") as [Scope, string];
  const flow = flows.find((f) => f.scope === scope && f.name === name);
  const openFlow = (n: string) => onSelect(`local:${n}`);

  return (
    <>
      {nav}
      {actions}
      {flows.length === 0 ? (
        <main className="flows-empty">
          <div className="island empty-card">
            <span className="glyph-box">
              <FolderIcon />
            </span>
            <h1>No Flows in contingency/ yet</h1>
            <p>
              Teach one from the Workspace home. Its Flow, Teaching Recordings
              and Runs all show up here.
            </p>
          </div>
        </main>
      ) : (
        <>
          <Sidebar
            flows={flows}
            onSelect={onSelect}
            selected={value}
            sessionFlow={sessionFlow}
          />
          <main className="flows-main" key={value}>
            {name === "@root" ? (
              <RootPanes onFlow={openFlow} />
            ) : flow ? (
              <>
                <DocPane flow={flow} scope={scope} />
                <RunsPane
                  emptyNote={
                    flow.scope === "global"
                      ? "This Flow's Runs stay in ~/.contingency. Open them from a Workspace that uses that root."
                      : "No Runs yet. Ask your agent to Dry Run this Flow."
                  }
                  entries={[
                    ...flow.runs.map((run) => ({ kind: "run" as const, run })),
                    ...flow.recordings.map((recording) => ({
                      kind: "recording" as const,
                      recording,
                    })),
                  ]}
                  onFlow={openFlow}
                />
              </>
            ) : null}
          </main>
        </>
      )}
    </>
  );
};

const RootPanes = ({ onFlow }: { readonly onFlow: (name: string) => void }) => {
  // The task pane follows whichever root Run the runs pane shows.
  const [shown, setShown] = useState(ROOT_RUNS[0]?.id);
  return (
    <>
      <RootDocPane run={ROOT_RUNS.find((r) => r.id === shown)} />
      <RunsPane
        emptyNote=""
        entries={ROOT_RUNS.map((run) => ({ kind: "run" as const, run }))}
        onFlow={onFlow}
        onShow={setShown}
      />
    </>
  );
};
