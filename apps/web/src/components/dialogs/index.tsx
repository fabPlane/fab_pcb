import { AboutDialog } from './AboutDialog';
import { BoardSetupDialog } from './BoardSetupDialog';
import { KeymapDialog } from './KeymapDialog';
import { NetclassesDialog } from './NetclassesDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { TextVariablesDialog } from './TextVariablesDialog';
import { VariantsDialog } from './VariantsDialog';

export function Dialogs({ onProjectCreated }: { onProjectCreated(path: string): void }) {
  return (
    <>
      <BoardSetupDialog />
      <NetclassesDialog />
      <TextVariablesDialog />
      <VariantsDialog />
      <KeymapDialog />
      <NewProjectDialog onCreated={onProjectCreated} />
      <AboutDialog />
    </>
  );
}
