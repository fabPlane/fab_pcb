import { describe, expect, test } from 'bun:test';
import { Camera } from '../src/core/camera.js';

const MM = 1_000_000;

describe('Camera', () => {
  test('world <-> screen round trip', () => {
    const c = new Camera();
    c.setViewport(800, 600);
    c.setState({ x: 50 * MM, y: 40 * MM, zoom: 1e-5 });
    const s = c.worldToScreen(50 * MM, 40 * MM);
    expect(s).toEqual({ x: 400, y: 300 });
    const w = c.screenToWorld(400 + 10, 300 + 20);
    expect(w.x).toBeCloseTo(50 * MM + 1 * MM, 3);
    expect(w.y).toBeCloseTo(40 * MM + 2 * MM, 3);
    const back = c.worldToScreen(w.x, w.y);
    expect(back.x).toBeCloseTo(410, 9);
    expect(back.y).toBeCloseTo(320, 9);
  });

  test('zoomAt keeps the world point under the cursor fixed', () => {
    const c = new Camera();
    c.setViewport(1000, 800);
    c.setState({ x: 0, y: 0, zoom: 2e-5 });
    const before = c.screenToWorld(120, 700);
    c.zoomAt(120, 700, 1.5);
    expect(c.zoom).toBeCloseTo(3e-5, 12);
    const after = c.screenToWorld(120, 700);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  test('zoom is clamped', () => {
    const c = new Camera();
    c.setState({ zoom: 1e9 });
    expect(c.zoom).toBe(c.maxZoom);
    c.setState({ zoom: 0 });
    expect(c.zoom).toBe(c.maxZoom); // invalid zoom ignored
    c.setState({ zoom: 1e-30 });
    expect(c.zoom).toBe(c.minZoom);
  });

  test('zoomToBox fits with padding', () => {
    const c = new Camera();
    c.setViewport(1000, 500);
    c.zoomToBox({ x: 0, y: 0, w: 100 * MM, h: 20 * MM }, 20);
    expect(c.x).toBe(50 * MM);
    expect(c.y).toBe(10 * MM);
    // limited by width: (1000 - 40) px / 100 mm
    expect(c.zoom).toBeCloseTo(960 / (100 * MM), 15);
    const tl = c.worldToScreen(0, 0);
    expect(tl.x).toBeCloseTo(20, 6);
  });

  test('panByPixels moves the centre in world units', () => {
    const c = new Camera();
    c.setViewport(100, 100);
    c.setState({ x: 0, y: 0, zoom: 1e-3 });
    c.panByPixels(10, -5);
    expect(c.x).toBeCloseTo(-10 / 1e-3, 6);
    expect(c.y).toBeCloseTo(5 / 1e-3, 6);
  });

  test('flipX mirrors the X axis', () => {
    const c = new Camera();
    c.setViewport(200, 200);
    c.setState({ x: 0, y: 0, zoom: 1e-3 });
    c.setFlip(true);
    expect(c.worldToScreen(1000, 0).x).toBe(99); // 100 - 1
    expect(c.screenToWorld(99, 100).x).toBeCloseTo(1000, 6);
    expect(c.rootTransform().scaleX).toBeLessThan(0);
    c.panByPixels(10, 0);
    expect(c.x).toBeCloseTo(10 / 1e-3, 6); // dragging right moves the (mirrored) world right
  });

  test('moving origin rebases only when far away and keeps float32 error tiny', () => {
    const c = new Camera();
    c.setViewport(1000, 1000);
    c.setState({ x: 0, y: 0, zoom: 1e-5 });
    expect(c.maybeRebase()).toBe(false);
    // jump to the far corner of a 500 mm board at high zoom
    c.setState({ x: 500 * MM, y: 500 * MM, zoom: 0.01 });
    expect(c.maybeRebase()).toBe(true);
    expect(c.originX).toBe(500 * MM);
    expect(c.originY).toBe(500 * MM);
    // an item 1 mm from the camera centre: its float32 position relative to the origin
    const rel = Math.fround(501 * MM - c.originX);
    expect(rel).toBe(1 * MM); // exactly representable now
    // versus relative to an origin at 0: 501 mm in float32 loses nm precision
    const bad = Math.fround(501 * MM + 0.37 * 1000) - 501 * MM; // 501.00037 mm
    expect(Math.abs(bad - 370)).toBeGreaterThan(0); // demonstrates float32 loss without rebasing
    const t = c.rootTransform();
    expect(t.x).toBe(500);
    expect(t.y).toBe(500);
    expect(t.scaleX).toBe(0.01);
    // small drift does not rebase again
    c.panByPixels(1000, 0);
    expect(c.maybeRebase()).toBe(false);
  });

  test('change listeners fire and can unsubscribe', () => {
    const c = new Camera();
    let n = 0;
    const off = c.onChange(() => n++);
    c.setState({ x: 1 });
    c.panByPixels(1, 1);
    off();
    c.setState({ x: 2 });
    expect(n).toBe(2);
    expect(c.visibleBox().w).toBeGreaterThan(0);
  });
});
