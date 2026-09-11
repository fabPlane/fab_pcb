import { describe, expect, test } from 'bun:test';
import { Picker } from '../src/core/picker.js';
import { makeRenderItem, type RenderItem } from '../src/core/model.js';
import { arcFrom3, distanceToPrimitive, hatchPolygon, dashPolyline, pointInPolygonWithHoles } from '../src/core/geometry.js';

const MM = 1_000_000;

function items(): RenderItem[] {
  return [
    makeRenderItem('track', 'BL_F_Cu', [{ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 10 * MM, y: 0 }, width: 0.5 * MM }], { net: 'GND' }),
    makeRenderItem('via', 'BL_F_Cu', [{ kind: 'circle', c: { x: 20 * MM, y: 0 }, r: 0.4 * MM, width: 0, fill: true }], { net: 'GND' }),
    makeRenderItem('ring', 'BL_B_Cu', [{ kind: 'circle', c: { x: 30 * MM, y: 0 }, r: 2 * MM, width: 0.2 * MM, fill: false }]),
    makeRenderItem('zone', 'BL_B_Cu', [
      {
        kind: 'polygon',
        outline: [
          { x: 0, y: 10 * MM },
          { x: 10 * MM, y: 10 * MM },
          { x: 10 * MM, y: 20 * MM },
          { x: 0, y: 20 * MM },
        ],
        holes: [
          [
            { x: 4 * MM, y: 14 * MM },
            { x: 6 * MM, y: 14 * MM },
            { x: 6 * MM, y: 16 * MM },
            { x: 4 * MM, y: 16 * MM },
          ],
        ],
        fill: true,
        width: 0,
      },
    ]),
    makeRenderItem('arc', 'BL_F_Cu', [
      { kind: 'arc', start: { x: 40 * MM, y: 0 }, mid: { x: 45 * MM, y: 5 * MM }, end: { x: 50 * MM, y: 0 }, width: 0.2 * MM },
    ]),
    makeRenderItem('hole', 'board.via_hole', [{ kind: 'circle', c: { x: 20 * MM, y: 0 }, r: 0.2 * MM, width: 0, fill: true }], {
      pickable: false,
    }),
    { id: 'fp', layer: 'BL_F_Cu', prims: [], bbox: { x: -1 * MM, y: -1 * MM, w: 12 * MM, h: 2 * MM }, owner: 'fp' },
  ];
}

describe('geometry distance tests', () => {
  test('segment with width', () => {
    const seg = { kind: 'segment', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, width: 2 } as const;
    expect(distanceToPrimitive({ x: 5, y: 0.5 }, seg)).toBe(0);
    expect(distanceToPrimitive({ x: 5, y: 3 }, seg)).toBe(2);
    expect(distanceToPrimitive({ x: 12, y: 0 }, seg)).toBe(1);
  });

  test('arc from three points and angular containment', () => {
    const g = arcFrom3({ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 })!;
    expect(g.c.x).toBeCloseTo(0, 9);
    expect(g.c.y).toBeCloseTo(0, 9);
    expect(g.r).toBeCloseTo(1, 9);
    expect(g.sweep).toBeCloseTo(Math.PI, 9); // increasing angle through +x
    const arc = { kind: 'arc', start: { x: 0, y: -1 }, mid: { x: 1, y: 0 }, end: { x: 0, y: 1 }, width: 0.2 } as const;
    expect(distanceToPrimitive({ x: 1, y: 0 }, arc)).toBe(0);
    expect(distanceToPrimitive({ x: -1, y: 0 }, arc)).toBeCloseTo(Math.SQRT2 - 0.1, 9); // nearest endpoint
    // the other way round
    const g2 = arcFrom3({ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 0, y: 1 })!;
    expect(g2.sweep).toBeCloseTo(-Math.PI, 9);
  });

  test('polygon with holes containment', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const hole = [
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
    ];
    expect(pointInPolygonWithHoles({ x: 1, y: 1 }, outer, [hole])).toBe(true);
    expect(pointInPolygonWithHoles({ x: 5, y: 5 }, outer, [hole])).toBe(false);
    expect(pointInPolygonWithHoles({ x: 11, y: 5 }, outer, [hole])).toBe(false);
  });

  test('hatch lines stay inside the polygon and skip holes', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const hole = [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ];
    const lines = hatchPolygon(outer, [hole], 10, 45);
    expect(lines.length).toBeGreaterThan(5);
    for (const [a, b] of lines) {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(pointInPolygonWithHoles(m, outer, [hole])).toBe(true);
    }
  });

  test('dashPolyline follows the pattern', () => {
    const segs = dashPolyline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      [30, 10],
    );
    expect(segs.length).toBe(3);
    expect(segs[0]).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
    ]);
    expect(segs[1]![0]).toEqual({ x: 40, y: 0 });
    expect(segs[2]![1]).toEqual({ x: 100, y: 0 }); // last dash truncated at the end
  });
});

describe('Picker', () => {
  test('nearest-first results with tolerance', () => {
    const list = items();
    const p = new Picker(() => list);
    const hits = p.pick({ x: 5 * MM, y: 0.1 * MM }, 0.5 * MM);
    expect(hits.map((h) => h.id)).toEqual(['track', 'fp']); // inside the track, then the footprint body by bbox
    expect(hits[0]!.distance).toBe(0);
    expect(hits[0]!.net).toBe('GND');
    // via: 0.3 mm outside the ring should be found with 0.5 mm tolerance but not 0.2 mm
    expect(p.pick({ x: 20.7 * MM, y: 0 }, 0.5 * MM).map((h) => h.id)).toEqual(['via']);
    expect(p.pick({ x: 20.7 * MM, y: 0 }, 0.2 * MM)).toEqual([]);
  });

  test('stroked circle only hits on the ring, filled polygon respects holes', () => {
    const p = new Picker(() => items());
    expect(p.pick({ x: 30 * MM, y: 0 }, 0.1 * MM)).toEqual([]); // centre of an unfilled ring
    expect(p.pick({ x: 32 * MM, y: 0 }, 0.1 * MM)[0]!.id).toBe('ring');
    expect(p.pick({ x: 2 * MM, y: 12 * MM }, 0)[0]!.id).toBe('zone');
    expect(p.pick({ x: 5 * MM, y: 15 * MM }, 0)).toEqual([]); // inside the hole
    expect(p.pick({ x: 45 * MM, y: 5 * MM }, 0.05 * MM)[0]!.id).toBe('arc');
  });

  test('decorations are skipped, layer filter works, box queries', () => {
    const p = new Picker(() => items());
    const ids = p.pick({ x: 20 * MM, y: 0 }, 0).map((h) => h.id);
    expect(ids).toEqual(['via']);
    expect(p.pick({ x: 20 * MM, y: 0 }, 0, { includeDecorations: true }).map((h) => h.id)).toEqual(['hole', 'via']);
    expect(p.pick({ x: 2 * MM, y: 12 * MM }, 0, { layers: (l) => l === 'BL_F_Cu' })).toEqual([]);
    const inside = p.queryInside({ x: -2 * MM, y: -2 * MM, w: 25 * MM, h: 4 * MM }).map((i) => i.id);
    expect(inside.sort()).toEqual(['fp', 'track', 'via']);
    const touching = p.queryBox({ x: 9 * MM, y: -1 * MM, w: 2 * MM, h: 2 * MM }).map((i) => i.id);
    expect(touching.sort()).toEqual(['fp', 'track']);
  });

  test('index rebuilds after invalidate', () => {
    const list = items();
    const p = new Picker(() => list);
    expect(p.size).toBe(7);
    list.push(makeRenderItem('new', 'BL_F_Cu', [{ kind: 'circle', c: { x: 100 * MM, y: 0 }, r: MM, width: 0, fill: true }]));
    expect(p.pick({ x: 100 * MM, y: 0 }, 0)).toEqual([]); // stale until invalidated
    p.invalidate();
    expect(p.pick({ x: 100 * MM, y: 0 }, 0)[0]!.id).toBe('new');
    expect(new Picker(() => []).pick({ x: 0, y: 0 }, 1)).toEqual([]);
  });
});
