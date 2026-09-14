import { describe, expect, test } from 'bun:test';
import { GraphicsContext, Container } from 'pixi.js';
import {
  arcToPolylineFixed,
  circleSegments,
  offsetPathPolygon,
  pointInPolygon,
  polygonArea,
  stadiumPolygon,
} from '../src/core/geometry.js';
import { buildGraphics } from '../src/core/scene.js';

const MM = 1_000_000;

describe('zoom-independent tessellation', () => {
  test('circleSegments is bounded and grows with radius', () => {
    expect(circleSegments(10_000)).toBe(8);
    expect(circleSegments(0.4 * MM)).toBe(42);
    expect(circleSegments(50 * MM)).toBe(64);
  });

  test('stadiumPolygon covers the segment with round caps', () => {
    const poly = stadiumPolygon({ x: 0, y: 0 }, { x: 10 * MM, y: 0 }, 1 * MM);
    expect(poly.length).toBeGreaterThan(8);
    // area ~ rect + disc
    const expected = 10 * MM * 1 * MM + Math.PI * (0.5 * MM) ** 2;
    expect(Math.abs(polygonArea(poly))).toBeCloseTo(expected, -11);
    expect(pointInPolygon({ x: 5 * MM, y: 0.45 * MM }, poly)).toBe(true);
    expect(pointInPolygon({ x: 10.4 * MM, y: 0 }, poly)).toBe(true); // inside the end cap
    expect(pointInPolygon({ x: 10.4 * MM, y: 0.4 * MM }, poly)).toBe(false);
    // degenerate segment -> disc
    const dot = stadiumPolygon({ x: 0, y: 0 }, { x: 0, y: 0 }, 1 * MM);
    expect(Math.abs(polygonArea(dot))).toBeCloseTo(Math.PI * (0.5 * MM) ** 2, -10);
  });

  test('offsetPathPolygon strokes a smooth arc with round caps', () => {
    const pts = arcToPolylineFixed({ x: 0, y: 0 }, { x: 5 * MM, y: 5 * MM }, { x: 10 * MM, y: 0 });
    expect(pts.length).toBeGreaterThan(8);
    const poly = offsetPathPolygon(pts, 0.5 * MM);
    expect(poly.length).toBeGreaterThan(pts.length * 2);
    // a point on the arc is inside, a point far off the arc is not
    expect(pointInPolygon({ x: 5 * MM, y: 5 * MM }, poly)).toBe(true);
    expect(pointInPolygon({ x: 5 * MM, y: 2 * MM }, poly)).toBe(false);
    // roughly arc length * width
    const r = 5 * MM;
    expect(Math.abs(polygonArea(poly))).toBeCloseTo(Math.PI * r * 0.5 * MM, -12);
  });

  test('buildGraphics emits bounded vertex counts for nm-scale geometry', () => {
    const ctx = new GraphicsContext();
    const host = new Container();
    const used = buildGraphics(
      ctx,
      [
        { kind: 'segment', a: { x: 0, y: 0 }, b: { x: 10 * MM, y: 0 }, width: 0.3 * MM },
        { kind: 'circle', c: { x: 0, y: 0 }, r: 0.4 * MM, width: 0, fill: true },
        { kind: 'circle', c: { x: 0, y: 0 }, r: 2 * MM, width: 0.2 * MM, fill: false },
        { kind: 'arc', start: { x: 0, y: 0 }, mid: { x: 5 * MM, y: 5 * MM }, end: { x: 10 * MM, y: 0 }, width: 0.2 * MM },
        { kind: 'segment', a: { x: 0, y: 0 }, b: { x: 1 * MM, y: 1 * MM }, width: 0 },
      ],
      0,
      0,
      200,
      host,
    );
    expect(used).toBe(true);
    let points = 0;
    for (const ins of ctx.instructions) {
      if (ins.action === 'fill' || ins.action === 'stroke') {
        for (const shape of ins.data.path.shapePath.shapePrimitives) {
          const s = shape.shape as { points?: number[] };
          points += (s.points?.length ?? 0) / 2;
        }
      }
    }
    // a few hundred vertices, not tens of thousands (Pixi's own tessellation in nm units)
    expect(points).toBeGreaterThan(50);
    expect(points).toBeLessThan(600);
    ctx.destroy();
  });
});
