/**
 * Item wrappers: thin classes over the protobuf messages KiCad returns from `GetItems` and friends.
 *
 * Design rules (docs/02-typescript-api.md):
 * - plain data + methods, no hidden network calls in getters;
 * - every wrapper keeps the original message (`proto`), so fields the wrapper does not know about
 *   survive an update round trip untouched;
 * - lengths are exposed as `number` nanometres, angles as degrees; conversions live in `../../units`.
 *
 * `wrapAny()` turns a `google.protobuf.Any` from a response into the right wrapper class using the
 * registry that each item module populates with `registerItem()`; unknown message types become a
 * `GenericItem` so new KiCad item types still flow through the store.
 */
import { clone, create, equals, toJson, type DescMessage, type JsonValue, type Message } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import {
  BoardLayer,
  CustomPropertySchema,
  KIIDSchema,
  KiCadObjectType,
  LockedState,
  kiapiRegistry,
  packAny,
  unpackAny,
  type CustomProperty,
  type KIID,
  type Vector2,
} from "@kicad-web/proto";
import { toVector2, vec2, type Vec2 } from "../../units";

export interface ItemClass<M extends Message = Message> {
  new (proto?: M): Item<M>;
  readonly schema: DescMessage;
  readonly objectType: KiCadObjectType;
}

const registry = new Map<string, ItemClass>();

/** Registers a wrapper class for its proto type; called by each item module at load time. */
export function registerItem<M extends Message>(cls: ItemClass<M>): void {
  registry.set(cls.schema.typeName, cls as unknown as ItemClass);
}

export function itemClassFor(typeName: string): ItemClass | undefined {
  return registry.get(typeName);
}

/** All registered proto type names -> wrapper classes. */
export function registeredItemClasses(): ReadonlyMap<string, ItemClass> {
  return registry;
}

export abstract class Item<M extends Message = Message> {
  /** The protobuf message this wrapper edits in place. */
  proto: M;

  constructor(proto: M) {
    this.proto = proto;
  }

  get schema(): DescMessage {
    return (this.constructor as ItemClass).schema;
  }

  /** `KiCadObjectType` of the item (a few classes derive it from message content). */
  get type(): KiCadObjectType {
    return (this.constructor as ItemClass).objectType;
  }

  /** Enum name of `type`, e.g. `KOT_PCB_FOOTPRINT` (what `StoredItem.type` carries). */
  get typeName(): string {
    return KiCadObjectType[this.type] ?? "KOT_UNKNOWN";
  }

  /** The KIID (36-char UUID form); empty string when the item has none. */
  get id(): string {
    return (this.proto as unknown as { id?: KIID }).id?.value ?? "";
  }

  set id(value: string) {
    (this.proto as unknown as { id?: KIID }).id = create(KIIDSchema, { value });
  }

  /** Primary board layer id, e.g. `BL_F_Cu`; undefined for schematic items. */
  get layer(): string | undefined {
    const l = this.layerId;
    return l === undefined ? undefined : (BoardLayer[l] ?? undefined);
  }

  /** Primary board layer as the enum value. */
  get layerId(): BoardLayer | undefined {
    const l = (this.proto as unknown as { layer?: BoardLayer }).layer;
    return typeof l === "number" ? l : undefined;
  }

  /** Net name when the item is connectable. */
  get net(): string | undefined {
    const n = (this.proto as unknown as { net?: { name?: string } }).net;
    return n?.name || undefined;
  }

  /** KIID of the containing footprint / group / table, when the message carries one. */
  get parent(): string | undefined {
    return (this.proto as unknown as { parent?: KIID }).parent?.value || undefined;
  }

  /** Whether the item is locked; false for item types without a lock flag. */
  get locked(): boolean {
    return (this.proto as unknown as { locked?: LockedState }).locked === LockedState.LS_LOCKED;
  }

  set locked(v: boolean) {
    const p = this.proto as unknown as { locked?: LockedState };
    if ("locked" in p) p.locked = v ? LockedState.LS_LOCKED : LockedState.LS_UNLOCKED;
  }

  /** Free-form key/value properties KiCad stores on most items. */
  get customProperties(): Record<string, string> {
    const list = (this.proto as unknown as { customProperties?: CustomProperty[] }).customProperties ?? [];
    return Object.fromEntries(list.map((p) => [p.key, p.value]));
  }

  setCustomProperty(key: string, value: string | undefined): void {
    const p = this.proto as unknown as { customProperties?: CustomProperty[] };
    if (!p.customProperties) p.customProperties = [];
    const i = p.customProperties.findIndex((x) => x.key === key);
    if (value === undefined) {
      if (i >= 0) p.customProperties.splice(i, 1);
    } else if (i >= 0) {
      p.customProperties[i]!.value = value;
    } else {
      p.customProperties.push(create(CustomPropertySchema, { key, value }));
    }
  }

  /** The underlying message (same object as `proto`). */
  toProto(): M {
    return this.proto;
  }

  toAny(): Any {
    return packAny(this.schema, this.proto);
  }

  /** JSON form (with the kiapi registry, so nested `Any` fields such as group members encode). */
  toJson(): JsonValue {
    return toJson(this.schema, this.proto, { registry: kiapiRegistry });
  }

  clone(): this {
    const cls = this.constructor as ItemClass<M>;
    return new cls(clone(this.schema, this.proto) as M) as this;
  }

  /** Deep equality of the underlying messages. */
  equals(other: Item): boolean {
    return other.schema.typeName === this.schema.typeName && equals(this.schema, this.proto, other.proto as M);
  }

  toString(): string {
    return `${this.constructor.name}(${this.id})`;
  }

  // --- helpers for subclasses -----------------------------------------------------------------

  protected vec(v: Vector2 | undefined): Vec2 {
    return vec2(v);
  }

  protected setVec(assign: (v: Vector2) => void, value: Vec2): void {
    assign(toVector2(value));
  }
}

/** Wrapper for messages no specific class handles (new KiCad item types, DRC markers, ...). */
export class GenericItem extends Item<Message> {
  static readonly schema: DescMessage = {} as DescMessage;
  static readonly objectType = KiCadObjectType.KOT_UNKNOWN;
  private readonly desc: DescMessage;
  private readonly objType: KiCadObjectType;

  constructor(proto: Message, desc: DescMessage, objectType: KiCadObjectType = KiCadObjectType.KOT_UNKNOWN) {
    super(proto);
    this.desc = desc;
    this.objType = objectType;
  }

  override get schema(): DescMessage {
    return this.desc;
  }

  override get type(): KiCadObjectType {
    return this.objType;
  }

  override clone(): this {
    return new GenericItem(clone(this.desc, this.proto), this.desc, this.objType) as this;
  }
}

/** Proto type names that map to a `KiCadObjectType` without having a dedicated wrapper class. */
const EXTRA_TYPES: Record<string, KiCadObjectType> = {
  "kiapi.board.DrcMarker": KiCadObjectType.KOT_PCB_MARKER,
};

/** `KiCadObjectType` for a proto type name (via the wrapper registry), or KOT_UNKNOWN. */
export function objectTypeOf(typeName: string): KiCadObjectType {
  return registry.get(typeName)?.objectType ?? EXTRA_TYPES[typeName] ?? KiCadObjectType.KOT_UNKNOWN;
}

/** Wraps a decoded message in its item class. */
export function wrapMessage(msg: Message, desc?: DescMessage): Item {
  const cls = registry.get(msg.$typeName);
  if (cls) return new cls(msg);
  const d = desc ?? (unpackDesc(msg.$typeName) as DescMessage);
  return new GenericItem(msg, d, objectTypeOf(msg.$typeName));
}

/** Unpacks an `Any` from a response and wraps it; returns undefined when the type is unknown to the registry. */
export function wrapAny(any: Any): Item | undefined {
  const msg = unpackAny(any);
  if (!msg) return undefined;
  return wrapMessage(msg);
}

/** Wraps every `Any` in a response, dropping ones whose type is unknown. */
export function wrapAll(anys: Iterable<Any>): Item[] {
  const out: Item[] = [];
  for (const a of anys) {
    const item = wrapAny(a);
    if (item) out.push(item);
  }
  return out;
}

export function isItem(x: unknown): x is Item {
  return x instanceof Item;
}

/** Accepts wrappers or raw messages and returns the `Any` to send. */
export function toAnyItem(x: Item | Message | Any): Any {
  if (x instanceof Item) return x.toAny();
  if ("typeUrl" in x && typeof (x as Any).typeUrl === "string" && (x as Message).$typeName === "google.protobuf.Any") return x as Any;
  const msg = x as Message;
  const cls = registry.get(msg.$typeName);
  const desc = cls?.schema ?? unpackDesc(msg.$typeName);
  return packAny(desc, msg);
}

function unpackDesc(typeName: string): DescMessage {
  const d = kiapiRegistry.getMessage(typeName);
  if (!d) throw new Error(`unknown message type ${typeName}`);
  return d;
}
