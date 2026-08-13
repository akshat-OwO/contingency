import type { HighlightTokenClass } from "@tanstack/highlight";
import { createHighlighter } from "@tanstack/highlight/core";
import { json } from "@tanstack/highlight/languages/json";
import { plaintext } from "@tanstack/highlight/languages/plaintext";

const highlighter = createHighlighter({
  fallbackLanguage: "plaintext",
  languages: [json, plaintext],
});

const tokenClassName = (className: HighlightTokenClass | undefined): string => {
  switch (className) {
    case "comment":
    case "meta": {
      return "text-muted-foreground";
    }
    case "deleted":
    case "keyword":
    case "tag": {
      return "text-red-600 dark:text-red-400";
    }
    case "inserted":
    case "selector": {
      return "text-emerald-600 dark:text-emerald-400";
    }
    case "number":
    case "literal":
    case "property": {
      return "text-blue-600 dark:text-blue-400";
    }
    case "string":
    case "link": {
      return "text-cyan-700 dark:text-cyan-300";
    }
    case "function":
    case "operator":
    case "command": {
      return "text-violet-600 dark:text-violet-400";
    }
    case "attr":
    case "type":
    case "variable": {
      return "text-amber-600 dark:text-amber-400";
    }
    default: {
      return "";
    }
  }
};

export const prettyJsonIfParseable = (
  value: string
): { readonly language: "json" | "plaintext"; readonly text: string } => {
  if (value.length === 0) {
    return { language: "plaintext", text: "" };
  }
  try {
    return {
      language: "json",
      text: JSON.stringify(JSON.parse(value) as unknown, null, 2),
    };
  } catch {
    return { language: "plaintext", text: value };
  }
};

export const HighlightedBody = ({ value }: { readonly value: string }) => {
  const pretty = prettyJsonIfParseable(value);
  const { tokens } = highlighter.tokenize(pretty.text, {
    lang: pretty.language,
  });
  if (pretty.text.length === 0) {
    return <p className="text-muted-foreground p-3 text-xs">Empty value.</p>;
  }
  return (
    <div className="size-full min-h-0 min-w-0 overflow-auto">
      <pre className="min-w-0 p-3 font-mono text-xs break-words whitespace-pre-wrap">
        <code>
          {tokens.map((token, index) => (
            <span
              className={tokenClassName(token.className)}
              key={`${index}-${token.value.slice(0, 8)}`}
            >
              {token.value}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
};
