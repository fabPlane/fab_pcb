import { AboutDialog } from './AboutDialog';
import { BoardSetupDialog } from './BoardSetupDialog';
import { SettingsDialog } from './SettingsDialog';
import { NetclassesDialog } from './NetclassesDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { TextVariablesDialog } from './TextVariablesDialog';
import { VariantsDialog } from './VariantsDialog';
import { PromptDialog } from './PromptDialog';
import { PageSettingsDialog } from './PageSettingsDialog';

export function Dialogs({ onProjectCreated }: { onProjectCreated(path: string): void }) {
  return (
    <>
      <BoardSetupDialog />
      <NetclassesDialog />
      <TextVariablesDialog />
      <VariantsDialog />
      <SettingsDialog />
      <NewProjectDialog onCreated={onProjectCreated} />
      <AboutDialog />
      <PageSettingsDialog />
      <PromptDialog />
    </>
  );
}
