import type { DocumentKind, ItemStore } from '@/contracts';
import { mm } from '@/lib/units';
import { isCopperLayer, layerDisplayName, BOARD_LAYERS } from '@/lib/enums';
import type { MemoryItemStore } from '../MemoryItemStore';
import type {
  BoardSetup,
  DocumentService,
  LayerInfo,
  NetclassInfo,
  NetInfo,
  SheetInfo,
  TextVariable,
  VariantInfo,
} from '../types';
import { buildBoard, buildFootprintDoc, buildSchematic } from './kitchenSink';

export class MockDocumentService implements DocumentService {
  readonly boardStore: MemoryItemStore;
  readonly boardIds: Record<string, string>;
  readonly schematicIds: Record<string, string>;
  private sheetList: SheetInfo[];
  private sheetStores: Map<string, MemoryItemStore>;
  private footprints = new Map<string, MemoryItemStore>();
  private subs = new Set<() => void>();
  private dirty: Record<DocumentKind, boolean> = { board: false, schematic: false, footprint: false };
  private setup: BoardSetup;
  private netclassList: NetclassInfo[];
  private textVars: TextVariable[];
  private variantList: VariantInfo[];

  constructor() {
    const board = buildBoard();
    const sch = buildSchematic();
    this.boardStore = board.store;
    this.boardIds = board.ids;
    this.schematicIds = sch.ids;
    this.sheetList = sch.sheets;
    this.sheetStores = sch.stores;
    this.boardStore.subscribe(() => this.markDirty('board'));
    for (const s of this.sheetStores.values()) s.subscribe(() => this.markDirty('schematic'));

    this.setup = {
      copperLayers: 4,
      thicknessNm: mm(1.6),
      stackup: [
        { layer: 'BL_F_SilkS', name: 'F.Silkscreen', material: 'Liquid Photo', thicknessNm: mm(0.01), type: 'silkscreen' },
        { layer: 'BL_F_Mask', name: 'F.Mask', material: 'Liquid Photo', thicknessNm: mm(0.01), type: 'soldermask' },
        { layer: 'BL_F_Cu', name: 'F.Cu', material: 'Copper', thicknessNm: mm(0.035), type: 'copper' },
        { layer: 'dielectric1', name: 'Prepreg 1', material: 'FR4', thicknessNm: mm(0.2), type: 'prepreg' },
        { layer: 'BL_In1_Cu', name: 'In1.Cu', material: 'Copper', thicknessNm: mm(0.035), type: 'copper' },
        { layer: 'dielectric2', name: 'Core', material: 'FR4', thicknessNm: mm(1.0), type: 'core' },
        { layer: 'BL_In2_Cu', name: 'In2.Cu', material: 'Copper', thicknessNm: mm(0.035), type: 'copper' },
        { layer: 'dielectric3', name: 'Prepreg 2', material: 'FR4', thicknessNm: mm(0.2), type: 'prepreg' },
        { layer: 'BL_B_Cu', name: 'B.Cu', material: 'Copper', thicknessNm: mm(0.035), type: 'copper' },
        { layer: 'BL_B_Mask', name: 'B.Mask', material: 'Liquid Photo', thicknessNm: mm(0.01), type: 'soldermask' },
        { layer: 'BL_B_SilkS', name: 'B.Silkscreen', material: 'Liquid Photo', thicknessNm: mm(0.01), type: 'silkscreen' },
      ],
      rules: {
        minClearanceNm: mm(0.2),
        minTrackWidthNm: mm(0.2),
        minViaDiameterNm: mm(0.6),
        minViaDrillNm: mm(0.3),
        minHoleToHoleNm: mm(0.25),
        copperToEdgeNm: mm(0.5),
        minAnnularWidthNm: mm(0.15),
        minTextHeightNm: mm(0.8),
        minTextThicknessNm: mm(0.08),
      },
      customRules: `(version 1)\n(rule "HV clearance"\n  (condition "A.NetClass == 'HV'")\n  (constraint clearance (min 1.5mm)))\n`,
    };
    this.netclassList = [
      { name: 'Default', clearanceNm: mm(0.2), trackWidthNm: mm(0.25), viaDiameterNm: mm(0.8), viaDrillNm: mm(0.4), diffPairWidthNm: mm(0.2), diffPairGapNm: mm(0.25), wireWidthNm: mm(0.15), busWidthNm: mm(0.3), colour: '' },
      { name: 'Power', clearanceNm: mm(0.3), trackWidthNm: mm(0.5), viaDiameterNm: mm(1.0), viaDrillNm: mm(0.5), diffPairWidthNm: mm(0.2), diffPairGapNm: mm(0.25), wireWidthNm: mm(0.15), busWidthNm: mm(0.3), colour: '#d0342c' },
      { name: 'HV', clearanceNm: mm(1.5), trackWidthNm: mm(0.8), viaDiameterNm: mm(1.2), viaDrillNm: mm(0.6), diffPairWidthNm: mm(0.2), diffPairGapNm: mm(0.25), wireWidthNm: mm(0.15), busWidthNm: mm(0.3), colour: '#e5a50a' },
    ];
    this.textVars = [
      { name: 'REVISION', value: 'B2' },
      { name: 'COMPANY', value: 'Tensorfleet' },
      { name: 'BOARD_NAME', value: 'API kitchen sink' },
    ];
    this.variantList = [
      { name: 'Default', description: 'Fully populated', current: true },
      { name: 'No-debug', description: 'J1 omitted; PB1/PB2 pull-ups DNP', current: false },
      { name: 'Low-power', description: 'AMS1117 replaced with TPS7A02', current: false },
    ];
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }

  private markDirty(kind: DocumentKind): void {
    if (!this.dirty[kind]) {
      this.dirty[kind] = true;
      this.emit();
    }
  }

  board(): ItemStore | null {
    return this.boardStore;
  }

  sheets(): SheetInfo[] {
    return this.sheetList;
  }

  sheet(path: string): ItemStore | null {
    return this.sheetStores.get(path) ?? null;
  }

  footprint(libId: string): ItemStore | null {
    let store = this.footprints.get(libId);
    if (!store) {
      store = buildFootprintDoc(libId);
      store.subscribe(() => this.markDirty('footprint'));
      this.footprints.set(libId, store);
      this.emit();
    }
    return store;
  }

  openFootprints(): string[] {
    return [...this.footprints.keys()];
  }

  layers(): LayerInfo[] {
    const enabledCopper = ['BL_F_Cu', 'BL_In1_Cu', 'BL_In2_Cu', 'BL_B_Cu'];
    return BOARD_LAYERS.filter((id) => !isCopperLayer(id) || enabledCopper.includes(id)).map<LayerInfo>((id) => ({
      id,
      name: layerDisplayName(id),
      kind: isCopperLayer(id) ? 'copper' : id === 'BL_Edge_Cuts' || id === 'BL_Margin' ? 'edge' : id.includes('User') || id.includes('Eco') ? 'user' : 'technical',
    }));
  }

  nets(): NetInfo[] {
    const counts = new Map<string, number>();
    for (const it of this.boardStore.all()) if (it.net) counts.set(it.net, (counts.get(it.net) ?? 0) + 1);
    const netclassOf = (n: string) => (n === 'VCC' || n === 'GND' ? 'Power' : 'Default');
    return [...counts.entries()]
      .map(([name, items]) => ({ name, items, netclass: netclassOf(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  boardSetup(): BoardSetup {
    return this.setup;
  }

  async setBoardSetup(setup: BoardSetup): Promise<void> {
    this.setup = setup;
    this.markDirty('board');
    this.emit();
  }

  netclasses(): NetclassInfo[] {
    return this.netclassList;
  }

  async setNetclasses(list: NetclassInfo[]): Promise<void> {
    this.netclassList = list;
    this.emit();
  }

  textVariables(): TextVariable[] {
    return this.textVars;
  }

  async setTextVariables(list: TextVariable[]): Promise<void> {
    this.textVars = list;
    this.emit();
  }

  variants(): VariantInfo[] {
    return this.variantList;
  }

  async setVariants(list: VariantInfo[]): Promise<void> {
    this.variantList = list;
    this.emit();
  }

  async save(kind: DocumentKind): Promise<void> {
    await new Promise((r) => setTimeout(r, 120));
    this.dirty[kind] = false;
    this.emit();
  }

  isDirty(kind: DocumentKind): boolean {
    return this.dirty[kind];
  }
}
