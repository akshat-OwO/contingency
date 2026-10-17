import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { usePresence } from "@/hooks/use-presence";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // jsdom has no Web Animations API; a test that installs one removes it.
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

/**
 * An animation whose finish the test decides. Like a browser's, it hands out
 * a new `finished` promise whenever it starts playing again; `finish` settles
 * every promise it has handed out, so a stale one resolving late is covered.
 */
class HeldAnimation {
  playbackRate = 1;
  currentTime: CSSNumberish | null = 0;
  cancelled = false;
  readonly effect = { updateTiming: vi.fn() };
  finished: Promise<HeldAnimation>;
  private readonly pending: (() => void)[] = [];

  readonly keyframes: Keyframe[];

  constructor(keyframes: Keyframe[]) {
    this.keyframes = keyframes;
    this.finished = this.nextFinish();
  }

  cancel(): void {
    this.cancelled = true;
  }

  reverse(): void {
    this.playbackRate = -this.playbackRate;
    this.finished = this.nextFinish();
  }

  finish(): void {
    for (const settle of this.pending.splice(0)) {
      settle();
    }
  }

  private nextFinish(): Promise<HeldAnimation> {
    const { promise, resolve } = Promise.withResolvers<HeldAnimation>();
    this.pending.push(() => resolve(this));
    return promise;
  }
}

const installAnimations = () => {
  const animations: HeldAnimation[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: (keyframes: Keyframe[]) => {
      const animation = new HeldAnimation(keyframes);
      animations.push(animation);
      return animation;
    },
  });
  return animations;
};

const motion = {
  durationMs: 200,
  shown: { opacity: 1, transform: "none" },
};

const Surface = ({
  edge = "right",
  value,
}: {
  readonly edge?: "bottom" | "right";
  readonly value: string | undefined;
}) => {
  // A fresh motion object on every render, as callers build them.
  const { leaving, ref, rendered } = usePresence(value, {
    ...motion,
    hidden: {
      opacity: 0,
      transform: edge === "right" ? "translateX(100%)" : "translateY(100%)",
    },
  });
  return rendered === undefined ? null : (
    <section aria-label="Surface" data-leaving={leaving} ref={ref}>
      {rendered}
    </section>
  );
};

test("stays drawn with its last value until its exit finishes", async () => {
  const animations = installAnimations();
  const { rerender } = render(<Surface value="Request details" />);
  expect(animations).toHaveLength(1);

  rerender(<Surface value={undefined} />);
  const surface = screen.getByRole("region", { name: "Surface" });
  expect(surface).toHaveTextContent("Request details");
  expect(surface).toHaveAttribute("data-leaving", "true");
  expect(animations[0]?.playbackRate).toBe(-1);

  await act(async () => {
    animations[0]?.finish();
    await animations[0]?.finished;
  });
  expect(screen.queryByRole("region", { name: "Surface" })).toBeNull();
});

test("turns around from where it is when reopened mid-exit", async () => {
  const animations = installAnimations();
  const { rerender } = render(<Surface value="Emulation" />);
  rerender(<Surface value={undefined} />);
  const leavingFinish = animations[0]?.finished;

  rerender(<Surface value="Emulation" />);
  // The exit's own animation reverses again; no fresh entrance restarts it.
  expect(animations).toHaveLength(1);
  expect(animations[0]?.playbackRate).toBe(1);

  await act(async () => {
    animations[0]?.finish();
    await leavingFinish;
  });
  expect(screen.getByRole("region", { name: "Surface" })).toHaveAttribute(
    "data-leaving",
    "false"
  );
});

test("leaves at once where the browser cannot animate", () => {
  const { rerender } = render(<Surface value="Stream" />);
  rerender(<Surface value={undefined} />);
  expect(screen.queryByRole("region", { name: "Surface" })).toBeNull();
});

test("leaves towards the edge its layout docks it to when it closes", () => {
  const animations = installAnimations();
  const { rerender } = render(<Surface value="Skills" />);
  rerender(<Surface value="Skills" />);
  // An equal motion rebuilt by the caller keeps the running animation.
  expect(animations).toHaveLength(1);

  // The window narrows and the layout stacks while the surface is open.
  rerender(<Surface edge="bottom" value="Skills" />);
  rerender(<Surface edge="bottom" value={undefined} />);

  expect(animations).toHaveLength(2);
  expect(animations[0]?.cancelled).toBe(true);
  expect(animations[1]?.keyframes[0]).toMatchObject({
    transform: "translateY(100%)",
  });
  expect(animations[1]?.playbackRate).toBe(-1);
});
