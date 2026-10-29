/** Query-string names whose values must not cross a public capture boundary. */
const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|code|password)/iu;

/** Keep navigation useful while removing URL credentials and token values. */
export const sanitizeTeachingUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const [name, parameterValue] of url.searchParams) {
      if (parameterValue.length > 0 && SENSITIVE_QUERY_PARAMETER.test(name)) {
        url.searchParams.set(name, "[sensitive]");
      }
    }
    return url.href;
  } catch {
    return "[invalid URL]";
  }
};
