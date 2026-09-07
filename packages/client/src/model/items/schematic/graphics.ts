/** Schematic graphics: shapes, images, tables, rule areas. */
import { create } from "@bufbuild/protobuf";
import {
  KiCadObjectType,
  SchematicGraphicShapeSchema,
  SchematicImageSchema,
  SchematicRuleAreaSchema,
  SchematicTableCellSchema,
  SchematicTableSchema,
  type GraphicShape,
  type SchematicGraphicShape,
  type SchematicImage as SchematicImageProto,
  type SchematicRuleArea as SchematicRuleAreaProto,
  type SchematicTable as SchematicTableProto,
  type SchematicTableCell as SchematicTableCellProto,
} from "@fp-pcb/proto";
import { nm, toDistance, type Vec2 } from "../../../units";
import { shapeKind, type ShapeKind } from "../board/graphics";
import { Item, registerItem } from "../base";

export class SchematicShape extends Item<SchematicGraphicShape> {
  static readonly schema = SchematicGraphicShapeSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_SHAPE;

  constructor(proto: SchematicGraphicShape = create(SchematicGraphicShapeSchema)) {
    super(proto);
  }

  get shape(): GraphicShape | undefined {
    return this.proto.shape;
  }
  get kind(): ShapeKind {
    return shapeKind(this.proto.shape);
  }
  get strokeWidth(): number {
    return nm(this.proto.shape?.attributes?.stroke?.width);
  }
  set strokeWidth(v: number) {
    const s = this.proto.shape?.attributes?.stroke;
    if (s) s.width = toDistance(v);
  }
}
registerItem(SchematicShape);

export class SchematicImage extends Item<SchematicImageProto> {
  static readonly schema = SchematicImageSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_BITMAP;

  constructor(proto: SchematicImageProto = create(SchematicImageSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get scale(): number {
    return this.proto.imageScale?.value ?? 1;
  }
  get imageData(): Uint8Array {
    return this.proto.imageData;
  }
}
registerItem(SchematicImage);

export class SchematicTableCell extends Item<SchematicTableCellProto> {
  static readonly schema = SchematicTableCellSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_TABLECELL;

  constructor(proto: SchematicTableCellProto = create(SchematicTableCellSchema)) {
    super(proto);
  }

  override get id(): string {
    return this.proto.textBox?.id?.value ?? "";
  }
  get text(): string {
    return this.proto.textBox?.textbox?.text ?? "";
  }
  set text(v: string) {
    if (this.proto.textBox?.textbox) this.proto.textBox.textbox.text = v;
  }
  get columnSpan(): number {
    return this.proto.columnSpan;
  }
  get rowSpan(): number {
    return this.proto.rowSpan;
  }
}
registerItem(SchematicTableCell);

export class SchematicTable extends Item<SchematicTableProto> {
  static readonly schema = SchematicTableSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_TABLE;

  constructor(proto: SchematicTableProto = create(SchematicTableSchema)) {
    super(proto);
  }

  get columnCount(): number {
    return this.proto.columnCount;
  }
  get cells(): SchematicTableCell[] {
    return this.proto.cells.map((c) => new SchematicTableCell(c));
  }
  get columnWidths(): number[] {
    return this.proto.columnWidths.map((d) => nm(d));
  }
  get rowHeights(): number[] {
    return this.proto.rowHeights.map((d) => nm(d));
  }
}
registerItem(SchematicTable);

export class SchematicRuleArea extends Item<SchematicRuleAreaProto> {
  static readonly schema = SchematicRuleAreaSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_RULE_AREA;

  constructor(proto: SchematicRuleAreaProto = create(SchematicRuleAreaSchema)) {
    super(proto);
  }

  get shape(): GraphicShape | undefined {
    return this.proto.shape;
  }
  get excludeFromSim(): boolean {
    return this.proto.excludeFromSim;
  }
  get excludeFromBom(): boolean {
    return this.proto.excludeFromBom;
  }
  get excludeFromBoard(): boolean {
    return this.proto.excludeFromBoard;
  }
  get dnp(): boolean {
    return this.proto.dnp;
  }
}
registerItem(SchematicRuleArea);
