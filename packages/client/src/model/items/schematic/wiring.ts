/** Connectivity primitives: `SchematicLine` (wire / bus / graphic line), `Junction`, `NoConnect`, `BusEntry`. */
import { create } from "@bufbuild/protobuf";
import {
  BusEntrySchema,
  BusEntryType,
  JunctionSchema,
  KiCadObjectType,
  NoConnectMarkerSchema,
  SchematicLineSchema,
  SchematicLineType,
  type BusEntry as BusEntryProto,
  type Junction as JunctionProto,
  type NoConnectMarker,
  type SchematicLine as SchematicLineProto,
  type StrokeAttributes,
} from "@fp-pcb/proto";
import { nm, toDistance, type Vec2 } from "../../../units";
import { Item, registerItem } from "../base";

export class SchematicLine extends Item<SchematicLineProto> {
  static readonly schema = SchematicLineSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_LINE;

  constructor(proto: SchematicLineProto = create(SchematicLineSchema)) {
    super(proto);
  }

  get start(): Vec2 {
    return this.vec(this.proto.start);
  }
  set start(v: Vec2) {
    this.setVec((x) => (this.proto.start = x), v);
  }
  get end(): Vec2 {
    return this.vec(this.proto.end);
  }
  set end(v: Vec2) {
    this.setVec((x) => (this.proto.end = x), v);
  }
  get lineType(): SchematicLineType {
    return this.proto.type;
  }
  set lineType(t: SchematicLineType) {
    this.proto.type = t;
  }
  get isWire(): boolean {
    return this.proto.type === SchematicLineType.SLT_WIRE;
  }
  get isBus(): boolean {
    return this.proto.type === SchematicLineType.SLT_BUS;
  }
  get stroke(): StrokeAttributes | undefined {
    return this.proto.stroke;
  }
  get width(): number {
    return nm(this.proto.stroke?.width);
  }
  set width(v: number) {
    if (this.proto.stroke) this.proto.stroke.width = toDistance(v);
  }
}
registerItem(SchematicLine);

export class Junction extends Item<JunctionProto> {
  static readonly schema = JunctionSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_JUNCTION;

  constructor(proto: JunctionProto = create(JunctionSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get diameter(): number {
    return nm(this.proto.diameter);
  }
}
registerItem(Junction);

export class NoConnect extends Item<NoConnectMarker> {
  static readonly schema = NoConnectMarkerSchema;
  static readonly objectType = KiCadObjectType.KOT_SCH_NO_CONNECT;

  constructor(proto: NoConnectMarker = create(NoConnectMarkerSchema)) {
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
}
registerItem(NoConnect);

export class BusEntry extends Item<BusEntryProto> {
  static readonly schema = BusEntrySchema;
  /** Nominal; the instance `type` depends on the entry kind (wire-to-bus vs bus-to-bus). */
  static readonly objectType = KiCadObjectType.KOT_SCH_BUS_WIRE_ENTRY;

  constructor(proto: BusEntryProto = create(BusEntrySchema)) {
    super(proto);
  }

  override get type(): KiCadObjectType {
    return this.proto.type === BusEntryType.BET_BUS_TO_BUS
      ? KiCadObjectType.KOT_SCH_BUS_BUS_ENTRY
      : KiCadObjectType.KOT_SCH_BUS_WIRE_ENTRY;
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
  get entryType(): BusEntryType {
    return this.proto.type;
  }
}
registerItem(BusEntry);
