import "@testing-library/jest-dom/vitest";

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {
    void this;
  }

  observe(): void {
    void this;
  }

  unobserve(): void {
    void this;
  }
}

globalThis.ResizeObserver = TestResizeObserver;

Element.prototype.getAnimations = () => [];

Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string): MediaQueryList => ({
    addEventListener: () => null,
    addListener: () => null,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => null,
    removeListener: () => null,
  }),
});

// jsdom has no Popover API. UI SDK popups render on the top layer through
// it, so tests that only need a popup rendered get the stubs UI SDK's
// testing guide gives. They do not exercise native popup behaviour.
HTMLElement.prototype.showPopover ??= function showPopover(): void {
  void this;
};
HTMLElement.prototype.hidePopover ??= function hidePopover(): void {
  void this;
};
document.head.append(
  Object.assign(document.createElement("style"), {
    textContent: "[popover] { display: block !important }",
  })
);
