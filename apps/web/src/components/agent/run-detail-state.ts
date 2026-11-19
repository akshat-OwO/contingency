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
