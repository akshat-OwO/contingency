const isHandle = (element: HTMLElement): boolean =>
  element.dataset.slot === "resizable-handle";

/** A panel's laid-out share as a fraction, once the group sizes it. */
const shareOf = (panel: HTMLElement): number | undefined => {
  const share = panel.style.getPropertyValue("--resizable-panel-size");
  return share === "" ? undefined : Number(share.replace("%", "")) / 100;
};

/**
 * jsdom lays nothing out, so a Resizable measures no room and its handles
 * can't move. This gives every Resizable group a fixed size and places its
 * panels and handles along its axis: a panel takes its
 * `--resizable-panel-size` share of the room the panels share, or an even
 * share of what's left before the group lays it out, and a handle takes
 * `handle` pixels.
 */
export const stubResizableLayout = (layout: {
  readonly handle?: number;
  /** Read on every measure, so a test can grow the group it passed. */
  readonly height: number;
  /** The size of every other element, like the region a group fills. */
  readonly outside?: { readonly height: number; readonly width: number };
  readonly width: number;
}) => {
  const { handle = 0, outside } = layout;
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect"
  );
  const along = (vertical: boolean, offset: number, extent: number): DOMRect =>
    vertical
      ? new DOMRect(0, offset, layout.width, extent)
      : new DOMRect(offset, 0, extent, layout.height);

  const getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement
  ): DOMRect {
    if (this.dataset.slot === "resizable") {
      return new DOMRect(0, 0, layout.width, layout.height);
    }
    const root = this.parentElement;
    if (root?.dataset.slot !== "resizable") {
      return outside === undefined
        ? new DOMRect()
        : new DOMRect(0, 0, outside.width, outside.height);
    }
    const vertical = root.dataset.orientation === "vertical";
    const children = [...root.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement
    );
    const handles = children.filter(isHandle).length;
    const room = (vertical ? layout.height : layout.width) - handles * handle;
    const panels = children.filter((child) => !isHandle(child));
    // Like flex layout, panels the group hasn't sized yet share what's left.
    const sized = panels.reduce(
      (total, child) => total + (shareOf(child) ?? 0) * room,
      0
    );
    const unsized = panels.filter(
      (child) => shareOf(child) === undefined
    ).length;
    const extentOf = (child: HTMLElement): number => {
      if (isHandle(child)) {
        return handle;
      }
      const share = shareOf(child);
      return share === undefined
        ? Math.max(room - sized, 0) / unsized
        : share * room;
    };
    let offset = 0;
    for (const child of children) {
      const extent = extentOf(child);
      if (child === this) {
        return along(vertical, offset, extent);
      }
      offset += extent;
    }
    return new DOMRect();
  };

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: getBoundingClientRect,
  });
  return () => {
    // jsdom defines it on Element.prototype, so HTMLElement usually has no
    // own descriptor to put back.
    if (original === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
    } else {
      Object.defineProperty(
        HTMLElement.prototype,
        "getBoundingClientRect",
        original
      );
    }
  };
};

/**
 * A ResizeObserver that reports each element's stubbed size when it starts
 * observing, and again on `report()`, so hooks that measure an element see
 * the layout above and any change a test makes to it.
 */
export const stubResizeObserver = () => {
  const original = globalThis.ResizeObserver;
  const observers = new Set<ReportingResizeObserver>();
  class ReportingResizeObserver implements ResizeObserver {
    readonly #onResize: ResizeObserverCallback;
    readonly #targets = new Set<Element>();

    constructor(onResize: ResizeObserverCallback) {
      this.#onResize = onResize;
      observers.add(this);
    }

    disconnect(): void {
      this.#targets.clear();
      observers.delete(this);
    }

    observe(target: Element): void {
      this.#targets.add(target);
      queueMicrotask(() => {
        this.report(target);
      });
    }

    report(target: Element): void {
      if (!this.#targets.has(target)) {
        return;
      }
      // SAFETY: jsdom has no ResizeObserverEntry; callers read only
      // `target` and `contentRect`.
      const entry = {
        contentRect: target.getBoundingClientRect(),
        target,
      } as ResizeObserverEntry;
      this.#onResize([entry], this);
    }

    reportAll(): void {
      for (const target of this.#targets) {
        this.report(target);
      }
    }

    unobserve(target: Element): void {
      this.#targets.delete(target);
    }
  }
  globalThis.ResizeObserver = ReportingResizeObserver;
  return {
    /** Reports every observed element's current size, as a resize would. */
    report: () => {
      for (const observer of observers) {
        observer.reportAll();
      }
    },
    restore: () => {
      globalThis.ResizeObserver = original;
    },
  };
};
