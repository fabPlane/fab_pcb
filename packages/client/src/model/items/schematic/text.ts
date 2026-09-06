/** Schematic text items and the four label kinds. */
import { create, type Message } from "@bufbuild/protobuf";
import {
  DirectiveLabelSchema,
  GlobalLabelSchema,
  HierarchicalLabelSchema,
  KiCadObjectType,
  LocalLabelSchema,
  SchematicTextBoxSchema,
  SchematicTextSchema,
  type DirectiveLabel as DirectiveLabelProto,
  type GlobalLabel as GlobalLabelProto,
  type HierarchicalLabel as HierarchicalLabelProto,
  type LocalLabel as LocalLabelProto,
  type SchematicField as SchematicFieldProto,
  type SchematicLabelShape,
  type SchematicLabelSpinStyle,
  type SchematicText as SchematicTextProto,
  type SchematicTextBox as SchematicTextBoxProto,
  type Text,
  type TextAttributes,
} from "@kicad-web/proto";
import { deg, nm, type Vec2 } from "../../../units";
import { Item, registerItem } from "../base";
import { SchematicField } from "./symbol";

export class SchematicText extends Item<SchematicTextProto> {
  static readonly schema = SchematicTextSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_TEXT;

  constructor(proto: SchematicTextProto = create(SchematicTextSchema)) {
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
  get size(): Vec2 {
    return this.vec(this.proto.text?.attributes?.size);
  }
}
registerItem(SchematicText);

export class SchematicTextBox extends Item<SchematicTextBoxProto> {
  static readonly schema = SchematicTextBoxSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_TEXTBOX;

  constructor(proto: SchematicTextBoxProto = create(SchematicTextBoxSchema)) {
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
}
registerItem(SchematicTextBox);

interface LabelLike extends Message {
  position?: { xNm: bigint; yNm: bigint };
  text?: Text;
  spinStyle: SchematicLabelSpinStyle;
  fields: SchematicFieldProto[];
}

/** Shared accessors for local / global / hierarchical / directive labels. */
abstract class LabelBase<M extends LabelLike> extends Item<M> {
  get text(): string {
    return this.proto.text?.text ?? "";
  }
  set text(v: string) {
    if (this.proto.text) this.proto.text.text = v;
  }
  get position(): Vec2 {
    return this.vec(this.proto.position as never);
  }
  set position(v: Vec2) {
    this.setVec((x) => ((this.proto as LabelLike).position = x), v);
  }
  get spinStyle(): SchematicLabelSpinStyle {
    return this.proto.spinStyle;
  }
  set spinStyle(s: SchematicLabelSpinStyle) {
    this.proto.spinStyle = s;
  }
  get attributes(): TextAttributes | undefined {
    return this.proto.text?.attributes;
  }
  get size(): number {
    return nm(this.proto.text?.attributes?.size?.xNm);
  }
  get fields(): SchematicField[] {
    return this.proto.fields.map((f) => new SchematicField(f));
  }
  /** Net name the label drives (its text). */
  override get net(): string | undefined {
    return this.text || undefined;
  }
}

export class LocalLabel extends LabelBase<LocalLabelProto> {
  static readonly schema = LocalLabelSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_LABEL;

  constructor(proto: LocalLabelProto = create(LocalLabelSchema)) {
    super(proto);
  }
}
registerItem(LocalLabel);

export class GlobalLabel extends LabelBase<GlobalLabelProto> {
  static readonly schema = GlobalLabelSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_GLOBAL_LABEL;

  constructor(proto: GlobalLabelProto = create(GlobalLabelSchema)) {
    super(proto);
  }

  get shape(): SchematicLabelShape {
    return this.proto.shape;
  }
  set shape(s: SchematicLabelShape) {
    this.proto.shape = s;
  }
}
registerItem(GlobalLabel);

export class HierarchicalLabel extends LabelBase<HierarchicalLabelProto> {
  static readonly schema = HierarchicalLabelSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_HIER_LABEL;

  constructor(proto: HierarchicalLabelProto = create(HierarchicalLabelSchema)) {
    super(proto);
  }

  get shape(): SchematicLabelShape {
    return this.proto.shape;
  }
  set shape(s: SchematicLabelShape) {
    this.proto.shape = s;
  }
}
registerItem(HierarchicalLabel);

export class DirectiveLabel extends LabelBase<DirectiveLabelProto> {
  static readonly schema = DirectiveLabelSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_DIRECTIVE_LABEL;

  constructor(proto: DirectiveLabelProto = create(DirectiveLabelSchema)) {
    super(proto);
  }

  get shape(): SchematicLabelShape {
    return this.proto.shape;
  }
  get pinLength(): number {
    return nm(this.proto.pinLength);
  }
  get symbolSize(): number {
    return nm(this.proto.symbolSize);
  }
  /** Directive labels do not name nets. */
  override get net(): string | undefined {
    return undefined;
  }
}
registerItem(DirectiveLabel);
