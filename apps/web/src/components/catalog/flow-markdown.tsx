import { Fragment } from "react";

import { inlineRuns, markdownBlocks } from "./flow-markdown-blocks";
import type { Block } from "./flow-markdown-blocks";

/**
 * A Flow package's markdown, rendered. Each numbered procedure step shows
 * its `Done when:` outcome beneath it, and a link to another file in the
 * package opens that file's tab.
 */

const EXTERNAL = /^https?:\/\//u;
const RELATIVE = /^\.\//u;

interface FileLinks {
  /** The package's files, by path relative to the Flow directory. */
  readonly files: ReadonlySet<string>;
  /** Opens one of `files` in its tab. */
  readonly onFile: (path: string) => void;
}

const Inline = ({
  files,
  onFile,
  text,
}: FileLinks & { readonly text: string }) => (
  <>
    {inlineRuns(text).map((run) => {
      const key = run.offset;
      switch (run.kind) {
        case "code": {
          return <code key={key}>{run.text}</code>;
        }
        case "bold": {
          return <strong key={key}>{run.text}</strong>;
        }
        case "text": {
          return <Fragment key={key}>{run.text}</Fragment>;
        }
        default: {
          break;
        }
      }
      if (EXTERNAL.test(run.href)) {
        return (
          <a href={run.href} key={key} rel="noreferrer" target="_blank">
            {run.text}
          </a>
        );
      }
      const path = run.href.replace(RELATIVE, "");
      if (!files.has(path)) {
        return <Fragment key={key}>{run.text}</Fragment>;
      }
      return (
        <button
          data-slot="md-link"
          key={key}
          onClick={() => {
            onFile(path);
          }}
          type="button"
        >
          {run.text}
        </button>
      );
    })}
  </>
);

const HEADINGS = ["h3", "h4", "h5", "h6"] as const;

const BlockView = ({
  block,
  links,
}: {
  readonly block: Block;
  readonly links: FileLinks;
}) => {
  switch (block.kind) {
    case "heading": {
      const Heading =
        HEADINGS[Math.min(block.level, HEADINGS.length) - 1] ?? "h6";
      return (
        <Heading data-level={block.level}>
          <Inline {...links} text={block.text} />
        </Heading>
      );
    }
    case "paragraph": {
      return (
        <p>
          <Inline {...links} text={block.text} />
        </p>
      );
    }
    case "list": {
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item.line}>
              <Inline {...links} text={item.text} />
            </li>
          ))}
        </ul>
      );
    }
    case "code": {
      return <pre>{block.text}</pre>;
    }
    default: {
      return (
        <ol data-slot="md-steps">
          {block.items.map((step, position) => (
            <li key={step.line}>
              <span aria-hidden="true" data-slot="md-step-number">
                {position + 1}
              </span>
              <div>
                <p>
                  <Inline {...links} text={step.text} />
                </p>
                {step.doneWhen === undefined ? null : (
                  <p data-slot="md-done-when">
                    <span>Done when</span>{" "}
                    <Inline {...links} text={step.doneWhen} />
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      );
    }
  }
};

export const FlowMarkdown = ({
  files,
  onFile,
  source,
}: {
  readonly files: readonly string[];
  readonly onFile: (path: string) => void;
  readonly source: string;
}) => {
  const links: FileLinks = { files: new Set(files), onFile };
  return (
    <div data-slot="flow-markdown">
      {markdownBlocks(source).map((block) => (
        <BlockView block={block} key={block.line} links={links} />
      ))}
    </div>
  );
};
