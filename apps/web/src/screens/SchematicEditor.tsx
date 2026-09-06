import { HierarchyTree } from '@/components/HierarchyTree';
import { useServices } from '@/services';
import { useAppStore } from '@/state/appStore';
import { EditorScreen } from './EditorScreen';

const SCH_LAYERS = [
  { id: 'SLT_WIRE', name: 'Wires', kind: 'technical' as const },
  { id: 'SLT_BUS', name: 'Buses', kind: 'technical' as const },
  { id: 'SLT_GRAPHIC', name: 'Graphics', kind: 'user' as const },
];

export function SchematicEditor() {
  const { documents } = useServices();
  const activeSheet = useAppStore((s) => s.activeSheet);
  const openDoc = useAppStore((s) => s.openDoc);
  const store = documents.sheet(activeSheet) ?? documents.sheet('/');
  if (!store) return <div className="empty-state">This project has no schematic.</div>;
  const sheets = documents.sheets();
  const findSheet = (path: string) => {
    const walk = (list: typeof sheets): (typeof sheets)[number] | undefined => {
      for (const s of list) {
        if (s.path === path) return s;
        const c = walk(s.children);
        if (c) return c;
      }
      return undefined;
    };
    return walk(sheets);
  };
  return (
    <EditorScreen
      kind="schematic"
      id={activeSheet}
      store={store}
      layers={SCH_LAYERS}
      leftExtra={{
        id: 'hierarchy',
        label: 'Hierarchy',
        content: <HierarchyTree sheets={sheets} activePath={activeSheet} onOpen={(p) => openDoc({ kind: 'schematic', id: p, title: findSheet(p)?.file ?? p })} />,
      }}
    />
  );
}
