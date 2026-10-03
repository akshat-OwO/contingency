/** The host of a web URL, or nothing for `about:blank`, `data:`, and the like. */
export const webHost = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A bare hostname, or one explicit wildcard label at the front. */
export const isDomainScopeEntry = (entry: string): boolean => {
  const labels = entry.split(".");
  if (labels.length === 0 || labels.some((label) => label.length === 0)) {
    return false;
  }
  const [first, ...rest] = labels;
  const literal = first === "*" ? rest : labels;
  if (first === "*" && rest.length === 0) {
    return false;
  }
  return literal.every((label) => HOST_LABEL.test(label));
};

/**
 * Whether a Domain Scope entry covers a host. `*.example.com` covers every
 * subdomain and nothing else: a wildcard is explicit about what it adds, so it
 * does not quietly include the apex the user did not list.
 */
export const domainScopeCovers = (entry: string, host: string): boolean => {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return entry === host;
};
