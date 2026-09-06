// Unit coverage for the batch-3 service layer: the library browser's caching and filtering, the
// board tools' enum plumbing, the settings translations (KiCad colours / grid strings) and the
// server-undo picker. Everything here runs against fakes — the real-server behaviour is proved by
// `scripts/prove-kicad.mjs` and `e2e/real`.

import { describe, expect, test } from 'bun:test';
import { RuleSeverity } from '@kicad-web/proto';
import { KicadLibraryService } from '@/services/kicad/KicadLibraryService';
import { GLOBAL_DELETE_TYPES, boardLayer, objectType, ruleLabel } from '@/services/kicad/KicadBoardTools';
import { gridToNm, toThemeColor } from '@/services/kicad/KicadSettingsService';
import { KicadSchematicTools, MANDATORY_FIELDS } from '@/services/kicad/KicadSchematicTools';
import { KicadUndoService } from '@/services/kicad/KicadUndoService';
import { useLibraryStore, pickLibraryEntry } from '@/state/libraryStore';

// --------------------------------------------------------------------------- library service

interface FakeEntry {
  name: string;
  description: string;
  keywords: string;
  info?: { case: 'symbol' | 'footprint'; value: Record<string, unknown> };
}

function fakeLibraryService(entriesByLib: Record<string, FakeEntry[]>, rows = [{ nickname: 'Device', uri: 'a.kicad_sym', description: 'd', scope: 2, enabled: true }]) {
  const calls: string[] = [];
  const svc = new KicadLibraryService({ session: null } as never);
  const kicad = {
    libraries: {
      tables: async (kind: string) => {
        calls.push(`tables:${kind}`);
        return rows;
      },
      entries: async (kind: string, nickname: string, filter: string) => {
        calls.push(`entries:${kind}:${nickname}:${filter}`);
        return entriesByLib[nickname] ?? [];
      },
    },
  };
  svc.kicad = () => Promise.resolve(kicad as never);
  return { svc, calls };
}

describe('KicadLibraryService', () => {
  const entries: FakeEntry[] = [
    { name: 'R', description: 'Resistor', keywords: 'res passive', info: { case: 'symbol', value: { unitCount: 1, isPower: false, footprint: 'R_0603' } } },
    { name: 'C', description: 'Capacitor', keywords: 'cap', info: { case: 'symbol', value: { unitCount: 1, isPower: false, footprint: '' } } },
    { name: 'LED', description: 'Light emitting diode', keywords: 'diode', info: { case: 'symbol', value: { unitCount: 2, isPower: false, footprint: '' } } },
  ];

  test('tables are read once and reported with their scope', async () => {
    const { svc, calls } = fakeLibraryService({});
    const a = await svc.tables('symbol');
    const b = await svc.tables('symbol');
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ nickname: 'Device', scope: 'project', enabled: true });
    expect(calls.filter((c) => c.startsWith('tables:'))).toHaveLength(1);
  });

  test('entry lists are cached per library and filtered in memory', async () => {
    const { svc, calls } = fakeLibraryService({ Device: entries });
    expect((await svc.entries('symbol', 'Device')).map((e) => e.name)).toEqual(['R', 'C', 'LED']);
    // a filtered call must not hit the server again
    expect((await svc.entries('symbol', 'Device', 'diode')).map((e) => e.name)).toEqual(['LED']);
    expect((await svc.entries('symbol', 'Device', 'passive')).map((e) => e.name)).toEqual(['R']);
    expect(calls.filter((c) => c.startsWith('entries:'))).toEqual(['entries:symbol:Device:']);
  });

  test('the summary carries lib id and the symbol details', async () => {
    const { svc } = fakeLibraryService({ Device: entries });
    const [r] = await svc.entries('symbol', 'Device', 'Resistor');
    expect(r).toMatchObject({ libId: 'Device:R', nickname: 'Device', unitCount: 1, isPower: false, defaultFootprint: 'R_0603' });
  });

  test('invalidate drops one library, or the whole kind', async () => {
    const { svc, calls } = fakeLibraryService({ Device: entries });
    await svc.entries('symbol', 'Device');
    svc.invalidate('symbol', 'Device');
    await svc.entries('symbol', 'Device');
    expect(calls.filter((c) => c.startsWith('entries:'))).toHaveLength(2);
    svc.invalidate('symbol');
    await svc.entries('symbol', 'Device');
    expect(calls.filter((c) => c.startsWith('entries:'))).toHaveLength(3);
  });

  test('a failed listing is not cached', async () => {
    const svc = new KicadLibraryService({ session: null } as never);
    let attempts = 0;
    svc.kicad = () =>
      Promise.resolve({
        libraries: {
          entries: async () => {
            attempts++;
            if (attempts === 1) throw new Error('library not loaded');
            return [{ name: 'R', description: '', keywords: '' }];
          },
        },
      } as never);
    await expect(svc.entries('symbol', 'Device')).rejects.toThrow('library not loaded');
    expect((await svc.entries('symbol', 'Device')).map((e) => e.name)).toEqual(['R']);
  });
});

// ------------------------------------------------------------------------------- board tools

describe('board tool enums', () => {
  test('object types and layers map to the generated enums', () => {
    expect(objectType('KOT_PCB_VIA')).toBeTypeOf('number');
    expect(objectType('KOT_NOT_A_TYPE')).toBeUndefined();
    expect(boardLayer('BL_F_Cu')).toBeTypeOf('number');
    expect(boardLayer('BL_NOPE')).toBeUndefined();
  });

  test('every global-deletion type resolves', () => {
    for (const t of GLOBAL_DELETE_TYPES) expect(objectType(t.type)).toBeTypeOf('number');
  });

  test('rule labels drop the enum prefix', () => {
    expect(ruleLabel('DRCET_CLEARANCE')).toBe('clearance');
    expect(ruleLabel('ERCET_PIN_TO_PIN')).toBe('pin to pin');
  });
});

// ---------------------------------------------------------------------------------- settings

describe('KiCad settings translation', () => {
  test('colours scale from KiCad floats to renderer bytes', () => {
    expect(toThemeColor({ r: 1, g: 0, b: 0.5, a: 0.8 })).toEqual({ r: 255, g: 0, b: 128, a: 0.8 });
    expect(toThemeColor(undefined)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  test('grid strings parse into nanometres', () => {
    expect(gridToNm('1 mm')).toBe(1_000_000);
    expect(gridToNm('0.5 mm')).toBe(500_000);
    expect(gridToNm('1000 mil')).toBe(25_400_000);
    expect(gridToNm('50 mil')).toBe(1_270_000);
    expect(gridToNm('2 in')).toBe(50_800_000);
    expect(gridToNm('not a grid')).toBeUndefined();
  });
});

// -------------------------------------------------------------------------- schematic tools

function fakeSchematicTools(rows: unknown[]) {
  const seen: { edits?: unknown[] } = {};
  let resynced = 0;
  const sch = {
    fieldsTable: async () => rows,
    setFields: async (edits: unknown[]) => {
      seen.edits = edits;
      return { updatedCount: edits.length, errors: [] };
    },
  };
  const docs = {
    schematicDoc: sch,
    boardDoc: null,
    beginActivity: () => () => undefined,
    resyncDocument: async () => {
      resynced++;
    },
  };
  return { tools: new KicadSchematicTools(docs as never), seen, resynced: () => resynced };
}

describe('KicadSchematicTools', () => {
  const rows = [
    { id: 'a', sheetPath: { path: [{ value: 'p1' }] }, sheet: '/', reference: 'R1', unit: 1, fields: { Reference: 'R1', Value: '10k', Zzz: 'x' }, excludedFromBom: false, excludedFromBoard: false, doNotPopulate: false },
    { id: 'b', sheetPath: undefined, sheet: '', reference: 'C1', unit: 1, fields: { Reference: 'C1', Value: '1u', Aaa: 'y' }, excludedFromBom: true, excludedFromBoard: false, doNotPopulate: false },
  ];

  test('columns keep the mandatory ones first, then the user fields sorted', async () => {
    const { tools } = fakeSchematicTools(rows);
    const t = await tools.fieldsTable();
    expect(t.columns.slice(0, MANDATORY_FIELDS.length)).toEqual(MANDATORY_FIELDS);
    expect(t.columns.slice(MANDATORY_FIELDS.length)).toEqual(['Aaa', 'Zzz']);
    expect(t.rows[1]!.sheet).toBe('/'); // an empty sheet path reads as the root
  });

  test('setFields sends one batch and attaches each row sheet path', async () => {
    const { tools, seen, resynced } = fakeSchematicTools(rows);
    await tools.fieldsTable();
    const r = await tools.setFields([
      { id: 'a', field: 'Value', value: '22k' },
      { id: 'b', field: 'Value', value: '2u2' },
    ]);
    expect(r.updatedCount).toBe(2);
    expect(seen.edits).toEqual([
      { id: 'a', field: 'Value', value: '22k', sheetPath: { path: [{ value: 'p1' }] } },
      { id: 'b', field: 'Value', value: '2u2', sheetPath: undefined },
    ]);
    expect(resynced()).toBe(1); // one commit, one re-sync
  });

  test('an empty edit list is a no-op', async () => {
    const { tools, seen } = fakeSchematicTools(rows);
    expect(await tools.setFields([])).toEqual({ updatedCount: 0, errors: [] });
    expect(seen.edits).toBeUndefined();
  });

  test('syncToBoard refuses without a board', async () => {
    const { tools } = fakeSchematicTools(rows);
    await expect(tools.syncToBoard()).rejects.toThrow(/no board is open/);
  });
});

// -------------------------------------------------------------------------------- undo mode

function fakeUndo(supportsServer: boolean, stack: string[] = []) {
  const undone: number[] = [];
  const doc = {
    supportsServerUndo: async () => supportsServer,
    undo: async (n: number) => {
      undone.push(n);
      stack.pop();
      return { applied: 1, undoCount: stack.length, redoCount: 0 };
    },
    redo: async () => ({ applied: 1, undoCount: stack.length, redoCount: 0 }),
    undoStack: async () => ({ undo: stack.map((description) => ({ description, clientName: 'kicad-web', itemCount: 1 })), redo: [] }),
  };
  const docs = { boardDoc: doc, schematicDoc: null, beginActivity: () => () => undefined, resyncDocument: async () => undefined };
  const clientCalls: string[] = [];
  const commands = {
    undo: async () => {
      clientCalls.push('undo');
      return { id: 1, message: 'client step', storeKey: 'board', forward: [], inverse: [], at: 0 };
    },
    redo: async () => {
      clientCalls.push('redo');
      return null;
    },
  };
  return { service: new KicadUndoService(docs as never, commands as never, () => 'board'), undone, clientCalls };
}

describe('KicadUndoService', () => {
  test('uses KiCad when Undo is advertised and reports its stack', async () => {
    const { service, undone, clientCalls } = fakeUndo(true, ['Place via', 'Move 2 items']);
    expect(await service.mode()).toBe('server');
    expect(service.cachedMode()).toBe('server');
    expect((await service.stacks()).undo.map((e) => e.description)).toEqual(['Place via', 'Move 2 items']);
    const r = await service.undo();
    expect(r).toMatchObject({ via: 'server', applied: 1, label: 'Move 2 items' });
    expect(undone).toEqual([1]);
    expect(clientCalls).toEqual([]);
  });

  test('falls back to the client history when Undo is missing', async () => {
    const { service, undone, clientCalls } = fakeUndo(false, ['ignored']);
    expect(await service.mode()).toBe('client');
    expect(await service.stacks()).toEqual({ undo: [], redo: [] });
    expect(await service.undo()).toMatchObject({ via: 'client', applied: 1, label: 'client step' });
    expect(await service.redo()).toMatchObject({ via: 'none', applied: 0 });
    expect(undone).toEqual([]);
    expect(clientCalls).toEqual(['undo', 'redo']);
  });

  test('the capability is probed once', async () => {
    let probes = 0;
    const doc = {
      supportsServerUndo: async () => {
        probes++;
        return true;
      },
      undo: async () => ({ applied: 0, undoCount: 0, redoCount: 0 }),
      redo: async () => ({ applied: 0, undoCount: 0, redoCount: 0 }),
      undoStack: async () => ({ undo: [], redo: [] }),
    };
    const docs = { boardDoc: doc, schematicDoc: null, beginActivity: () => () => undefined, resyncDocument: async () => undefined };
    const service = new KicadUndoService(docs as never, {} as never, () => 'board');
    await service.mode();
    await service.mode();
    await service.stacks();
    expect(probes).toBe(1);
  });
});

// ----------------------------------------------------------------------------- library store

describe('library picker handshake', () => {
  test('resolves with the chosen id and clears the request', async () => {
    const p = pickLibraryEntry('footprint', { purpose: 'place', title: 'Place footprint' });
    expect(useLibraryStore.getState().request).toMatchObject({ kind: 'footprint', purpose: 'place' });
    useLibraryStore.getState().finish('Resistor_SMD:R_0603_1608Metric');
    expect(await p).toBe('Resistor_SMD:R_0603_1608Metric');
    expect(useLibraryStore.getState().request).toBeNull();
  });

  test('cancelling resolves with null', async () => {
    const p = pickLibraryEntry('symbol', { purpose: 'place', title: 'Place symbol' });
    useLibraryStore.getState().finish(null);
    expect(await p).toBeNull();
  });

  test('an initial id preselects its library and entry', async () => {
    const p = pickLibraryEntry('footprint', { purpose: 'assign', title: 'Assign', initial: 'Capacitor_SMD:C_0402' });
    const s = useLibraryStore.getState();
    expect(s.nickname.footprint).toBe('Capacitor_SMD');
    expect(s.selected.footprint).toBe('Capacitor_SMD:C_0402');
    s.finish(null);
    await p;
  });

  test('opening a second picker cancels the first', async () => {
    const first = pickLibraryEntry('footprint', { purpose: 'place', title: 'one' });
    const second = pickLibraryEntry('footprint', { purpose: 'place', title: 'two' });
    expect(await first).toBeNull();
    useLibraryStore.getState().finish('A:B');
    expect(await second).toBe('A:B');
  });
});

// keep the import used: the severity enum is part of the board tools' public contract
test('rule severities are the three KiCad accepts', () => {
  expect([RuleSeverity.RS_ERROR, RuleSeverity.RS_WARNING, RuleSeverity.RS_IGNORE].every((v) => typeof v === 'number')).toBe(true);
});
