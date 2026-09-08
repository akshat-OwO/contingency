import { createHighlighter } from "@tanstack/highlight/core";
import { json } from "@tanstack/highlight/languages/json";
import { plaintext } from "@tanstack/highlight/languages/plaintext";

import { HighlightedCode } from "@/components/create/highlighted-code";

const highlighter = createHighlighter({
  fallbackLanguage: "plaintext",
  languages: [json, plaintext],
});

interface HighlightedBodyContent {
  readonly language: "json" | "plaintext";
  readonly text: string;
}

const prettyJsonIfParseable = (value: string): HighlightedBodyContent => {
  if (value.length === 0) {
    return { language: "plaintext", text: "" };
  }
  try {
    return {
      language: "json",
      text: JSON.stringify(JSON.parse(value), null, 2),
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
  return <HighlightedCode tokens={tokens} />;
};
