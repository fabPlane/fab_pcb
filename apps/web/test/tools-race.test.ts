// A one-shot tool whose commit finishes after another tool was started must not cancel the
// newer session (the proof hit this: the symbol commit's late cancelTool() killed the sheet tool).
import './setup';
import { beforeEach, describe, expect, test } from 'bun:test';
import { activeTool, bindTools, cancelTool, startTool, toolClick, toolFinish, useToolStore } from '@/canvas/tools';
import { createMockServices, type Services } from '@/services';
import { useEditorStore } from '@/state/editorStore';
import { useUiStore } from '@/state/uiStore';

let services: Services;

beforeEach(() => {
  cancelTool();
  useToolStore.setState({ session: null, lastClick: null });
  services = createMockServices({ latencyMs: 30 });
  bindTools(services);
  useUiStore.getState().setGrid(1_000_000);
  useEditorStore.getState().setActiveLayer('board', 'BL_F_Cu');
});

const boardDoc = () => ({ key: 'board', kind: 'board' as const, store: services.documents.board()! });

describe('tool sessions', () => {
  test('a late one-shot completion leaves a newer session alone', async () => {
    const doc = boardDoc();
    startTool('text', doc, { text: 'late', sizeNm: 1_000_000 });
    const placing = toolClick('board', { x: 10e6, y: 10e6 }); // awaits the (mock-latency) commit
    startTool('rect', doc); // user already switched tools
    await placing;
    expect(activeTool('board')?.id).toBe('rect');
    expect(useEditorStore.getState().docs.board!.tool).toBe('rect');
    expect([...doc.store.byType('KOT_PCB_TEXT')].some((t) => (t.proto as { text?: { text?: string } }).text?.text === 'late')).toBe(true);
  });

  test('a late multi-point finish neither resets nor cancels a newer session', async () => {
    const doc = boardDoc();
    startTool('route', doc);
    await toolClick('board', { x: 10e6, y: 10e6 });
    await toolClick('board', { x: 20e6, y: 10e6 });
    const finishing = toolFinish();
    startTool('via', doc);
    await finishing;
    expect(activeTool('board')?.id).toBe('via');
    expect(activeTool('board')?.points).toEqual([]);
  });

  test('sessions carry increasing sequence numbers', () => {
    const doc = boardDoc();
    startTool('line', doc);
    const a = activeTool('board')!.seq;
    startTool('line', doc);
    expect(activeTool('board')!.seq).toBeGreaterThan(a);
  });
});
