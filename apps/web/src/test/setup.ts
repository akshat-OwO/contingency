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
