import { useAtom, useAtomValue } from "@effect/atom-react";
import { Effect, Fiber, Result } from "effect";
import { useEffect } from "react";

import { BrowserWorkspace } from "@/components/create/browser-workspace";
import {
  createWorkspaceAtom,
  recordingStreamErrorAtom,
} from "@/components/create/create-workspace-state";
import { InstructionsPanel } from "@/components/create/instructions-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { recordingAtom, runRecordingStream } from "@/lib/rpc";

const CreateWorkspace = () => {
  const isMobile = useIsMobile();
  const [, setWorkspace] = useAtom(createWorkspaceAtom);
  const [streamError, setStreamError] = useAtom(recordingStreamErrorAtom);
  const recordingResult = useAtomValue(recordingAtom);

  useEffect(() => {
    if (recordingResult._tag !== "Success") {
      return;
    }
    setWorkspace((current) => ({
      ...current,
      recording: recordingResult.value.data.recording,
    }));
  }, [recordingResult, setWorkspace]);

  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.gen(function* observeRecording() {
        const outcome = yield* Effect.result(
          runRecordingStream((recording) =>
            Effect.sync(() => {
              setStreamError(null);
              setWorkspace((current) => ({ ...current, recording }));
            })
          )
        );
        if (Result.isFailure(outcome)) {
          setStreamError(
            outcome.failure instanceof Error
              ? outcome.failure.message
              : "The Recording connection ended unexpectedly."
          );
        }
      })
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [setStreamError, setWorkspace]);

  return (
    <main className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden overscroll-none p-2 sm:p-3">
      {streamError === null ? null : (
        <Alert className="mb-2" variant="destructive">
          <AlertTitle>Recording updates disconnected</AlertTitle>
          <AlertDescription>{streamError}</AlertDescription>
        </Alert>
      )}
      <ResizablePanelGroup
        className="bg-background min-h-0 flex-1 overflow-hidden rounded-xl border shadow-xs"
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
