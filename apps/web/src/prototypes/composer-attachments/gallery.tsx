import { useAtom } from "@effect/atom-react";
import { FlaskConicalIcon, RotateCcwIcon } from "lucide-react";

import { SegmentedControl } from "@/components/browser/segmented-control";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DropApproach } from "./approach-drop";
import { PlusApproach } from "./approach-plus";
import { PointApproach } from "./approach-point";
import { SuggestApproach } from "./approach-suggest";
import { approachStateAtom, galleryAtom, initialState } from "./model";
import type { ApproachId, ViewportId } from "./model";

const approaches: readonly {
  readonly blurb: string;
  readonly label: string;
  readonly value: ApproachId;
}[] = [
  {
    blurb:
      "Drag a request, a response field, or a cookie from DevTools onto the comment (or use a row’s paperclip). Rows land as context; a dropped field is already a check. Press any chip to change it.",
    label: "A · Drag from DevTools",
    value: "drop",
  },
  {
    blurb:
      "The composer is words and an element only. Press Require on any request, response field, or cookie in DevTools; checks and scans live in their own Checks panel on the rail.",
    label: "B · Require in DevTools",
    value: "point",
  },
  {
    blurb:
      "One Attach button — or type / — opens a single menu with elements, requests, storage, and both scans. Everything is a chip; a chip is context until you say it must happen.",
    label: "C · One attach menu",
    value: "plus",
  },
  {
    blurb:
      "Under the comment, the composer lists what your last step caused, plus Performance and Accessibility. Press one to require it. More reaches anything else.",
    label: "D · Suggested",
    value: "suggest",
  },
];

const viewports: Record<ViewportId, string> = {
  fill: "h-full w-full",
  large: "h-[760px] w-[1280px]",
  medium: "h-[760px] w-[1024px]",
};

/**
 * PROTOTYPE gallery for attaching browser evidence and scans to Teaching
 * comments. Four directions over one mocked checkout recording, at one
 * shared stage size.
 */
export const ComposerAttachmentsGallery = () => {
  const [gallery, setGallery] = useAtom(galleryAtom);
  const [, setApproachState] = useAtom(approachStateAtom(gallery.approach));
  const current = approaches.find((item) => item.value === gallery.approach);
  return (
    <div className="bg-muted/30 text-foreground flex h-svh flex-col overflow-hidden">
      <header className="bg-background flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-semibold tracking-wide text-amber-800 uppercase dark:text-amber-300">
          <FlaskConicalIcon aria-hidden="true" className="size-3.5" />
          Prototype
        </span>
        <h1 className="text-sm font-semibold tracking-tight">
          Teaching comments · attaching requests, storage, and scans
        </h1>
        <SegmentedControl<ApproachId>
          label="Approach"
          onChange={(approach) => setGallery({ ...gallery, approach })}
          options={approaches.map(({ label, value }) => ({ label, value }))}
          value={gallery.approach}
        />
        <span className="flex-1" />
        <SegmentedControl<ViewportId>
          label="Stage size"
          onChange={(viewport) => setGallery({ ...gallery, viewport })}
          options={[
            { label: "Fill", value: "fill" },
            { label: "1280", value: "large" },
            { label: "1024", value: "medium" },
          ]}
          value={gallery.viewport}
        />
        <Button
          onClick={() => setApproachState(initialState)}
          size="sm"
          variant="outline"
        >
          <RotateCcwIcon aria-hidden="true" />
          Reset
        </Button>
        <ModeToggle />
      </header>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-xs">
        <p className="text-foreground text-pretty">{current?.blurb}</p>
        <p className="text-muted-foreground">
          The dock, rail, chips, and composer frame are real components. The
          page, requests, cookies, and scans are mocked, and nothing is saved.
        </p>
      </div>
      <main className="flex min-h-0 flex-1 justify-center overflow-auto px-4 pb-4">
        <div
          className={cn(
            "bg-background relative isolate shrink-0 overflow-clip rounded-xl border shadow-sm",
            viewports[gallery.viewport]
          )}
        >
          {gallery.approach === "drop" ? <DropApproach /> : null}
          {gallery.approach === "point" ? <PointApproach /> : null}
          {gallery.approach === "plus" ? <PlusApproach /> : null}
          {gallery.approach === "suggest" ? <SuggestApproach /> : null}
        </div>
      </main>
    </div>
  );
};
