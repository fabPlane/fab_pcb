// referenceOf() reads the reference designator through both field nestings KiCad uses.
import './setup';
import { describe, expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { FootprintInstanceSchema, SchematicSymbolInstanceSchema } from '@kicad-web/proto';
import type { StoredItem } from '@/contracts';
import { referenceOf } from '@/lib/geometry';

describe('referenceOf', () => {
  test('board footprint: Field → BoardText → Text', () => {
    const proto = create(FootprintInstanceSchema, { id: { value: 'fp' }, referenceField: { name: 'Reference', text: { text: { text: ' R7 ' } } } });
    expect(referenceOf({ id: 'fp', type: 'KOT_PCB_FOOTPRINT', proto })).toBe('R7');
  });
  test('schematic symbol: SchematicField → Text', () => {
    const proto = create(SchematicSymbolInstanceSchema, { id: { value: 'sym' }, referenceField: { name: 'Reference', text: { text: 'U3' } } });
    expect(referenceOf({ id: 'sym', type: 'KOT_SCH_SYMBOL', proto })).toBe('U3');
  });
  test('mock / flat shapes and missing fields', () => {
    const flat: StoredItem = { id: 'a', type: 'KOT_PCB_FOOTPRINT', proto: { referenceField: { text: { text: 'C2' } } } };
    expect(referenceOf(flat)).toBe('C2');
    expect(referenceOf({ id: 'b', type: 'KOT_PCB_TRACE', proto: {} })).toBe('');
    expect(referenceOf({ id: 'c', type: 'KOT_PCB_FOOTPRINT', proto: { referenceField: { text: { text: { position: {} } } } } })).toBe('');
  });
});
