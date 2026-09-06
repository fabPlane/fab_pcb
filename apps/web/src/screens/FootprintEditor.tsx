import { useServices } from '@/services';
import { useAppStore } from '@/state/appStore';
import { EditorScreen } from './EditorScreen';

export function FootprintEditor() {
  const { documents } = useServices();
  const libId = useAppStore((s) => s.activeFootprint);
  if (!libId) return <div className="empty-state">Open a footprint from the board (Tools → Open footprint editor) to edit it here.</div>;
  const store = documents.footprint(libId);
  if (!store) return <div className="empty-state">Footprint {libId} could not be loaded.</div>;
  return <EditorScreen kind="footprint" id={libId} store={store} layers={documents.layers()} />;
}
