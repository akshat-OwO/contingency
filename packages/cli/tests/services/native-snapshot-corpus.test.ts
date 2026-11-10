// Replays real agent-device accessibility trees through Contingency's native
// observation rules. The trees come from the widget corpus apps and from apps
// that ship with the simulator and emulator, captured by
// `.cursor/skills/verify-contingency/bin/native-snapshot-capture.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  androidNodeInteraction,
  androidNodeName,
  COLLECTION_KINDS,
} from "../../src/services/android-observation.ts";
import {
  iosNodeInteraction,
  iosNodeName,
} from "../../src/services/ios-observation.ts";
import { nativeHitTest } from "../../src/services/native-app-hit-test.ts";

interface CapturedNode {
  readonly index: number;
  readonly ref: string;
  readonly kind?: string;
  readonly type?: string;
  readonly role?: string;
  readonly label?: string;
  readonly value?: string;
  readonly identifier?: string;
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly enabled?: boolean;
  readonly editable?: boolean;
  readonly password?: boolean;
  readonly hittable?: boolean;
  readonly depth?: number;
  readonly interactionBlocked?: "covered";
}

interface Capture {
  readonly id: string;
  readonly platform: "ios" | "android";
  readonly source: {
    readonly app: string;
    readonly corpus: boolean;
    readonly screen: string;
  };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly nodes: readonly CapturedNode[];
}

const directory = path.join(
  import.meta.dirname,
  "../fixtures/native-snapshots"
);
const load = (platform: "ios" | "android"): Capture[] =>
  readdirSync(path.join(directory, platform))
    .filter((file) => file.endsWith(".json"))
    .toSorted()
    .map((file) => ({
      // SAFETY: the capture script writes exactly this shape, and the
      // assertions below fail by name on any node field they read.
      ...(JSON.parse(
        readFileSync(path.join(directory, platform, file), "utf-8")
      ) as Omit<Capture, "id">),
      id: file.replace(/\.json$/u, ""),
    }));

/** The iOS runtime's observation, minus the screenshot scale (1:1 here). */
const observeIos = (capture: Capture) =>
  capture.nodes.map((node, index) => {
    const observed: ReturnType<typeof iosNodeInteraction> & {
      bounds?: NonNullable<CapturedNode["rect"]>;
      device: CapturedNode;
      name: string;
    } = {
      ...iosNodeInteraction(node),
      device: node,
      name: iosNodeName(capture.nodes, index),
    };
    if (node.rect !== undefined) {
      observed.bounds = node.rect;
    }
    return observed;
  });

const center = (rect: NonNullable<CapturedNode["rect"]>) => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});
const onScreen = (
  rect: CapturedNode["rect"],
  viewport: Capture["viewport"]
): rect is NonNullable<CapturedNode["rect"]> => {
  if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const { x, y } = center(rect);
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
};

const ios = load("ios");
const corpus = (screen: string) => {
  const capture = ios.find(
    (candidate) => candidate.source.corpus && candidate.source.screen === screen
  );
  if (capture === undefined) {
    throw new Error(`No iOS corpus capture for ${screen}`);
  }
  return capture;
};
/** What a Workspace click at a control's center teaches. */
const teach = (capture: Capture, role: string, name: string) => {
  const observed = observeIos(capture);
  const control = observed.find(
    (node) => node.role === role && node.name === name
  );
  if (control?.bounds === undefined) {
    return { found: false } as const;
  }
  const { x, y } = center(control.bounds);
  const hit = nativeHitTest(observed, x, y);
  return {
    covered: control.covered,
    found: true,
    taught: hit === undefined ? null : `${hit.role} ${hit.name}`,
  } as const;
};

describe("iOS widget corpus", () => {
  it.each([
    ["controls", "button", "Show alert"],
    ["controls", "switch", "Notifications"],
    ["controls", "button", "Medium"],
    ["controls", "slider", "Volume"],
    ["controls", "button", "Quantity, Increment"],
    ["controls", "button", "Favorite"],
    ["controls", "button", "Continue"],
    ["controls", "button", "Date Picker"],
    ["controls", "text-field", "Email"],
    ["controls", "text-field", "Postal code"],
    ["controls", "secure-text-field", "Card PIN"],
    ["controls", "button", "List"],
    ["list", "cell", "Anvil, $7.00"],
    ["list", "cell", "Product 1, $7.00"],
    ["list", "button", "Edit"],
    ["web", "link", "Shipping FAQ"],
    ["web", "text-field", "Coupon"],
    ["web", "button", "Apply coupon"],
    ["alert", "button", "Remove"],
    ["action-sheet", "button", "Copy link"],
    ["modal", "button", "Close promo"],
  ])("teaches %s %s %j from a click at its center", (screen, role, name) => {
    expect(teach(corpus(screen), role, name)).toEqual({
      covered: false,
      found: true,
      taught: `${role} ${name}`,
    });
  });

  it("refuses a disabled control without dropping it from the observation", () => {
    expect(teach(corpus("controls"), "button", "Unavailable")).toMatchObject({
      covered: true,
      found: true,
    });
  });

  it("does not teach a container whose parts are the targets", () => {
    const observed = observeIos(corpus("controls"));
    for (const role of ["segmented-control", "stepper"]) {
      expect(
        observed.filter((node) => node.role === role && node.hittable)
      ).toEqual([]);
    }
  });
});

describe.each(ios.map((capture) => [capture.id, capture] as const))(
  "iOS capture %s",
  (_id, capture) => {
    const observed = observeIos(capture);

    it("never makes static text, images, or containers activatable", () => {
      expect(
        observed
          .filter(
            (node) =>
              node.hittable &&
              ["text", "image", "application", "other", "group"].includes(
                node.role
              )
          )
          .map((node) => `${node.role} ${node.name}`)
      ).toEqual([]);
    });

    it("marks every secure field private and carries none of its value", () => {
      for (const node of observed) {
        if (/secure/iu.test(`${node.device.kind}${node.device.type}`)) {
          expect(node.password).toBe(true);
          expect(node.device.value).toBeUndefined();
        }
      }
    });

    it("makes every on-screen cell with content teachable", () => {
      // A cell is taught by its own name, or through a named control inside
      // it that wins the click. A cell with no named content at all, such as
      // a decorative footer, has nothing a Flow could refer to.
      const unteachable = observed.flatMap((node, index) => {
        if (
          node.role !== "cell" ||
          node.covered ||
          node.name.trim() !== "" ||
          !onScreen(node.device.rect, capture.viewport)
        ) {
          return [];
        }
        const descendants = [];
        for (const child of observed.slice(index + 1)) {
          if ((child.device.depth ?? 0) <= (node.device.depth ?? 0)) {
            break;
          }
          descendants.push(child);
        }
        const content = descendants.some(
          (child) => (child.device.label ?? "").trim() !== ""
        );
        const namedControl = descendants.some(
          (child) => child.hittable && child.name.trim() !== ""
        );
        return content && !namedControl ? [node.device.ref] : [];
      });
      expect(unteachable).toEqual([]);
    });

    it("teaches each named on-screen control the device can activate", () => {
      const refused = observed.flatMap((node) => {
        if (
          !node.hittable ||
          node.covered ||
          node.name.trim() === "" ||
          !onScreen(node.device.rect, capture.viewport)
        ) {
          return [];
        }
        const { x, y } = center(node.device.rect);
        // A smaller named control inside this one wins the click; that is
        // still a teachable target, so only an empty hit is a refusal.
        return nativeHitTest(observed, x, y) === undefined
          ? [`${node.role} ${node.name}`]
          : [];
      });
      expect(refused).toEqual([]);
    });
  }
);

/** The Android runtime's observation of one captured tree. */
const observeAndroid = (capture: Capture) =>
  capture.nodes.map((node, index) => {
    const observed: ReturnType<typeof androidNodeInteraction> & {
      bounds?: NonNullable<CapturedNode["rect"]>;
      device: CapturedNode;
      name: string;
    } = {
      ...androidNodeInteraction(node),
      device: node,
      name: androidNodeName(capture.nodes, index),
    };
    if (node.rect !== undefined) {
      observed.bounds = node.rect;
    }
    return observed;
  });

const android = load("android");
const androidCorpus = (screen: string) => {
  const capture = android.find(
    (candidate) => candidate.source.corpus && candidate.source.screen === screen
  );
  if (capture === undefined) {
    throw new Error(`No Android corpus capture for ${screen}`);
  }
  return capture;
};
const teachAndroid = (capture: Capture, role: string, name: string) => {
  const observed = observeAndroid(capture);
  const control = observed.find(
    (node) => node.role === role && node.name === name
  );
  if (control?.bounds === undefined) {
    return { found: false } as const;
  }
  const { x, y } = center(control.bounds);
  const hit = nativeHitTest(observed, x, y);
  return {
    covered: control.covered,
    found: true,
    taught: hit === undefined ? null : `${hit.role} ${hit.name}`,
  } as const;
};

describe("Android widget corpus", () => {
  it.each([
    ["controls", "button", "SHOW ALERT"],
    ["controls", "switch", "Notifications"],
    ["controls", "checkbox", "Gift wrap"],
    ["controls", "radiobutton", "Express"],
    ["controls", "spinner", "Size"],
    ["controls", "seekbar", "Volume"],
    ["controls", "button", "Favorite"],
    ["controls", "button", "CONTINUE"],
    ["controls", "text-field", "Email"],
    ["controls", "text-field", "Card PIN"],
    ["controls", "autocompletetextview", "Search products"],
    ["controls", "group", "List"],
    ["list", "group", "Anvil, $7.00"],
    ["list", "text", "Product 3"],
    ["alert", "button", "REMOVE"],
    ["bottom-sheet", "button", "COPY LINK"],
    ["spinner-open", "text", "Medium"],
  ])("teaches %s %s %j from a click at its center", (screen, role, name) => {
    expect(teachAndroid(androidCorpus(screen), role, name)).toEqual({
      covered: false,
      found: true,
      taught: `${role} ${name}`,
    });
  });

  it("refuses a disabled control without dropping it from the observation", () => {
    expect(
      teachAndroid(androidCorpus("controls"), "button", "UNAVAILABLE")
    ).toMatchObject({ covered: true, found: true });
  });

  it.each([
    // A settings row whose switch lies past the viewport edge.
    ["settings", 521, 697, "group Gboard, English (US)"],
    // A card whose only child control is its "See more" link.
    [
      "chrome",
      400,
      1838,
      "group Continue with this tab, Example Domain, example.com",
    ],
  ])("teaches a %s row from its label text at %i,%i", (id, x, y, taught) => {
    const capture = android.find((candidate) => candidate.id === id);
    if (capture === undefined) {
      throw new Error(`No Android capture ${id}`);
    }
    const hit = nativeHitTest(observeAndroid(capture), x, y);
    expect(hit === undefined ? null : `${hit.role} ${hit.name}`).toBe(taught);
  });

  it.each([
    // Padding inside the controls ScrollView, beside no control.
    ["corpus-controls", 40, 240],
    // Chrome's full-screen frame, between its shortcut tiles.
    ["chrome", 4, 2400],
  ])("refuses a click in %s container padding at %i,%i", (id, x, y) => {
    const capture = android.find((candidate) => candidate.id === id);
    if (capture === undefined) {
      throw new Error(`No Android capture ${id}`);
    }
    const hit = nativeHitTest(observeAndroid(capture), x, y);
    expect(hit === undefined ? null : `${hit.role} ${hit.name}`).toBeNull();
  });
});

describe.each(android.map((capture) => [capture.id, capture] as const))(
  "Android capture %s",
  (_id, capture) => {
    const observed = observeAndroid(capture);

    it("marks every password field private and carries none of its value", () => {
      for (const node of observed) {
        if (node.device.password === true) {
          expect(node.password).toBe(true);
          expect(node.device.value).toBeUndefined();
        }
      }
    });

    it("teaches every visible label inside a clickable row", () => {
      // A tap on text a person can see inside a clickable row or card must
      // teach that row, or a named control within it. Text whose nearest
      // clickable ancestor is a scroll view or list is padding: refused.
      const unteachable = observed.flatMap((node, index) => {
        const label = (node.device.label ?? "").trim();
        if (
          node.role !== "text" ||
          label === "" ||
          node.covered ||
          !onScreen(node.device.rect, capture.viewport)
        ) {
          return [];
        }
        let depth = node.device.depth ?? 0;
        let row: (typeof observed)[number] | undefined;
        for (const ancestor of observed.slice(0, index).toReversed()) {
          const ancestorDepth = ancestor.device.depth ?? 0;
          if (ancestorDepth >= depth) {
            continue;
          }
          depth = ancestorDepth;
          if (ancestor.hittable || ancestor.editable) {
            row = ancestor;
            break;
          }
        }
        if (
          row === undefined ||
          row.covered ||
          COLLECTION_KINDS.has(row.role)
        ) {
          return [];
        }
        const { x, y } = center(node.device.rect);
        return nativeHitTest(observed, x, y) === undefined
          ? [`${label} in ${row.role} ${row.device.ref}`]
          : [];
      });
      expect(unteachable).toEqual([]);
    });
  }
);
