/** `Zone`: copper pours, rule areas, graphical and teardrop zones. */
import { create } from "@bufbuild/protobuf";
import {
  BoardLayer,
  KiCadObjectType,
  NetSchema,
  ZoneSchema,
  ZoneType,
  type PolySet,
  type Zone as ZoneProto,
  type ZoneFilledPolygons,
} from "@kicad-web/proto";
import { nm, toDistance, vec2, type Vec2 } from "../../../units";
import { Item, registerItem } from "../base";

export class Zone extends Item<ZoneProto> {
  static readonly schema = ZoneSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_ZONE;

  constructor(proto: ZoneProto = create(ZoneSchema)) {
    super(proto);
  }

  get zoneType(): ZoneType {
    return this.proto.type;
  }
  get isRuleArea(): boolean {
    return this.proto.type === ZoneType.ZT_RULE_AREA;
  }
  get name(): string {
    return this.proto.name;
  }
  set name(v: string) {
    this.proto.name = v;
  }
  get layers(): BoardLayer[] {
    return this.proto.layers;
  }
  set layers(l: BoardLayer[]) {
    this.proto.layers = l;
  }
  override get layerId(): BoardLayer | undefined {
    return this.proto.layers[0];
  }
  override get net(): string | undefined {
    return this.proto.settings.case === "copperSettings" ? this.proto.settings.value.net?.name || undefined : undefined;
  }
  get netCode(): number | undefined {
    return this.proto.settings.case === "copperSettings" ? this.proto.settings.value.net?.code?.value : undefined;
  }
  setNet(name: string, code?: number): void {
    if (this.proto.settings.case === "copperSettings") {
      this.proto.settings.value.net = create(NetSchema, { name, code: code === undefined ? undefined : { value: code } });
    }
  }
  get priority(): number {
    return this.proto.priority;
  }
  set priority(v: number) {
    this.proto.priority = v;
  }
  get filled(): boolean {
    return this.proto.filled;
  }
  get outline(): PolySet | undefined {
    return this.proto.outline;
  }
  /** Outline vertices of the first polygon (arcs contribute their end points). */
  get outlinePoints(): Vec2[] {
    const nodes = this.proto.outline?.polygons[0]?.outline?.nodes ?? [];
    return nodes.map((n) => (n.geometry.case === "point" ? vec2(n.geometry.value) : vec2(n.geometry.value?.end)));
  }
  get filledPolygons(): ZoneFilledPolygons[] {
    return this.proto.filledPolygons;
  }
  get clearance(): number {
    return this.proto.settings.case === "copperSettings" ? nm(this.proto.settings.value.clearance) : 0;
  }
  set clearance(v: number) {
    if (this.proto.settings.case === "copperSettings") this.proto.settings.value.clearance = toDistance(v);
  }
  get minThickness(): number {
    return this.proto.settings.case === "copperSettings" ? nm(this.proto.settings.value.minThickness) : 0;
  }
}
registerItem(Zone);
