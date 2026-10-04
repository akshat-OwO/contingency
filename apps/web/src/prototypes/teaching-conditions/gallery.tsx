import { useAtom } from "@effect/atom-react";
import { FlaskConicalIcon, RotateCcwIcon } from "lucide-react";

import { SegmentedControl } from "@/components/browser/segmented-control";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AttachApproach } from "./approach-attach";
import { BrowseApproach } from "./approach-browse";
import { MentionApproach } from "./approach-mention";
import { SentenceApproach } from "./approach-sentence";
import { approachStateAtom, galleryAtom, initialState } from "./model";
import type { ApproachId, ViewportId } from "./model";

const approaches: readonly {
  readonly blurb: string;
  readonly label: string;
  readonly value: ApproachId;
}[] = [
  {
    blurb:
      "Write a comment, optionally attach context, and choose “Add check” only when you want later Runs to verify a result.",
    label: "1 · Attach",
    value: "attach",
  },
  {
    blurb:
      "Write the comment and type @ to mention a request or storage item. Its check appears under your words.",
    label: "2 · @ mention",
    value: "mention",
  },
  {
    blurb:
      "A wider composer that lists what the page did beside the comment. Tick an item to check it.",
    label: "3 · Side by side",
    value: "browse",
  },
  {
    blurb:
      "Fill in a sentence: When [step], [the app must…] [which] and [what]. Then: anything else.",
    label: "4 · Fill the sentence",
    value: "sentence",
  },
];

const viewports: Record<ViewportId, string> = {
  fill: "h-full w-full",
  large: "h-[760px] w-[1280px]",
  medium: "h-[760px] w-[1024px]",
};

/**
 * PROTOTYPE gallery for Teaching conditions. Four composer directions over
 * one mocked checkout scenario, at one shared stage size.
 */
export const TeachingConditionsGallery = () => {
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
          Teaching conditions · composer directions
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
          The dock, devtools, and composer frame are the real components. The
          page, requests, and cookies are mocked, and nothing is saved.
        </p>
      </div>
      <main className="flex min-h-0 flex-1 justify-center overflow-auto px-4 pb-4">
        <div
          className={cn(
            "bg-background relative isolate shrink-0 overflow-hidden rounded-xl border shadow-sm",
            viewports[gallery.viewport]
          )}
        >
          {gallery.approach === "attach" ? <AttachApproach /> : null}
          {gallery.approach === "mention" ? <MentionApproach /> : null}
          {gallery.approach === "browse" ? <BrowseApproach /> : null}
          {gallery.approach === "sentence" ? <SentenceApproach /> : null}
        </div>
      </main>
    </div>
  );
};
