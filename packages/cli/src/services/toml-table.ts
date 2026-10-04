import { Predicate } from "effect";
import { parse } from "smol-toml";
import type { TomlTable as ParsedTable, TomlValue } from "smol-toml";

/**
 * Just enough TOML to read and replace one `[mcp_servers.<name>]` table in a
 * Codex configuration file without disturbing anything else in it.
 *
 * Registration must keep every unrelated byte of the user's file, so this
 * never re-serializes a document. It locates the table and its subtables by
 * their headers, reads values with smol-toml, and splices text. A server
 * defined any other way (an inline table or dotted keys) is reported as
 * unsupported rather than guessed at.
 */

export interface TomlTable {
  readonly values: ParsedTable;
}

export type TomlTableLookup =
  | { readonly _tag: "absent" }
  | { readonly _tag: "found"; readonly table: TomlTable }
  | { readonly _tag: "unsupported"; readonly reason: string };

const HEADER = /^\s*\[(?!\[)(?<name>.+)\]\s*(?:#.*)?$/u;
const ARRAY_HEADER = /^\s*\[\[(?<name>.+)\]\]\s*(?:#.*)?$/u;
const KEY_VALUE = /^\s*(?<key>[A-Za-z0-9_."'-]+)\s*=\s*(?<value>.*)$/u;

const isTable = (value: TomlValue | undefined): value is ParsedTable =>
  Predicate.isObject(value);

/** Decode dotted and quoted key segments with the same parser as values. */
export const splitKey = (key: string): string[] => {
  const parts: string[] = [];
  let value: TomlValue = parse(`${key} = 0`);
  while (isTable(value)) {
    const entries: [string, TomlValue][] = Object.entries(value);
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      throw new Error("Expected one TOML key path");
    }
    const [part, next] = entry;
    parts.push(part);
    value = next;
  }
  return parts;
};

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => path[index] === part);

const headerPath = (line: string): string[] | undefined => {
  const array = ARRAY_HEADER.exec(line);
  if (array?.groups?.name !== undefined) {
    return splitKey(array.groups.name);
  }
  const header = HEADER.exec(line);
  return header?.groups?.name === undefined
    ? undefined
    : splitKey(header.groups.name);
};

interface ValueState {
  depth: number;
  quote: string | undefined;
  multiline: boolean;
}

/** Skip apparent headers inside strings and multiline arrays. */
const scanValue = (line: string, state: ValueState): void => {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state.quote !== undefined) {
      if (char === "\\" && state.quote === '"') {
        index += 1;
      } else if (char === state.quote) {
        if (!state.multiline) {
          state.quote = undefined;
        } else if (line.slice(index, index + 3) === state.quote.repeat(3)) {
          while (line[index + 1] === state.quote) {
            index += 1;
          }
          state.quote = undefined;
          state.multiline = false;
        }
      }
    } else if (char === "#") {
      return;
    } else if (char === '"' || char === "'") {
      state.quote = char;
      state.multiline = line.slice(index, index + 3) === char.repeat(3);
      if (state.multiline) {
        index += 2;
      }
    } else if (char === "[" || char === "{") {
      state.depth += 1;
    } else if (char === "]" || char === "}") {
      state.depth -= 1;
    }
  }
};

interface TableSpan {
  /** Line indexes of every header line belonging to the table. */
  readonly ranges: readonly { readonly end: number; readonly start: number }[];
}

/**
 * Find `[prefix...]` and its subtables, or report a definition this module
 * does not edit.
 */
const locate = (
  lines: readonly string[],
  tablePath: readonly string[]
): TableSpan | { readonly unsupported: string } => {
  const ranges: { end: number; start: number }[] = [];
  let current: string[] = [];
  let openStart: number | undefined;
  const state: ValueState = { depth: 0, multiline: false, quote: undefined };
  const close = (end: number) => {
    if (openStart !== undefined) {
      ranges.push({ end, start: openStart });
      openStart = undefined;
    }
  };
  for (const [index, line] of lines.entries()) {
    if (state.quote !== undefined || state.depth > 0) {
      scanValue(line, state);
      continue;
    }
    const header = headerPath(line);
    if (header !== undefined) {
      close(index);
      current = header;
      if (startsWith(header, tablePath)) {
        if (ARRAY_HEADER.test(line)) {
          return { unsupported: `${line.trim()} is an array of tables` };
        }
        openStart = index;
      }
      continue;
    }
    scanValue(line, state);
    if (openStart !== undefined) {
      continue;
    }
    const keyValue = KEY_VALUE.exec(line);
    if (keyValue?.groups?.key === undefined) {
      continue;
    }
    const keyPath = [...current, ...splitKey(keyValue.groups.key)];
    if (
      startsWith(keyPath, tablePath) ||
      (keyPath.length < tablePath.length && startsWith(tablePath, keyPath))
    ) {
      return {
        unsupported: `${tablePath.join(".")} is defined with dotted keys or an inline table on line ${index + 1}`,
      };
    }
  }
  close(lines.length);
  return { ranges };
};

const readTable = (text: string, tablePath: readonly string[]): ParsedTable => {
  let value: TomlValue | undefined = parse(text);
  for (const key of tablePath) {
    value =
      isTable(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  if (!isTable(value)) {
    throw new Error("The requested entry must be a table");
  }
  return value;
};

export const findTomlTable = (
  text: string,
  tablePath: readonly string[]
): TomlTableLookup => {
  try {
    parse(text);
  } catch (error) {
    return {
      _tag: "unsupported",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const lines = text.split(/\r?\n/u);
  const span = locate(lines, tablePath);
  if ("unsupported" in span) {
    return { _tag: "unsupported", reason: span.unsupported };
  }
  if (span.ranges.length === 0) {
    return { _tag: "absent" };
  }
  try {
    return {
      _tag: "found",
      table: { values: readTable(text, tablePath) },
    };
  } catch (error) {
    return {
      _tag: "unsupported",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/** A TOML basic string. JSON escaping is a subset TOML accepts. */
export const tomlString = (value: string): string => JSON.stringify(value);

/**
 * Remove the table and its subtables, then append `replacement`. Every other
 * line, comment, and blank line stays where it was.
 */
export const replaceTomlTable = (
  text: string,
  tablePath: readonly string[],
  replacement: string
): string => {
  const lookup = findTomlTable(text, tablePath);
  if (lookup._tag === "unsupported") {
    throw new Error(lookup.reason);
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const span = locate(
    lines.map((line) => line.replace(/\r?\n$/u, "")),
    tablePath
  );
  if ("unsupported" in span) {
    throw new Error(span.unsupported);
  }
  const removed = new Set<number>();
  for (const range of span.ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      removed.add(index);
    }
  }
  const kept = lines.filter((_, index) => !removed.has(index));
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const remaining = kept.join("");
  const prefix =
    remaining.length === 0
      ? ""
      : `${remaining}${remaining.endsWith("\n") ? "" : newline}${newline}`;
  const next = `${prefix}${replacement.trimEnd().replaceAll(/\r?\n/gu, newline)}${newline}`;
  parse(next);
  return next;
};
