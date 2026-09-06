import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Box2Schema, DistanceSchema, Vector2Schema } from "@kicad-web/proto";
import {
  box2,
  boxFromPoints,
  boxUnion,
  deg,
  fromBigInt,
  inch,
  mil,
  mm,
  nm,
  toAngle,
  toBox2,
  toDistance,
  toMil,
  toMm,
  toNm,
  toVector2,
  vec2,
  vecRotate,
} from "../src/units";

describe("units", () => {
  test("nm reads Distance, bigint, number and missing values", () => {
    expect(nm(create(DistanceSchema, { valueNm: 1_500_000n }))).toBe(1_500_000);
    expect(nm(42n)).toBe(42);
    expect(nm(7)).toBe(7);
    expect(nm(undefined)).toBe(0);
    expect(nm(null)).toBe(0);
  });

  test("bigint conversion round trips and rejects unsafe values", () => {
    expect(toNm(1234.6)).toBe(1235n);
    expect(fromBigInt(-5n)).toBe(-5);
    expect(() => fromBigInt(2n ** 60n)).toThrow(RangeError);
    expect(toDistance(mm(1)).valueNm).toBe(1_000_000n);
  });

  test("mm / mil / inch conversions", () => {
    expect(mm(2.54)).toBeCloseTo(2_540_000, 6);
    expect(toMm(2_540_000)).toBeCloseTo(2.54, 9);
    expect(mil(100)).toBe(2_540_000);
    expect(toMil(2_540_000)).toBe(100);
    expect(inch(1)).toBe(25_400_000);
  });

  test("angles", () => {
    expect(deg(toAngle(90))).toBe(90);
    expect(deg(undefined)).toBe(0);
    expect(deg(45)).toBe(45);
  });

  test("Vector2 / Box2 helpers", () => {
    const v = toVector2({ x: 10, y: -20 });
    expect(v.xNm).toBe(10n);
    expect(v.yNm).toBe(-20n);
    expect(vec2(v)).toEqual({ x: 10, y: -20 });
    expect(vec2(undefined)).toEqual({ x: 0, y: 0 });
    const b = box2(create(Box2Schema, { position: create(Vector2Schema, { xNm: 1n, yNm: 2n }), size: create(Vector2Schema, { xNm: 3n, yNm: 4n }) }));
    expect(b).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(box2(toBox2(b))).toEqual(b);
  });

  test("box geometry", () => {
    expect(boxFromPoints([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: -2, y: 8 }])).toEqual({ x: -2, y: 0, w: 12, h: 8 });
    expect(boxUnion({ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 6, h: 6 });
    expect(boxUnion({ x: 0, y: 0, w: 0, h: 0 }, { x: 5, y: 5, w: 1, h: 1 })).toEqual({ x: 5, y: 5, w: 1, h: 1 });
  });

  test("vecRotate follows KiCad's y-down convention", () => {
    const r = vecRotate({ x: 10, y: 0 }, 90);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(10, 9);
  });
});
