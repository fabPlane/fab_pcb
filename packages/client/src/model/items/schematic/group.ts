/** `SchematicGroup`. */
import { create } from "@bufbuild/protobuf";
import { KIIDSchema, KiCadObjectType, SchematicGroupSchema, type SchematicGroup as SchematicGroupProto } from "@kicad-web/proto";
import { Item, registerItem } from "../base";

export class SchematicGroup extends Item<SchematicGroupProto> {
  static readonly schema = SchematicGroupSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_GROUP;

  constructor(proto: SchematicGroupProto = create(SchematicGroupSchema)) {
    super(proto);
  }

  get name(): string {
    return this.proto.name;
  }
  set name(v: string) {
    this.proto.name = v;
  }
  get items(): string[] {
    return this.proto.items.map((k) => k.value);
  }
  set items(ids: string[]) {
    this.proto.items = ids.map((value) => create(KIIDSchema, { value }));
  }
}
registerItem(SchematicGroup);
