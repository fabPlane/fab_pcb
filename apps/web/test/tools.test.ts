import './setup';
import { beforeEach, describe, expect, test } from 'bun:test';
import { BoardLayer, SchematicLineType } from '@fp-pcb/proto';
import { activeTool, bindTools, cancelTool, startTool, toolClick, toolFinish, toolKey, toolPreview, useToolStore } from '@/canvas/tools';
import type { ItemStore, StoredItem } from '@/contracts';
import { createMockServices, type Services } from '@/services';
import { useEditorStore } from '@/state/editorStore';
import { useUiStore } from '@/state/uiStore';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = (item: StoredItem) => item.proto as any;
const vec = (x: number, y: number) => ({ xNm: BigInt(x), yNm: BigInt(y) });

const snapshot = (store: ItemStore) => new Set([...store.all()].map((i) => i.id));
const addedSince = (store: ItemStore, before: Set<string>) => [...store.all()].filter((i) => !before.has(i.id));

let services: Services;

beforeEach(() => {
  cancelTool();
  useToolStore.setState({ session: null, lastClick: null });
  services = createMockServices();
  bindTools(services);
  useUiStore.getState().setGrid(1_000_000);
  useEditorStore.getState().setActiveLayer('board', 'BL_F_Cu');
});

const boardDoc = () => {
  const store = services.documents.board()!;
  return { key: 'board', kind: 'board' as const, store };
};

describe('tools: route', () => {
  test('two segments with a via + layer switch commit as one undoable transaction', async () => {
    const doc = boardDoc();
    const before = snapshot(doc.store);
    expect(services.commands.canUndo()).toBe(false);

    startTool('route', doc);
    expect(activeTool('board')?.id).toBe('route');
    expect(useEditorStore.getState().docs.board!.tool).toBe('route');

    await toolClick('board', { x: 100e6, y: 100e6 });
    await toolClick('board', { x: 110e6, y: 100e6 });
    expect(activeTool('board')!.points).toHaveLength(2);

    expect(toolKey('V')).toBe(true);
    expect(useEditorStore.getState().docs.board!.activeLayer).toBe('BL_B_Cu');
    expect(activeTool('board')!.vias).toHaveLength(1);
    expect(activeTool('board')!.vias[0]).toMatchObject({ at: { x: 110e6, y: 100e6 }, from: 'BL_F_Cu', to: 'BL_B_Cu' });
    expect(activeTool('board')!.points[1]!.layer).toBe('BL_B_Cu');

    await toolClick('board', { x: 110e6, y: 110e6 });
    expect(addedSince(doc.store, before)).toHaveLength(0); // nothing committed until finish
    await toolFinish();

    const added = addedSince(doc.store, before);
    const tracks = added.filter((i) => i.type === 'KOT_PCB_TRACE');
    const vias = added.filter((i) => i.type === 'KOT_PCB_VIA');
    expect(added).toHaveLength(3);
    expect(tracks).toHaveLength(2);
    expect(vias).toHaveLength(1);

    const front = tracks.find((t) => t.layer === 'BL_F_Cu')!;
    const back = tracks.find((t) => t.layer === 'BL_B_Cu')!;
    expect(front).toBeDefined();
    expect(back).toBeDefined();
    expect(p(front).start).toMatchObject(vec(100e6, 100e6));
    expect(p(front).end).toMatchObject(vec(110e6, 100e6));
    expect(p(front).layer).toBe(BoardLayer.BL_F_Cu);
    expect(p(back).start).toMatchObject(vec(110e6, 100e6));
    expect(p(back).end).toMatchObject(vec(110e6, 110e6));
    expect(p(back).layer).toBe(BoardLayer.BL_B_Cu);

    const via = vias[0]!;
    expect(p(via).position).toMatchObject(vec(110e6, 100e6));
    expect(p(via).padStack.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu]);
    expect(via.layer).toBe('BL_F_Cu');

    expect(services.commands.canUndo()).toBe(true);
    expect(services.commands.history().undo).toHaveLength(1);
    expect(services.commands.history().undo[0]!.message).toBe('Route 3 items');
    expect(new Set(useEditorStore.getState().docs.board!.selection)).toEqual(new Set(added.map((i) => i.id)));

    // the route tool repeats: still active with an empty run
    expect(activeTool('board')?.id).toBe('route');
    expect(activeTool('board')!.points).toHaveLength(0);
    expect(activeTool('board')!.vias).toHaveLength(0);

    await services.commands.undo();
    expect(addedSince(doc.store, before)).toHaveLength(0);
  });

  test('clicks are snapped to the grid and the net is picked up from the first hit', async () => {
    const doc = boardDoc();
    const before = snapshot(doc.store);
    startTool('route', doc);
    await toolClick('board', { x: 100.4e6, y: 99.6e6 }, { id: 'x', net: 'GND' } as never);
    await toolClick('board', { x: 120.2e6, y: 99.6e6 });
    expect(activeTool('board')!.net).toBe('GND');
    await toolFinish();
    const [t] = addedSince(doc.store, before);
    expect(t!.type).toBe('KOT_PCB_TRACE');
    expect(t!.net).toBe('GND');
    expect(p(t!).start).toMatchObject(vec(100e6, 100e6));
    expect(p(t!).end).toMatchObject(vec(120e6, 100e6));
    expect(services.commands.history().undo[0]!.message).toBe('Route 1 item on GND');
  });

  test('a double-click on the last point finishes the run', async () => {
    const doc = boardDoc();
    const before = snapshot(doc.store);
    startTool('route', doc);
    await toolClick('board', { x: 10e6, y: 10e6 });
    await toolClick('board', { x: 20e6, y: 10e6 });
    await toolClick('board', { x: 20e6, y: 10e6 });
    const added = addedSince(doc.store, before);
    expect(added).toHaveLength(1);
    expect(p(added[0]!).end).toMatchObject(vec(20e6, 10e6));
    expect(activeTool('board')!.points).toHaveLength(0);
  });

  test('finishing with a single point commits nothing and leaves the tool', async () => {
    const doc = boardDoc();
    const before = snapshot(doc.store);
    startTool('route', doc);
    await toolClick('board', { x: 10e6, y: 10e6 });
    await toolFinish();
    expect(addedSince(doc.store, before)).toHaveLength(0);
    expect(services.commands.canUndo()).toBe(false);
    expect(activeTool()).toBeNull();
    expect(useEditorStore.getState().docs.board!.tool).toBe('select');
  });

  test('V before any point is consumed but does nothing', () => {
    startTool('route', boardDoc());
    expect(toolKey('V')).toBe(true);
    expect(activeTool('board')!.vias).toHaveLength(0);
    expect(useEditorStore.getState().docs.board!.activeLayer).toBe('BL_F_Cu');
  });

  test('clicks for another store key are ignored', async () => {
    startTool('route', boardDoc());
    await toolClick('schematic:/', { x: 10e6, y: 10e6 });
    expect(activeTool('board')!.points).toHaveLength(0);
  });
});

describe('tools: via', () => {
  test('each click places a through via spanning the outer copper layers', async () => {
    const doc = boardDoc();
    const before = snapshot(doc.store);
    startTool('via', doc);
    await toolClick('board', { x: 50e6, y: 50e6 });
    await toolClick('board', { x: 60e6, y: 50e6 });
    const vias = addedSince(doc.store, before);
    expect(vias.map((v) => v.type)).toEqual(['KOT_PCB_VIA', 'KOT_PCB_VIA']);
    expect(p(vias[0]!).padStack.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu]);
    expect(services.commands.history().undo).toHaveLength(2);
    expect(activeTool('board')?.id).toBe('via');
  });
});

describe('tools: wire', () => {
  test('a diagonal click pair becomes an L of two wires (horizontal then vertical)', async () => {
    useUiStore.getState().setGrid(1_270_000);
    const store = services.documents.sheet('/')!;
    expect(store).toBeDefined();
    const before = snapshot(store);
    startTool('wire', { key: 'schematic:/', kind: 'schematic', store });

    await toolClick('schematic:/', { x: 50.8e6, y: 50.8e6 });
    await toolClick('schematic:/', { x: 63.5e6, y: 55.88e6 });
    expect(activeTool('schematic:/')!.points.map((pt) => [pt.x, pt.y])).toEqual([
      [50.8e6, 50.8e6],
      [63.5e6, 50.8e6],
      [63.5e6, 55.88e6],
    ]);
    await toolFinish();

    const wires = addedSince(store, before);
    expect(wires).toHaveLength(2);
    expect(wires.every((w) => w.type === 'KOT_SCH_LINE')).toBe(true);
    expect(wires.every((w) => p(w).type === SchematicLineType.SLT_WIRE)).toBe(true);
    const horizontal = wires.find((w) => p(w).start.yNm === p(w).end.yNm)!;
    const vertical = wires.find((w) => p(w).start.xNm === p(w).end.xNm)!;
    expect(p(horizontal).start).toMatchObject(vec(50.8e6, 50.8e6));
    expect(p(horizontal).end).toMatchObject(vec(63.5e6, 50.8e6));
    expect(p(vertical).start).toMatchObject(vec(63.5e6, 50.8e6));
    expect(p(vertical).end).toMatchObject(vec(63.5e6, 55.88e6));
    expect(services.commands.history().undo[0]!.message).toBe('Draw wire (2 segments)');
    expect(activeTool('schematic:/')?.id).toBe('wire');
    expect(activeTool('schematic:/')!.points).toHaveLength(0);
  });

  test('a click on the same row adds no corner', async () => {
    useUiStore.getState().setGrid(1_270_000);
    const store = services.documents.sheet('/')!;
    const before = snapshot(store);
    startTool('bus', { key: 'schematic:/', kind: 'schematic', store });
    await toolClick('schematic:/', { x: 50.8e6, y: 50.8e6 });
    await toolClick('schematic:/', { x: 76.2e6, y: 50.8e6 });
    await toolFinish();
    const [bus] = addedSince(store, before);
    expect(addedSince(store, before)).toHaveLength(1);
    expect(p(bus!).type).toBe(SchematicLineType.SLT_BUS);
    expect(p(bus!).start).toMatchObject(vec(50.8e6, 50.8e6));
    expect(p(bus!).end).toMatchObject(vec(76.2e6, 50.8e6));
  });
});

describe('tools: preview', () => {
  test('route preview is a polyline through the points to the snapped cursor plus a marker', async () => {
    startTool('route', boardDoc());
    await toolClick('board', { x: 100e6, y: 100e6 });
    const s = activeTool('board')!;
    const shapes = toolPreview(s, { x: 120.3e6, y: 99.8e6 });
    const poly = shapes.find((sh) => sh.kind === 'polyline');
    expect(poly).toBeDefined();
    if (poly?.kind !== 'polyline') throw new Error('unreachable');
    expect(poly.pts).toHaveLength(2);
    expect(poly.pts[0]).toMatchObject({ x: 100e6, y: 100e6 });
    expect(poly.pts[1]).toEqual({ x: 120e6, y: 100e6 });
    expect(poly.width).toBeGreaterThan(0);
    expect(shapes.find((sh) => sh.kind === 'marker')).toEqual({ kind: 'marker', c: { x: 120e6, y: 100e6 } });
  });

  test('route preview without a cursor draws the collected points only; vias become circles', async () => {
    startTool('route', boardDoc());
    await toolClick('board', { x: 100e6, y: 100e6 });
    await toolClick('board', { x: 110e6, y: 100e6 });
    toolKey('V');
    const shapes = toolPreview(activeTool('board')!, null);
    const poly = shapes.find((sh) => sh.kind === 'polyline');
    if (poly?.kind !== 'polyline') throw new Error('expected polyline');
    expect(poly.pts).toHaveLength(2);
    expect(shapes.some((sh) => sh.kind === 'circle' && sh.c.x === 110e6 && sh.c.y === 100e6)).toBe(true);
    expect(shapes.some((sh) => sh.kind === 'marker')).toBe(false);
  });

  test('an empty route session with no cursor previews nothing', () => {
    startTool('route', boardDoc());
    expect(toolPreview(activeTool('board')!, null)).toEqual([]);
  });

  test('wire preview bends 90° towards the cursor', async () => {
    useUiStore.getState().setGrid(1_270_000);
    const store = services.documents.sheet('/')!;
    startTool('wire', { key: 'schematic:/', kind: 'schematic', store });
    await toolClick('schematic:/', { x: 50.8e6, y: 50.8e6 });
    const shapes = toolPreview(activeTool('schematic:/')!, { x: 63.5e6, y: 55.88e6 });
    const poly = shapes.find((sh) => sh.kind === 'polyline');
    if (poly?.kind !== 'polyline') throw new Error('expected polyline');
    expect(poly.pts.map((pt) => [pt.x, pt.y])).toEqual([
      [50.8e6, 50.8e6],
      [63.5e6, 50.8e6],
      [63.5e6, 55.88e6],
    ]);
  });
});

describe('tools: keys', () => {
  test('Escape clears the pending run first, then cancels the tool', async () => {
    startTool('route', boardDoc());
    await toolClick('board', { x: 10e6, y: 10e6 });
    await toolClick('board', { x: 20e6, y: 10e6 });
    toolKey('V');
    expect(activeTool('board')!.points).toHaveLength(2);

    expect(toolKey('Escape')).toBe(true);
    expect(activeTool('board')).not.toBeNull();
    expect(activeTool('board')!.points).toHaveLength(0);
    expect(activeTool('board')!.vias).toHaveLength(0);
    expect(activeTool('board')!.net).toBeUndefined();
    expect(useEditorStore.getState().docs.board!.tool).toBe('route');

    expect(toolKey('Escape')).toBe(true);
    expect(activeTool()).toBeNull();
    expect(useEditorStore.getState().docs.board!.tool).toBe('select');

    // no session: keys are not consumed
    expect(toolKey('Escape')).toBe(false);
    expect(toolKey('Enter')).toBe(false);
  });

  test('Escape on a one-shot tool cancels immediately', () => {
    startTool('text', boardDoc(), { text: 'hi' });
    expect(toolKey('Escape')).toBe(true);
    expect(activeTool()).toBeNull();
  });

  test('unknown keys are not consumed; V is ignored outside the route tool', () => {
    startTool('via', boardDoc());
    expect(toolKey('x')).toBe(false);
    expect(toolKey('V')).toBe(false);
    expect(activeTool('board')?.id).toBe('via');
  });

  test('Enter finishes the run', async () => {
    const doc = boardDoc();
    const before = snapshot(doc.store);
    startTool('route', doc);
    await toolClick('board', { x: 10e6, y: 10e6 });
    await toolClick('board', { x: 20e6, y: 10e6 });
    expect(toolKey('Enter')).toBe(true);
    // toolFinish is fired without awaiting; let the commit settle
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(addedSince(doc.store, before)).toHaveLength(1);
  });
});
