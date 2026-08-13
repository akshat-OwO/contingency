import { BrowserWorkspace } from "@/components/create/browser-workspace";
import { InstructionsPanel } from "@/components/create/instructions-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";

const CreateWorkspace = () => {
  const isMobile = useIsMobile();

  return (
    <main className="h-[calc(100svh-3.5rem)] min-h-0 overflow-hidden overscroll-none p-2 sm:p-3">
      <ResizablePanelGroup
        className="bg-background overflow-hidden rounded-xl border shadow-xs"
        orientation={isMobile ? "vertical" : "horizontal"}
      >
        <ResizablePanel
          defaultSize={isMobile ? "58%" : "72%"}
          id="browser"
          minSize={isMobile ? "16rem" : "32rem"}
        >
          <BrowserWorkspace />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          defaultSize={isMobile ? "42%" : "28%"}
          id="instructions"
          minSize={isMobile ? "16rem" : "18rem"}
        >
          <InstructionsPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
};

export { CreateWorkspace };
