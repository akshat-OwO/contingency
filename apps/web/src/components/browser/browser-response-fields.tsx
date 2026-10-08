import type {
  BrowserNetworkRequest,
  TeachingBrowserAttachment,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Predicate, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import {
  dragAttachment,
  requestAttachment,
} from "@/components/agent/browser-check-attachments";
import { Button } from "@/components/ui/button";

const Field = ({
  value,
  path,
  request,
  attach,
  depth,
}: {
  readonly value: Schema.Json;
  readonly path: readonly (string | number)[];
  readonly request: BrowserNetworkRequest;
  readonly attach: (attachment: TeachingBrowserAttachment) => void;
  readonly depth: number;
}) => {
  // oxlint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Atom identity owns the subscription and must survive renders.
  const openAtom = useMemo(() => Atom.make(depth < 1), [depth]);
  const [open, setOpen] = useAtom(openAtom);
  const label = path.length === 0 ? "Response" : path.join(".");
  if (value !== null && Predicate.isObjectKeyword(value)) {
    if (depth > 12) {
      return (
        <p>Expand a shallower field to stay within the response tree limit.</p>
      );
    }
    const children: readonly [string | number, Schema.Json][] = Array.isArray(
      value
    )
      ? value
          .slice(0, 100)
          .map((item: Schema.Json, index: number) => [index, item])
      : Object.entries(value).slice(0, 100);
    return (
      <details
        className="ml-2 border-l pl-2"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          {label} · {Array.isArray(value) ? "array" : "object"}
        </summary>
        {open
          ? children.map(([name, item]) => (
              <Field
                attach={attach}
                depth={depth + 1}
                key={name}
                path={[...path, name]}
                request={request}
                value={item}
              />
            ))
          : null}
      </details>
    );
  }
  const candidate = requestAttachment(request, {
    expected: value,
    path,
    purpose: "requirement",
  });
  return (
    <div
      className="flex items-center gap-2 py-1"
      draggable
      onDragStart={(event) => dragAttachment(event, candidate)}
    >
      <span className="min-w-0 flex-1 break-all">
        {label}{" "}
        <span className="text-muted-foreground">
          Observed: {JSON.stringify(value)}
        </span>
      </span>
      <Button
        aria-label={`Require ${label}`}
        size="sm"
        variant="ghost"
        onClick={() => attach(candidate)}
      >
        Require this value
      </Button>
    </div>
  );
};
export const BrowserResponseFields = ({
  body,
  request,
  attach,
}: {
  readonly body: string;
  readonly request: BrowserNetworkRequest;
  readonly attach: (attachment: TeachingBrowserAttachment) => void;
}) => {
  if (body.length > 65_536) {
    return <p>Response exceeds the field selection limit.</p>;
  }
  try {
    const value = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(body));
    return (
      <div
        aria-label="Response fields"
        className="h-full overflow-auto p-3 text-xs"
      >
        <Field
          attach={attach}
          depth={0}
          path={[]}
          request={request}
          value={value}
        />
      </div>
    );
  } catch {
    return (
      <p className="p-3">
        This response is not JSON. Attach the request as context.
      </p>
    );
  }
};
