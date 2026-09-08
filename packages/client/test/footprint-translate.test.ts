import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  BoardGraphicShapeSchema,
  BoardLayer,
  BoardTextSchema,
  FieldSchema,
  FootprintInstanceSchema,
  PadSchema,
  packAny,
} from "@fp-pcb/proto";
import { BoardField, BoardShape, BoardText, Footprint, Pad } from "../src/model";

const point = (x: number, y: number) => ({ xNm: BigInt(x), yNm: BigInt(y) });
const text = (value: string, x: number, y: number) =>
  create(BoardTextSchema, {
    id: { value: `${value}-id` },
    layer: BoardLayer.BL_F_SilkS,
    text: { text: value, position: point(x, y), attributes: { angle: { valueDegrees: 37 } } },
  });
const field = (name: string, x: number, y: number) =>
  create(FieldSchema, { id: { id: 5 }, name, visible: true, text: text(name, x, y) });

function fixture(): Footprint {
  const pad = create(PadSchema, {
    id: { value: "pad-id" },
    number: "1",
    position: point(110, 220),
    net: { name: "GND", code: { value: 3 } },
  });
  const label = text("child", 120, 230);
  const userField = field("MPN", 130, 240);
  const shape = create(BoardGraphicShapeSchema, {
    id: { value: "shape-id" },
    layer: BoardLayer.BL_F_Fab,
    shape: { geometry: { case: "segment", value: { start: point(140, 250), end: point(150, 260) } } },
  });
  return new Footprint(
    create(FootprintInstanceSchema, {
      id: { value: "footprint-id" },
      position: point(100, 200),
      orientation: { valueDegrees: 90 },
      layer: BoardLayer.BL_B_Cu,
      referenceField: field("REF", 101, 202),
      valueField: field("VALUE", 103, 204),
      customProperties: [{ key: "owner", value: "test" }],
      definition: {
        id: { libraryNickname: "Test", entryName: "Part" },
        anchor: point(7, 8),
        items: [packAny(PadSchema, pad), packAny(BoardTextSchema, label), packAny(FieldSchema, userField), packAny(BoardGraphicShapeSchema, shape)],
      },
    }),
  );
}

describe("Footprint.translate", () => {
  test("moves the footprint and every absolute child coordinate", () => {
    const footprint = fixture();
    const returned = footprint.translate({ x: 1_000, y: -2_000 });

    expect(returned).toBe(footprint);
    expect(footprint.position).toEqual({ x: 1_100, y: -1_800 });
    expect(footprint.referenceField?.position).toEqual({ x: 1_101, y: -1_798 });
    expect(footprint.valueField?.position).toEqual({ x: 1_103, y: -1_796 });

    const pad = footprint.items.find((item): item is Pad => item instanceof Pad)!;
    const childText = footprint.items.find((item): item is BoardText => item instanceof BoardText)!;
    const userField = footprint.items.find((item): item is BoardField => item instanceof BoardField)!;
    const shape = footprint.items.find((item): item is BoardShape => item instanceof BoardShape)!;
    expect(pad.position).toEqual({ x: 1_110, y: -1_780 });
    expect(childText.position).toEqual({ x: 1_120, y: -1_770 });
    expect(userField.position).toEqual({ x: 1_130, y: -1_760 });
    expect(shape.start).toEqual({ x: 1_140, y: -1_750 });
    expect(shape.end).toEqual({ x: 1_150, y: -1_740 });
  });

  test("preserves rotation, layer, identity, definition anchor, and unrelated properties", () => {
    const footprint = fixture();
    footprint.translate({ x: 10, y: 20 });

    expect(footprint.id).toBe("footprint-id");
    expect(footprint.orientation).toBe(90);
    expect(footprint.layerId).toBe(BoardLayer.BL_B_Cu);
    expect(footprint.libraryId).toBe("Test:Part");
    expect(footprint.customProperties).toEqual({ owner: "test" });
    expect(footprint.proto.definition?.anchor).toMatchObject(point(7, 8));
    expect(footprint.pads[0]?.number).toBe("1");
    expect(footprint.pads[0]?.net).toBe("GND");
  });

  test("a zero translation is an exact no-op", () => {
    const footprint = fixture();
    const before = footprint.clone();
    footprint.translate({ x: 0, y: 0 });
    expect(footprint.equals(before)).toBe(true);
  });
});
