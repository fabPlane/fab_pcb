/** `SchematicSymbol` (a placed `SchematicSymbolInstance`), `SchematicPin`, `SchematicField`. */
import { create } from "@bufbuild/protobuf";
import {
  KiCadObjectType,
  SchematicFieldSchema,
  SchematicPinSchema,
  SchematicSymbolInstanceSchema,
  SchematicSymbolOrientation,
  SchematicSymbolSchema,
  type ElectricalPinType,
  type SchematicField as SchematicFieldProto,
  type SchematicPin as SchematicPinProto,
  type SchematicSymbol as SymbolDefinition,
  type SchematicSymbolAttributes,
  type SchematicSymbolInstance,
  type SheetPath,
  type TextAttributes,
} from "@kicad-web/proto";
import { nm, type Vec2 } from "../../../units";
import { Item, registerItem, wrapAll } from "../base";

export class SchematicField extends Item<SchematicFieldProto> {
  static readonly schema = SchematicFieldSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_FIELD;

  constructor(proto: SchematicFieldProto = create(SchematicFieldSchema)) {
    super(proto);
  }

  /** Schematic fields carry no KIID in the API (yet). */
  override get id(): string {
    return "";
  }
  get name(): string {
    return this.proto.name;
  }
  set name(v: string) {
    this.proto.name = v;
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
  get visible(): boolean {
    return this.proto.visible;
  }
  set visible(v: boolean) {
    this.proto.visible = v;
  }
  get showName(): boolean {
    return this.proto.showName;
  }
}
registerItem(SchematicField);

export class SchematicPin extends Item<SchematicPinProto> {
  static readonly schema = SchematicPinSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_PIN;

  constructor(proto: SchematicPinProto = create(SchematicPinSchema)) {
    super(proto);
  }

  get name(): string {
    return this.proto.name;
  }
  get number(): string {
    return this.proto.number;
  }
  /** Position in the symbol's own coordinate system. */
  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  get length(): number {
    return nm(this.proto.length);
  }
  get orientation(): SchematicPinProto["orientation"] {
    return this.proto.orientation;
  }
  get electricalType(): ElectricalPinType {
    return this.proto.electricalType;
  }
  get visible(): boolean {
    return this.proto.visible;
  }
}
registerItem(SchematicPin);

export const ORIENTATION_DEGREES: Record<SchematicSymbolOrientation, number> = {
  [SchematicSymbolOrientation.SSO_UNKNOWN]: 0,
  [SchematicSymbolOrientation.SSO_0]: 0,
  [SchematicSymbolOrientation.SSO_90]: 90,
  [SchematicSymbolOrientation.SSO_180]: 180,
  [SchematicSymbolOrientation.SSO_270]: 270,
};

export class SchematicSymbol extends Item<SchematicSymbolInstance> {
  static readonly schema = SchematicSymbolInstanceSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_SYMBOL;

  constructor(proto: SchematicSymbolInstance = create(SchematicSymbolInstanceSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  /** Sheet the instance lives on (its path is the schematic "document" for commits). */
  get sheetPath(): SheetPath | undefined {
    return this.proto.path;
  }
  get orientation(): SchematicSymbolOrientation {
    return this.proto.transform?.orientation ?? SchematicSymbolOrientation.SSO_0;
  }
  get rotation(): number {
    return ORIENTATION_DEGREES[this.orientation] ?? 0;
  }
  get mirrorX(): boolean {
    return this.proto.transform?.mirrorX ?? false;
  }
  get mirrorY(): boolean {
    return this.proto.transform?.mirrorY ?? false;
  }
  get reference(): string {
    return this.proto.referenceField?.text?.text ?? "";
  }
  set reference(v: string) {
    if (this.proto.referenceField?.text) this.proto.referenceField.text.text = v;
  }
  get value(): string {
    return this.proto.valueField?.text?.text ?? "";
  }
  set value(v: string) {
    if (this.proto.valueField?.text) this.proto.valueField.text.text = v;
  }
  get footprint(): string {
    return this.proto.footprintField?.text?.text ?? "";
  }
  get datasheet(): string {
    return this.proto.datasheetField?.text?.text ?? "";
  }
  get description(): string {
    return this.proto.descriptionField?.text?.text ?? "";
  }
  /** Library id as `nickname:name`. */
  get libraryId(): string {
    const id = this.proto.libId ?? this.proto.definition?.id;
    return id ? `${id.libraryNickname}:${id.entryName}` : "";
  }
  get unit(): number {
    return this.proto.unit?.unit ?? 1;
  }
  get bodyStyle(): number {
    return this.proto.bodyStyle?.style ?? 1;
  }
  get attributes(): SchematicSymbolAttributes | undefined {
    return this.proto.attributes;
  }
  get doNotPopulate(): boolean {
    return this.proto.attributes?.doNotPopulate ?? false;
  }
  get excludeFromBom(): boolean {
    return this.proto.attributes?.excludeFromBillOfMaterials ?? false;
  }
  get definition(): SymbolDefinition | undefined {
    return this.proto.definition;
  }
  get isPower(): boolean {
    const t = this.proto.definition?.type;
    return t === 2 || t === 3;
  }
  /** Mandatory + user fields as wrappers (editing them edits this message). */
  get fields(): SchematicField[] {
    const p = this.proto;
    const out: SchematicField[] = [];
    for (const f of [p.referenceField, p.valueField, p.footprintField, p.datasheetField, p.descriptionField]) {
      if (f) out.push(new SchematicField(f));
    }
    for (const f of p.userFields) out.push(new SchematicField(f));
    return out;
  }
  field(name: string): SchematicField | undefined {
    return this.fields.find((f) => f.name === name);
  }
  /** Library-definition children (pins, shapes, texts) in symbol coordinates. */
  get definitionItems(): Item[] {
    return wrapAll((this.proto.definition?.items ?? []).map((c) => c.item!).filter(Boolean));
  }
  /** Definition children that belong to this instance's unit and body style. */
  get unitItems(): Item[] {
    const unit = this.unit;
    const style = this.bodyStyle;
    const children = (this.proto.definition?.items ?? []).filter((c) => {
      const u = c.unit?.unit;
      const s = c.bodyStyle?.style;
      return (u === undefined || u === 0 || u === unit) && (s === undefined || s === 0 || s === style);
    });
    return wrapAll(children.map((c) => c.item!).filter(Boolean));
  }
  get pins(): SchematicPin[] {
    return this.unitItems.filter((i): i is SchematicPin => i instanceof SchematicPin);
  }
}
registerItem(SchematicSymbol);

/**
 * A library symbol definition (`kiapi.schematic.types.SchematicSymbol`, `KOT_LIB_SYMBOL`): what a
 * headless symbol document returns for `GetItems(KOT_LIB_SYMBOL)` and what `SchematicSymbol.definition`
 * embeds. Children (pins, shapes, texts, fields) are in symbol coordinates.
 */
export class LibSymbol extends Item<SymbolDefinition> {
  static readonly schema = SchematicSymbolSchema;
  static readonly objectType = KiCadObjectType.KOT_LIB_SYMBOL;

  constructor(proto: SymbolDefinition = create(SchematicSymbolSchema)) {
    super(proto);
  }

  /** Library symbols carry no KIID; the library id is the identity. */
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
    return this.proto.referenceField?.text?.text ?? "";
  }
  get value(): string {
    return this.proto.valueField?.text?.text ?? "";
  }
  get description(): string {
    return this.proto.descriptionField?.text?.text ?? "";
  }
  get keywords(): string {
    return this.proto.keywords;
  }
  get footprintFilters(): string[] {
    return [...this.proto.footprintFilters];
  }
  get unitCount(): number {
    return this.proto.unitCount;
  }
  get isPower(): boolean {
    return this.proto.type === 2 || this.proto.type === 3;
  }
  /** Every child (all units / body styles) as wrappers. */
  get items(): Item[] {
    return wrapAll(this.proto.items.map((c) => c.item!).filter(Boolean));
  }
  /** Children of one unit / body style (0 = shared by all). */
  unitItems(unit: number, bodyStyle = 1): Item[] {
    const children = this.proto.items.filter((c) => {
      const u = c.unit?.unit;
      const s = c.bodyStyle?.style;
      return (u === undefined || u === 0 || u === unit) && (s === undefined || s === 0 || s === bodyStyle);
    });
    return wrapAll(children.map((c) => c.item!).filter(Boolean));
  }
  get pins(): SchematicPin[] {
    return this.items.filter((i): i is SchematicPin => i instanceof SchematicPin);
  }
}
registerItem(LibSymbol);
