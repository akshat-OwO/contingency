/** Validate and normalize a captured URL without discarding journey inputs. */
export const sanitizeTeachingUrl = (value: string): string => {
  try {
    return new URL(value).href;
  } catch {
    return "[invalid URL]";
  }
};
