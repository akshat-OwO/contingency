import { ListChecksIcon, PlayIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

const InstructionsPanel = () => (
  <aside
    aria-labelledby="instructions-heading"
    className="bg-background flex size-full min-h-0 flex-col"
  >
    <div className="flex h-11 shrink-0 items-center border-b px-4">
      <h2 className="text-sm font-medium" id="instructions-heading">
        Contingency instructions
      </h2>
    </div>

    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-5 p-4">
        <div className="space-y-2">
          <label
            className="text-sm font-medium"
            htmlFor="workflow-instructions"
          >
            What should this workflow do?
          </label>
          <Textarea
            className="min-h-28 resize-none"
            id="workflow-instructions"
            placeholder="For example: Sign in with a mobile number, continue to verification, and audit each page."
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            Describe the goal and any checkpoints. Your interactions in the
            browser will become semantic steps.
          </p>
        </div>

        <Separator />

        <section aria-labelledby="recorded-steps-heading" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium" id="recorded-steps-heading">
              Recorded steps
            </h3>
            <Badge variant="outline">0 steps</Badge>
          </div>
          <div className="bg-muted/20 grid min-h-36 place-items-center rounded-lg border border-dashed p-5 text-center">
            <div className="space-y-2">
              <ListChecksIcon
                aria-hidden="true"
                className="text-muted-foreground mx-auto size-5"
              />
              <p className="text-sm font-medium">No actions recorded</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Click, type, and navigate in the browser to build your workflow.
              </p>
            </div>
          </div>
        </section>
      </div>
    </ScrollArea>

    <div className="shrink-0 border-t p-4">
      <Button className="w-full" disabled>
        <PlayIcon data-icon="inline-start" />
        Start browser session
      </Button>
    </div>
  </aside>
);

export { InstructionsPanel };
