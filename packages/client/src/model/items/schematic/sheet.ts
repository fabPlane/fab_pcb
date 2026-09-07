/** `Sheet` (a hierarchical `SheetSymbol`) and `SheetPin`. */
import { create } from "@bufbuild/protobuf";
import {
  KiCadObjectType,
  SheetPinSchema,
  SheetSymbolSchema,
  type SchematicLabelShape,
  type SheetPath,
  type SheetPin as SheetPinProto,
  type SheetSide,
  type SheetSymbol,
} from "@fp-pcb/proto";
import type { Vec2 } from "../../../units";
import { Item, registerItem } from "../base";
import { SchematicField } from "./symbol";

export class SheetPin extends Item<SheetPinProto> {
  static readonly schema = SheetPinSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_SHEET_PIN;

  constructor(proto: SheetPinProto = create(SheetPinSchema)) {
    super(proto);
  }

  get text(): string {
    return this.proto.text?.text ?? "";
  }
  set text(v: string) {
    if (this.proto.text) this.proto.text.text = v;
  }
  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get shape(): SchematicLabelShape {
    return this.proto.shape;
  }
  get side(): SheetSide {
    return this.proto.side;
  }
  override get net(): string | undefined {
    return this.text || undefined;
  }
}
registerItem(SheetPin);

export class Sheet extends Item<SheetSymbol> {
  static readonly schema = SheetSymbolSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_SHEET;

  constructor(proto: SheetSymbol = create(SheetSymbolSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get size(): Vec2 {
    return this.vec(this.proto.size);
  }
  set size(v: Vec2) {
    this.setVec((x) => (this.proto.size = x), v);
  }
  get name(): string {
    return this.proto.nameField?.text?.text ?? "";
  }
  set name(v: string) {
    if (this.proto.nameField?.text) this.proto.nameField.text.text = v;
  }
  get filename(): string {
    return this.proto.filenameField?.text?.text ?? "";
  }
  get pageNumber(): string {
    return this.proto.pageNumber;
  }
  /** Path *to* this sheet (root first). Use it as the document sheet path to read the sheet's items. */
  get path(): SheetPath | undefined {
    return this.proto.path;
  }
  get pins(): SheetPin[] {
    return this.proto.pins.map((p) => new SheetPin(p));
  }
  get fields(): SchematicField[] {
    const out: SchematicField[] = [];
    if (this.proto.nameField) out.push(new SchematicField(this.proto.nameField));
    if (this.proto.filenameField) out.push(new SchematicField(this.proto.filenameField));
    for (const f of this.proto.userFields) out.push(new SchematicField(f));
    return out;
  }
  get dnp(): boolean {
    return this.proto.dnp;
  }
  get excludeFromBom(): boolean {
    return this.proto.excludeFromBom;
  }
}
registerItem(Sheet);
