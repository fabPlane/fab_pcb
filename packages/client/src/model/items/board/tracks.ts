/** Board copper routing items: `Track`, `Arc`, `Via`. */
import { create } from "@bufbuild/protobuf";
import {
  ArcSchema,
  BoardLayer,
  KiCadObjectType,
  NetSchema,
  TrackSchema,
  ViaSchema,
  ViaType,
  type Arc as ArcProto,
  type PadStack,
  type Track as TrackProto,
  type Via as ViaProto,
} from "@kicad-web/proto";
import { nm, toDistance, type Vec2 } from "../../../units";
import { Item, registerItem } from "../base";

function setNet(target: { net?: { name: string; code?: { value: number } } }, name: string, code?: number): void {
  target.net = create(NetSchema, { name, code: code === undefined ? undefined : { value: code } });
}

export class Track extends Item<TrackProto> {
  static readonly schema = TrackSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_TRACE;

  constructor(proto: TrackProto = create(TrackSchema)) {
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
  get width(): number {
    return nm(this.proto.width);
  }
  set width(v: number) {
    this.proto.width = toDistance(v);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
  get netCode(): number | undefined {
    return this.proto.net?.code?.value;
  }
  setNet(name: string, code?: number): void {
    setNet(this.proto, name, code);
  }
  get length(): number {
    return Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y);
  }
}
registerItem(Track);

export class Arc extends Item<ArcProto> {
  static readonly schema = ArcSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_ARC;

  constructor(proto: ArcProto = create(ArcSchema)) {
    super(proto);
  }

  get start(): Vec2 {
    return this.vec(this.proto.start);
  }
  set start(v: Vec2) {
    this.setVec((x) => (this.proto.start = x), v);
  }
  get mid(): Vec2 {
    return this.vec(this.proto.mid);
  }
  set mid(v: Vec2) {
    this.setVec((x) => (this.proto.mid = x), v);
  }
  get end(): Vec2 {
    return this.vec(this.proto.end);
  }
  set end(v: Vec2) {
    this.setVec((x) => (this.proto.end = x), v);
  }
  get width(): number {
    return nm(this.proto.width);
  }
  set width(v: number) {
    this.proto.width = toDistance(v);
  }
  override get layerId(): BoardLayer {
    return this.proto.layer;
  }
  set layerId(l: BoardLayer) {
    this.proto.layer = l;
  }
  get netCode(): number | undefined {
    return this.proto.net?.code?.value;
  }
  setNet(name: string, code?: number): void {
    setNet(this.proto, name, code);
  }

  /** Centre and radius derived from the three points (undefined when collinear). */
  get circle(): { center: Vec2; radius: number } | undefined {
    const a = this.start;
    const b = this.mid;
    const c = this.end;
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (d === 0) return undefined;
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { center: { x: ux, y: uy }, radius: Math.hypot(a.x - ux, a.y - uy) };
  }
}
registerItem(Arc);

export class Via extends Item<ViaProto> {
  static readonly schema = ViaSchema;
  static readonly objectType = KiCadObjectType.KOT_PCB_VIA;

  constructor(proto: ViaProto = create(ViaSchema)) {
    super(proto);
  }

  get position(): Vec2 {
    return this.vec(this.proto.position);
  }
  set position(v: Vec2) {
    this.setVec((x) => (this.proto.position = x), v);
  }
  get padStack(): PadStack | undefined {
    return this.proto.padStack;
  }
  get viaType(): ViaType {
    return this.proto.type;
  }
  set viaType(t: ViaType) {
    this.proto.type = t;
  }
  /** Copper layers the via spans (first = start layer). */
  get layers(): BoardLayer[] {
    return this.proto.padStack?.layers ?? [];
  }
  /** Primary layer for indexing: the padstack's first layer. */
  override get layerId(): BoardLayer | undefined {
    return this.proto.padStack?.layers[0];
  }
  /** Diameter on the first copper layer (the size of the first pad stack layer entry). */
  get diameter(): number {
    return nm(this.proto.padStack?.copperLayers[0]?.size?.xNm);
  }
  get drillDiameter(): number {
    return nm(this.proto.padStack?.drill?.diameter?.xNm);
  }
  get netCode(): number | undefined {
    return this.proto.net?.code?.value;
  }
  setNet(name: string, code?: number): void {
    setNet(this.proto, name, code);
  }
  get isFree(): boolean {
    return this.proto.isFree;
  }
}
registerItem(Via);
