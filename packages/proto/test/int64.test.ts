import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary, toJson, fromJson } from "@bufbuild/protobuf";
import { DistanceSchema, Vector2Schema, Box2Schema, TrackSchema } from "../src/index.js";

describe("int64 fields are bigint", () => {
  test("Distance.value_nm survives values above 2^53 and negatives", () => {
    for (const v of [0n, 1n, -1n, 2n ** 53n + 1n, -(2n ** 62n), 9_223_372_036_854_775_807n, -9_223_372_036_854_775_808n]) {
      const d = create(DistanceSchema, { valueNm: v });
      expect(typeof d.valueNm).toBe("bigint");
      const back = fromBinary(DistanceSchema, toBinary(DistanceSchema, d));
      expect(back.valueNm).toBe(v);
      expect(typeof back.valueNm).toBe("bigint");
    }
  });

  test("Vector2 x_nm/y_nm are bigint and encode as int64 varints", () => {
    const v = create(Vector2Schema, { xNm: 10_000_000n, yNm: -20_000_000n });
    const back = fromBinary(Vector2Schema, toBinary(Vector2Schema, v));
    expect(back.xNm).toBe(10_000_000n);
    expect(back.yNm).toBe(-20_000_000n);
    // negative int64 takes 10 bytes as a varint
    expect(toBinary(Vector2Schema, v).length).toBe(1 + 4 + 1 + 10);
  });

  test("JSON representation of int64 is a decimal string", () => {
    const b = create(Box2Schema, { position: { xNm: 1n, yNm: 2n }, size: { xNm: 2n ** 40n, yNm: 0n } });
    const json = toJson(Box2Schema, b) as { size: { xNm: string } };
    expect(json.size.xNm).toBe(String(2n ** 40n));
    expect(fromJson(Box2Schema, json).size?.xNm).toBe(2n ** 40n);
  });

  test("a nested board item keeps bigint through a binary round trip", () => {
    const t = create(TrackSchema, { start: { xNm: 5n, yNm: 6n }, end: { xNm: 7n, yNm: 8n }, width: { valueNm: 250_000n } });
    const back = fromBinary(TrackSchema, toBinary(TrackSchema, t));
    expect(back.width?.valueNm).toBe(250_000n);
    expect(back.end?.yNm).toBe(8n);
  });
});
