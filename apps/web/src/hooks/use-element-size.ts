import { useEffect, useRef, useState } from "react";

export interface ElementSize {
  readonly height: number;
  readonly width: number;
}

/** The content box of the element given `ref`, kept current as it resizes. */
export const useElementSize = <Element extends HTMLElement>() => {
  const ref = useRef<Element>(null);
  const [size, setSize] = useState<ElementSize>({ height: 0, width: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) {
        return;
      }
      const { height, width } = entry.contentRect;
      setSize((current) =>
        current.height === height && current.width === width
          ? current
          : { height, width }
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
};
