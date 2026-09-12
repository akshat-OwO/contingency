import type { HighlightToken } from "@tanstack/highlight";

const tokenClassName = (className: HighlightToken["className"]): string => {
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

export const HighlightedCode = ({
  tokens,
}: {
  readonly tokens: readonly HighlightToken[];
}) => (
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
