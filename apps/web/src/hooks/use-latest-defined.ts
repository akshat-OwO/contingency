import { useRef } from "react";

/**
 * The last defined value `value` held, or `initial` before it held one. A
 * panel sliding out still paints what it showed, so it keeps that panel's
 * title too, rather than falling back to a generic one mid-exit.
 */
export const useLatestDefined = <A>(value: A | undefined, initial: A): A => {
  const latest = useRef(initial);
  if (value !== undefined) {
    latest.current = value;
  }
  return latest.current;
};
