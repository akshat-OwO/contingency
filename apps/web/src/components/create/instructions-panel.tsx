import {
  AuthoringActions,
  FlowPreStepsSection,
  PanelHeader,
  RecordedStepsSection,
  RecordingControls,
  RecordingSetup,
  VariablesSection,
} from "@/components/create/instructions-panel-sections";
import { useRecordingAuthoring } from "@/components/create/recording-authoring-controller";
import { ScrollArea } from "@/components/ui/scroll-area";

const InstructionsPanel = () => {
  const controller = useRecordingAuthoring();
  return (
    <aside
      aria-labelledby="flow-authoring-heading"
      className="bg-background flex size-full min-h-0 flex-col"
    >
      <PanelHeader recording={controller.recording} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <RecordingSetup controller={controller} />
          <VariablesSection controller={controller} />
          <FlowPreStepsSection controller={controller} />
          <RecordedStepsSection controller={controller} />
          <AuthoringActions controller={controller} />
        </div>
      </ScrollArea>
      <RecordingControls controller={controller} />
    </aside>
  );
};

export { InstructionsPanel };
