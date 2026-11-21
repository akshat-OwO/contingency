import { createContext } from "react";

/** A recorded instant as a wall-clock time; anything unparsable as is. */
export const clockTime = (at: string) => {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? at
    : parsed.toLocaleTimeString(undefined, {
        hour: "2-digit",
        hour12: false,
        minute: "2-digit",
        second: "2-digit",
      });
};

/**
 * The level of each section heading, one under the heading of whatever holds
 * the sections: level 3 under the Task details popover's level 2 title, and
 * level 4 under a Run Summary's level 3 title (#744's run details).
 */
export const DetailHeadingLevel = createContext<3 | 4>(3);
