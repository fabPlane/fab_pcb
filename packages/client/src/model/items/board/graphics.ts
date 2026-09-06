/** Board graphic / annotation items: shapes, text, text boxes, barcodes, images, dimensions, tables, grids, points. */
import { create } from "@bufbuild/protobuf";
import {
  BarcodeSchema,
  BoardGraphicShapeSchema,
  BoardLayer,
  BoardTextBoxSchema,
  BoardTextSchema,
  DimensionSchema,
  GridItemSchema,
  KiCadObjectType,
  ReferenceImageSchema,
  ReferencePointSchema,
  TableCellSchema,
  TableSchema,
  type Barcode as BarcodeProto,
  type BoardGraphicShape,
  type BoardText as BoardTextProto,
  type BoardTextBox as BoardTextBoxProto,
  type Dimension as DimensionProto,
  type GraphicShape,
  type GridItem as GridItemProto,
  type ReferenceImage as ReferenceImageProto,
  type ReferencePoint as ReferencePointProto,
  type Table as TableProto,
  type TableCell as TableCellProto,
  type TextAttributes,
  type Vector2,
} from "@kicad-web/proto";
import { deg, nm, toAngle, toDistance, type Vec2 } from "../../../units";
import { Item, registerItem } from "../base";

export type ShapeKind = "segment" | "rectangle" | "arc" | "circle" | "polygon" | "bezier" | "ellipse" | "ellipseArc" | "none";

/** Geometry kind of a `GraphicShape` oneof. */
export function shapeKind(shape: GraphicShape | undefined): ShapeKind {
  const c = shape?.geometry.case;
  return c === undefined ? "none" : c;
}

export class BoardShape extends Item<BoardGraphicShape> {
  static readonly schema = BoardGraphicShapeSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_SHAPE;

  constructor(proto: BoardGraphicShape = create(BoardGraphicShapeSchema)) {
    super(proto);
  }

  get shape(): GraphicShape | undefined {
    return this.proto.shape;
  }
  get kind(): ShapeKind {
    return shapeKind(this.proto.shape);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
  get strokeWidth(): number {
    return nm(this.proto.shape?.attributes?.stroke?.width);
  }
  set strokeWidth(v: number) {
    const s = this.proto.shape?.attributes?.stroke;
    if (s) s.width = toDistance(v);
  }
  /** Start point for segment/arc/bezier, top-left for rectangles, centre for circles/ellipses. */
  get start(): Vec2 {
    const g = this.proto.shape?.geometry;
    switch (g?.case) {
      case "segment":
      case "arc":
      case "bezier":
        return this.vec(g.value.start);
      case "rectangle":
        return this.vec(g.value.topLeft);
      case "circle":
      case "ellipse":
      case "ellipseArc":
        return this.vec(g.value.center);
      default:
        return { x: 0, y: 0 };
    }
  }
  get end(): Vec2 {
    const g = this.proto.shape?.geometry;
    switch (g?.case) {
      case "segment":
      case "arc":
      case "bezier":
        return this.vec(g.value.end);
      case "rectangle":
        return this.vec(g.value.bottomRight);
      case "circle":
        return this.vec(g.value.radiusPoint);
      default:
        return { x: 0, y: 0 };
    }
  }
}
registerItem(BoardShape);

export class BoardText extends Item<BoardTextProto> {
  static readonly schema = BoardTextSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_TEXT;

  constructor(proto: BoardTextProto = create(BoardTextSchema)) {
    super(proto);
  }

  get text(): string {
    return this.proto.text?.text ?? "";
  }
  set text(v: string) {
    if (this.proto.text) this.proto.text.text = v;
  }
  get position(): Vec2 {
    return this.vec(this.proto.text?.position);
  }
  set position(v: Vec2) {
    if (this.proto.text) this.setVec((x) => (this.proto.text!.position = x), v);
  }
  get attributes(): TextAttributes | undefined {
    return this.proto.text?.attributes;
  }
  get angle(): number {
    return deg(this.proto.text?.attributes?.angle);
  }
  set angle(d: number) {
    if (this.proto.text?.attributes) this.proto.text.attributes.angle = toAngle(d);
  }
  get size(): Vec2 {
    return this.vec(this.proto.text?.attributes?.size);
  }
  get thickness(): number {
    return nm(this.proto.text?.attributes?.strokeWidth);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
  get knockout(): boolean {
    return this.proto.knockout;
  }
  set knockout(v: boolean) {
    this.proto.knockout = v;
  }
}
registerItem(BoardText);

export class BoardTextBox extends Item<BoardTextBoxProto> {
  static readonly schema = BoardTextBoxSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_TEXTBOX;

  constructor(proto: BoardTextBoxProto = create(BoardTextBoxSchema)) {
    super(proto);
  }

  get text(): string {
    return this.proto.textbox?.text ?? "";
  }
  set text(v: string) {
    if (this.proto.textbox) this.proto.textbox.text = v;
  }
  get topLeft(): Vec2 {
    return this.vec(this.proto.textbox?.topLeft);
  }
  get bottomRight(): Vec2 {
    return this.vec(this.proto.textbox?.bottomRight);
  }
  get attributes(): TextAttributes | undefined {
    return this.proto.textbox?.attributes;
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
}
registerItem(BoardTextBox);

export class Barcode extends Item<BarcodeProto> {
  static readonly schema = BarcodeSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_BARCODE;

  constructor(proto: BarcodeProto = create(BarcodeSchema)) {
    super(proto);
  }

  get text(): string {
    return this.proto.text;
  }
  set text(v: string) {
    this.proto.text = v;
  }
  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get orientation(): number {
    return deg(this.proto.orientation);
  }
  get width(): number {
    return nm(this.proto.width);
  }
  get height(): number {
    return nm(this.proto.height);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
}
registerItem(Barcode);

export class ReferenceImage extends Item<ReferenceImageProto> {
  static readonly schema = ReferenceImageSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_REFERENCE_IMAGE;

  constructor(proto: ReferenceImageProto = create(ReferenceImageSchema)) {
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
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
}
registerItem(ReferenceImage);

export type DimensionKind = "aligned" | "orthogonal" | "radial" | "leader" | "center" | "none";

export class Dimension extends Item<DimensionProto> {
  static readonly schema = DimensionSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_DIMENSION;

  constructor(proto: DimensionProto = create(DimensionSchema)) {
    super(proto);
  }

  get kind(): DimensionKind {
    return this.proto.dimensionStyle.case ?? "none";
  }
  /** First anchor point: `start` for aligned/orthogonal/leader, `center` for radial/center dimensions. */
  get start(): Vec2 {
    const s = this.proto.dimensionStyle;
    if (!s.case) return { x: 0, y: 0 };
    const v = s.value as { start?: Vector2; center?: Vector2 };
    return this.vec(v.start ?? v.center);
  }
  /** Second anchor point: `end` for most kinds, `radiusPoint` for radial dimensions. */
  get end(): Vec2 {
    const s = this.proto.dimensionStyle;
    if (!s.case) return { x: 0, y: 0 };
    const v = s.value as { end?: Vector2; radiusPoint?: Vector2 };
    return this.vec(v.end ?? v.radiusPoint);
  }
  get text(): string {
    return this.proto.text?.text ?? "";
  }
  get overrideText(): string | undefined {
    return this.proto.overrideTextEnabled ? this.proto.overrideText : undefined;
  }
  get lineThickness(): number {
    return nm(this.proto.lineThickness);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
}
registerItem(Dimension);

export class BoardTableCell extends Item<TableCellProto> {
  static readonly schema = TableCellSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_TABLECELL;

  constructor(proto: TableCellProto = create(TableCellSchema)) {
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
  override get layerId(): BoardLayer | undefined {
    return this.proto.textBox?.layer;
  }
  override get parent(): string | undefined {
    return this.proto.textBox?.parent?.value || undefined;
  }
}
registerItem(BoardTableCell);

export class BoardTable extends Item<TableProto> {
  static readonly schema = TableSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_TABLE;

  constructor(proto: TableProto = create(TableSchema)) {
    super(proto);
  }

  get columnCount(): number {
    return this.proto.columnCount;
  }
  get rowCount(): number {
    return this.proto.columnCount ? Math.ceil(this.proto.cells.length / this.proto.columnCount) : 0;
  }
  get cells(): BoardTableCell[] {
    return this.proto.cells.map((c) => new BoardTableCell(c));
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
}
registerItem(BoardTable);

export class GridItem extends Item<GridItemProto> {
  static readonly schema = GridItemSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_GRIDITEM;

  constructor(proto: GridItemProto = create(GridItemSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get orientation(): number {
    return deg(this.proto.orientation);
  }
  get kind(): "cartesian" | "polar" | "none" {
    return this.proto.geometry.case ?? "none";
  }
}
registerItem(GridItem);

export class ReferencePoint extends Item<ReferencePointProto> {
  static readonly schema = ReferencePointSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_POINT;

  constructor(proto: ReferencePointProto = create(ReferencePointSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get size(): number {
    return nm(this.proto.size);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
}
registerItem(ReferencePoint);
