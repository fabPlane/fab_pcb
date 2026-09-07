import { AboutDialog } from './AboutDialog';
import { BoardSetupDialog } from './BoardSetupDialog';
import { SettingsDialog } from './SettingsDialog';
import { NetclassesDialog } from './NetclassesDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { TextVariablesDialog } from './TextVariablesDialog';
import { VariantsDialog } from './VariantsDialog';
import { PromptDialog } from './PromptDialog';
import { PageSettingsDialog } from './PageSettingsDialog';
import { LibraryBrowserDialog } from './LibraryBrowserDialog';
import { AnnotateDialog } from './AnnotateDialog';
import { UpdatePcbDialog } from './UpdatePcbDialog';
import { FieldsTableDialog } from './FieldsTableDialog';
import { SeveritiesDialog } from './SeveritiesDialog';
import { AutorouteDialog } from './AutorouteDialog';

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
      <LibraryBrowserDialog />
      <AnnotateDialog />
      <UpdatePcbDialog />
      <FieldsTableDialog />
      <SeveritiesDialog />
      <AutorouteDialog />
      <PromptDialog />
    </>
  );
}
