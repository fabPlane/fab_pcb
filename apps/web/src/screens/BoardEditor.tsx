import { useServices } from '@/services';
import { EditorScreen } from './EditorScreen';

export function BoardEditor() {
  const { documents } = useServices();
  const store = documents.board();
  if (!store) return <div className="empty-state">This project has no board. Create one with File → New board (gap G5).</div>;
  return <EditorScreen kind="board" id="board" store={store} layers={documents.layers()} />;
}
