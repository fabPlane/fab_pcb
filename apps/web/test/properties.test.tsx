import './setup';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PropertiesPanel } from '@/components/properties/PropertiesPanel';
import { inferKind, schemaFor } from '@/components/properties/schema';
import type { Patch } from '@/lib/patch';
import { mm } from '@/lib/units';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const track = {
  id: { value: '0b6a1c3e-0000-4000-8000-000000000001' },
  start: { xNm: mm(12.7875), yNm: mm(10) },
  end: { xNm: mm(16), yNm: mm(10) },
  width: { valueNm: mm(0.25) },
  locked: 'LS_UNLOCKED',
  layer: 'BL_F_Cu',
  net: { code: { value: 0 }, name: 'SIG' },
  customProperties: [] as unknown[],
};

let container: HTMLDivElement;
let root: Root;
let patches: Patch[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  patches = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(value: Record<string, unknown>, units: 'mm' | 'mil' | 'in' = 'mm') {
  act(() => {
    root.render(<PropertiesPanel value={value} typeName="KOT_PCB_TRACE" id={track.id.value} units={units} onPatch={(p) => patches.push(p)} />);
  });
}

function input(path: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`[data-path="${path}"]`);
  if (!el) throw new Error(`no field ${path}`);
  return el;
}

function setNative(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('schema inference', () => {
  test('recognises kiapi value shapes', () => {
    expect(inferKind({ valueNm: 1 })).toBe('distance');
    expect(inferKind({ valueDegrees: 90 })).toBe('angle');
    expect(inferKind({ xNm: 1, yNm: 2 })).toBe('vector');
    expect(inferKind({ value: track.id.value })).toBe('kiid');
    expect(inferKind({ value: 0.5 })).toBe('ratio');
    expect(inferKind({ r: 0, g: 0, b: 0, a: 1 })).toBe('color');
    expect(inferKind('BL_F_Cu')).toBe('enum');
    expect(inferKind('hello')).toBe('string');
    expect(inferKind(true)).toBe('bool');
    expect(inferKind([])).toBe('repeated');
    expect(inferKind({ name: 'x' })).toBe('message');
  });
  test('enum options come from the value prefix and ids are readonly', () => {
    expect(schemaFor('layer', 'BL_F_Cu', ['layer']).options).toContain('BL_B_Cu');
    expect(schemaFor('locked', 'LS_LOCKED', ['locked']).options).toEqual(['LS_UNLOCKED', 'LS_LOCKED']);
    expect(schemaFor('id', track.id, ['id']).readonly).toBe(true);
    expect(schemaFor('width', track.width, ['width'], { width: { label: 'Track width' } }).label).toBe('Track width');
  });
});

describe('PropertiesPanel', () => {
  test('renders unit-aware distance fields with nm underneath', () => {
    render(track);
    expect(input('width.valueNm').value).toBe('0.25');
    expect(container.textContent).toContain('250,000 nm');
    expect(container.textContent).toContain('Track');
  });

  test('emits a nm patch when a distance is edited in mm and committed with Enter', () => {
    render(track);
    const el = input('width.valueNm');
    act(() => setNative(el, '0.3'));
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(patches).toEqual([{ path: ['width', 'valueNm'], value: 300_000 }]);
  });

  test('interprets input in the active unit and accepts explicit suffixes', () => {
    render(track, 'mil');
    expect(input('width.valueNm').value).toBe('9.84');
    const el = input('start.xNm');
    act(() => setNative(el, '500'));
    act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(patches.at(-1)).toEqual({ path: ['start', 'xNm'], value: 12_700_000 });
    act(() => setNative(el, '1mm'));
    act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(patches.at(-1)).toEqual({ path: ['start', 'xNm'], value: 1_000_000 });
  });

  test('does not emit when the value is unchanged or invalid', () => {
    render(track);
    const el = input('width.valueNm');
    act(() => setNative(el, '0.25'));
    act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    act(() => setNative(el, 'wide'));
    act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(patches).toEqual([]);
    expect(el.className).toContain('invalid');
  });

  test('enum select and nested string fields patch by path', () => {
    render(track);
    const layer = container.querySelector<HTMLSelectElement>('[data-path="layer"]')!;
    expect(layer.tagName).toBe('SELECT');
    act(() => setNative(layer, 'BL_B_Cu'));
    expect(patches.at(-1)).toEqual({ path: ['layer'], value: 'BL_B_Cu' });
    const net = input('net.name');
    act(() => setNative(net, 'GND'));
    act(() => net.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(patches.at(-1)).toEqual({ path: ['net', 'name'], value: 'GND' });
  });

  test('kiid fields are readonly and not editable', () => {
    render(track);
    expect(container.querySelector('[data-path="id.value"]')).toBeNull();
    expect(container.textContent).toContain(track.id.value);
  });
});
