/** `Footprint` (a placed `FootprintInstance`), `Pad`, and `BoardField`. */
import { create } from "@bufbuild/protobuf";
import {
  BoardLayer,
  FieldSchema,
  FootprintInstanceSchema,
  FootprintSchema,
  KiCadObjectType,
  NetSchema,
  PadSchema,
  PadType,
  kiapiRegistry,
  packAny,
  unpackAny,
  type BoardGraphicShape,
  type BoardText,
  type BoardTextBox,
  type Field as FieldProto,
  type Footprint as FootprintDefinition,
  type FootprintAttributes,
  type FootprintInstance,
  type Pad as PadProto,
  type PadStack,
  type Vector2,
} from "@fp-pcb/proto";
import { deg, nm, toAngle, toVector2, vec2, type Vec2 } from "../../../units";
import { Item, registerItem, wrapAll } from "../base";

export class BoardField extends Item<FieldProto> {
  static readonly schema = FieldSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_FIELD;

  constructor(proto: FieldProto = create(FieldSchema)) {
    super(proto);
  }

  /** Fields carry their KIID inside the nested `BoardText`. */
  override get id(): string {
    return this.proto.text?.id?.value ?? "";
  }
  override set id(value: string) {
    if (!this.proto.text) this.proto.text = create(FieldSchema).text!;
    this.proto.text!.id = { $typeName: "kiapi.common.types.KIID", value };
  }
  /** Field number; 0 = reference, 1 = value, 2 = footprint, 3 = datasheet, 4 = description, >= 5 user. */
  get fieldId(): number {
    return this.proto.id?.id ?? 0;
  }
  get name(): string {
    return this.proto.name;
  }
  set name(v: string) {
    this.proto.name = v;
  }
  get text(): string {
    return this.proto.text?.text?.text ?? "";
  }
  set text(v: string) {
    if (this.proto.text?.text) this.proto.text.text.text = v;
  }
  get visible(): boolean {
    return this.proto.visible;
  }
  set visible(v: boolean) {
    this.proto.visible = v;
  }
  get position(): Vec2 {
    return this.vec(this.proto.text?.text?.position);
  }
  override get layerId(): BoardLayer | undefined {
    return this.proto.text?.layer;
  }
  override get parent(): string | undefined {
    return this.proto.text?.parent?.value || undefined;
  }
  override get locked(): boolean {
    return this.proto.text?.locked === 2;
  }
}
registerItem(BoardField);

export class Pad extends Item<PadProto> {
  static readonly schema = PadSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_PAD;

  constructor(proto: PadProto = create(PadSchema)) {
    super(proto);
  }

  get number(): string {
    return this.proto.number;
  }
  set number(v: string) {
    this.proto.number = v;
  }
  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get padType(): PadType {
    return this.proto.type;
  }
  set padType(t: PadType) {
    this.proto.type = t;
  }
  get padStack(): PadStack | undefined {
    return this.proto.padStack;
  }
  get layers(): BoardLayer[] {
    return this.proto.padStack?.layers ?? [];
  }
  override get layerId(): BoardLayer | undefined {
    return this.proto.padStack?.layers[0];
  }
  /** Size on the first copper layer entry of the pad stack. */
  get size(): Vec2 {
    return this.vec(this.proto.padStack?.copperLayers[0]?.size);
  }
  get orientation(): number {
    return deg(this.proto.padStack?.angle);
  }
  get drillDiameter(): Vec2 {
    return this.vec(this.proto.padStack?.drill?.diameter);
  }
  get netCode(): number | undefined {
    return this.proto.net?.code?.value;
  }
  setNet(name: string, code?: number): void {
    this.proto.net = create(NetSchema, { name, code: code === undefined ? undefined : { value: code } });
  }
  get pinName(): string | undefined {
    return this.proto.symbolPin?.name;
  }
  get padToDieLength(): number {
    return nm(this.proto.padToDieLength);
  }
}
registerItem(Pad);

export class Footprint extends Item<FootprintInstance> {
  static readonly schema = FootprintInstanceSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_FOOTPRINT;

  constructor(proto: FootprintInstance = create(FootprintInstanceSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  /**
   * Move the footprint and every child coordinate KiCad serializes in the board frame. Merely
   * changing `position` is insufficient: footprint deserialization restores pads, fields, text,
   * and graphics from their absolute child coordinates after setting the anchor.
   */
  translate(delta: Vec2): this {
    if (!delta.x && !delta.y) return this;
    this.proto.position = shifted(this.proto.position, delta);
    for (const field of mandatoryFields(this.proto)) translateField(field, delta);
    const definition = this.proto.definition;
    if (definition) {
      for (const field of mandatoryFields(definition)) translateField(field, delta);
      definition.items = definition.items.map((any) => {
        const item = unpackAny(any);
        if (!item || !translateFootprintChild(item, delta)) return any;
        return packAny(itemSchema(item.$typeName), item);
      });
    }
    return this;
  }
  /** Rotation in degrees. */
  get orientation(): number {
    return deg(this.proto.orientation);
  }
  set orientation(d: number) {
    this.proto.orientation = toAngle(d);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
  get isFlipped(): boolean {
    return this.proto.layer === BoardLayer.BL_B_Cu;
  }
  get reference(): string {
    return this.proto.referenceField?.text?.text?.text ?? "";
  }
  set reference(v: string) {
    if (this.proto.referenceField?.text?.text) this.proto.referenceField.text.text.text = v;
  }
  get value(): string {
    return this.proto.valueField?.text?.text?.text ?? "";
  }
  set value(v: string) {
    if (this.proto.valueField?.text?.text) this.proto.valueField.text.text.text = v;
  }
  get datasheet(): string {
    return this.proto.datasheetField?.text?.text?.text ?? "";
  }
  get description(): string {
    return this.proto.descriptionField?.text?.text?.text ?? "";
  }
  get referenceField(): BoardField | undefined {
    return this.proto.referenceField ? new BoardField(this.proto.referenceField) : undefined;
  }
  get valueField(): BoardField | undefined {
    return this.proto.valueField ? new BoardField(this.proto.valueField) : undefined;
  }
  get attributes(): FootprintAttributes | undefined {
    return this.proto.attributes;
  }
  get doNotPopulate(): boolean {
    return this.proto.attributes?.doNotPopulate ?? false;
  }
  get excludeFromBom(): boolean {
    return this.proto.attributes?.excludeFromBillOfMaterials ?? false;
  }
  /** The library definition (pads, graphics, 3D models) the instance was placed from. */
  get definition(): FootprintDefinition | undefined {
    return this.proto.definition;
  }
  /** Library id as `nickname:name`. */
  get libraryId(): string {
    const id = this.proto.definition?.id;
    return id ? `${id.libraryNickname}:${id.entryName}` : "";
  }
  /** Sheet path of the driving schematic symbol (`symbol_path`), human readable. */
  get symbolPath(): string {
    return this.proto.symbolPath?.pathHumanReadable ?? "";
  }
  /**
   * Child items embedded in the definition (pads, shapes, texts, fields...). These are snapshots;
   * to edit a pad, fetch it with `board.getPads()` (which sets `parent`) and update it in a commit.
   */
  get items(): Item[] {
    return wrapAll(this.proto.definition?.items ?? []);
  }
  get pads(): Pad[] {
    return this.items.filter((i): i is Pad => i instanceof Pad);
  }
  get padCount(): number {
    return this.pads.length;
  }
  /** Set the net of the pad numbered `padNumber` inside the definition snapshot. */
  padByNumber(padNumber: string): Pad | undefined {
    return this.pads.find((p) => p.number === padNumber);
  }
  padSizeOf(padNumber: string): number {
    return nm(this.padByNumber(padNumber)?.proto.padStack?.copperLayers[0]?.size?.xNm);
  }
}
registerItem(Footprint);

function shifted(value: Vector2 | undefined, delta: Vec2): Vector2 {
  const p = vec2(value);
  return toVector2({ x: p.x + delta.x, y: p.y + delta.y });
}

function mandatoryFields(container: {
  referenceField?: FieldProto;
  valueField?: FieldProto;
  datasheetField?: FieldProto;
  descriptionField?: FieldProto;
}): FieldProto[] {
  return [container.referenceField, container.valueField, container.datasheetField, container.descriptionField].filter(
    (field): field is FieldProto => field !== undefined,
  );
}

function translateField(field: FieldProto, delta: Vec2): void {
  const text = field.text?.text;
  if (text) text.position = shifted(text.position, delta);
}

function translateShape(shape: BoardGraphicShape["shape"], delta: Vec2): void {
  const geometry = shape?.geometry;
  if (!geometry?.case) return;
  const shift = (owner: Record<string, unknown>, key: string) => {
    owner[key] = shifted(owner[key] as Vector2 | undefined, delta);
  };
  const value = geometry.value as unknown as Record<string, unknown>;
  switch (geometry.case) {
    case "segment":
      shift(value, "start");
      shift(value, "end");
      break;
    case "rectangle":
      shift(value, "topLeft");
      shift(value, "bottomRight");
      break;
    case "arc":
      shift(value, "start");
      shift(value, "mid");
      shift(value, "end");
      break;
    case "circle":
      shift(value, "center");
      shift(value, "radiusPoint");
      break;
    case "bezier":
      for (const key of ["start", "control1", "control2", "end"]) shift(value, key);
      break;
    case "ellipse":
    case "ellipseArc":
      shift(value, "center");
      break;
    case "polygon": {
      const polygons = value.polygons as Array<{ outline?: { nodes: unknown[] }; holes: Array<{ nodes: unknown[] }> }>;
      for (const polygon of polygons) {
        for (const line of [polygon.outline, ...polygon.holes]) {
          for (const node of line?.nodes ?? []) {
            const nodeGeometry = (node as { geometry: { case?: string; value: unknown } }).geometry;
            if (nodeGeometry.case === "point") nodeGeometry.value = shifted(nodeGeometry.value as Vector2, delta);
            if (nodeGeometry.case === "arc") {
              const arc = nodeGeometry.value as unknown as Record<string, unknown>;
              for (const key of ["start", "mid", "end"]) shift(arc, key);
            }
          }
        }
      }
    }
  }
}

/** Translate the coordinate-bearing item kinds a footprint definition may embed. */
function translateFootprintChild(item: { $typeName: string } & Record<string, unknown>, delta: Vec2): boolean {
  switch (item.$typeName) {
    case "kiapi.board.types.Pad":
    case "kiapi.board.types.ReferenceImage":
    case "kiapi.board.types.ReferencePoint":
    case "kiapi.board.types.Barcode":
      item.position = shifted(item.position as Vector2 | undefined, delta);
      return true;
    case "kiapi.board.types.Field":
      translateField(item as unknown as FieldProto, delta);
      return true;
    case "kiapi.board.types.BoardText": {
      const text = (item as unknown as BoardText).text;
      if (text) text.position = shifted(text.position, delta);
      return true;
    }
    case "kiapi.board.types.BoardTextBox": {
      const box = (item as unknown as BoardTextBox).textbox;
      if (box) {
        box.topLeft = shifted(box.topLeft, delta);
        box.bottomRight = shifted(box.bottomRight, delta);
      }
      return true;
    }
    case "kiapi.board.types.BoardGraphicShape":
      translateShape((item as unknown as BoardGraphicShape).shape, delta);
      return true;
    default:
      return false;
  }
}

function itemSchema(typeName: string) {
  const schema = kiapiRegistry.getMessage(typeName);
  if (!schema) throw new Error(`unknown footprint child type ${typeName}`);
  return schema;
}

/**
 * The *library* definition of a footprint (`kiapi.board.types.Footprint`), as
 * `library_commands.proto` exchanges it — the counterpart of `LibSymbol` for symbols. A placed
 * `Footprint` carries one of these in `definition`; this wrapper is what
 * `kicad.libraries.footprints.get()` returns and what `save()` writes back.
 */
export class LibFootprint extends Item<FootprintDefinition> {
  static readonly schema = FootprintSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_FOOTPRINT;

  constructor(proto: FootprintDefinition = create(FootprintSchema)) {
    super(proto);
  }

  /** Library footprints carry no KIID; the library id is the identity. */
  override get id(): string {
    return "";
  }
  /** `nickname:name` */
  get libraryId(): string {
    const id = this.proto.id;
    return id ? `${id.libraryNickname}:${id.entryName}` : "";
  }
  get name(): string {
    return this.proto.id?.entryName ?? "";
  }
  get reference(): string {
    return this.proto.referenceField?.text?.text?.text ?? "";
  }
  get value(): string {
    return this.proto.valueField?.text?.text?.text ?? "";
  }
  set value(v: string) {
    if (this.proto.valueField?.text?.text) this.proto.valueField.text.text.text = v;
  }
  get description(): string {
    return this.proto.descriptionField?.text?.text?.text ?? "";
  }
  get datasheet(): string {
    return this.proto.datasheetField?.text?.text?.text ?? "";
  }
  get attributes(): FootprintAttributes | undefined {
    return this.proto.attributes;
  }
  get anchor(): Vec2 {
    return this.vec(this.proto.anchor);
  }
  /** Every child item of the definition (pads, shapes, texts, ...). */
  get items(): Item[] {
    return wrapAll(this.proto.items);
  }
  get pads(): Pad[] {
    return this.items.filter((i): i is Pad => i instanceof Pad);
  }
  get padCount(): number {
    return this.pads.length;
  }
}
registerItem(LibFootprint);
