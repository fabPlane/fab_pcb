/** `BoardGroup` and `Constraint` (parametric placement constraints). */
import { create } from "@bufbuild/protobuf";
import {
  BoardGroupSchema,
  ConstraintSchema,
  ConstraintType,
  KIIDSchema,
  KiCadObjectType,
  type BoardGroup as BoardGroupProto,
  type Constraint as ConstraintProto,
  type ConstraintMember,
} from "@kicad-web/proto";
import { Item, registerItem } from "../base";

export class BoardGroup extends Item<BoardGroupProto> {
  static readonly schema = BoardGroupSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_GROUP;

  constructor(proto: BoardGroupProto = create(BoardGroupSchema)) {
    super(proto);
  }

  get name(): string {
    return this.proto.name;
  }
  set name(v: string) {
    this.proto.name = v;
  }
  /** KIIDs of the member items. */
  get items(): string[] {
    return this.proto.items.map((k) => k.value);
  }
  set items(ids: string[]) {
    this.proto.items = ids.map((value) => create(KIIDSchema, { value }));
  }
  addItem(id: string): void {
    if (!this.proto.items.some((k) => k.value === id)) this.proto.items.push(create(KIIDSchema, { value: id }));
  }
  removeItem(id: string): void {
    this.proto.items = this.proto.items.filter((k) => k.value !== id);
  }
  get libraryId(): string {
    const id = this.proto.libId;
    return id ? `${id.libraryNickname}:${id.entryName}` : "";
  }
}
registerItem(BoardGroup);

export class Constraint extends Item<ConstraintProto> {
  static readonly schema = ConstraintSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_CONSTRAINT;

  constructor(proto: ConstraintProto = create(ConstraintSchema)) {
    super(proto);
  }

  get constraintType(): ConstraintType {
    return this.proto.type;
  }
  get members(): ConstraintMember[] {
    return this.proto.members;
  }
  get memberIds(): string[] {
    return this.proto.members.map((m) => m.item?.value ?? "").filter(Boolean);
  }
  get value(): number | undefined {
    return this.proto.value;
  }
  set value(v: number | undefined) {
    this.proto.value = v;
  }
  get driving(): boolean {
    return this.proto.driving;
  }
}
registerItem(Constraint);
