/**
 * `applyRouteResult(board, result)`: creates the routed tracks and vias in **one** commit
 * (`BeginCommit` + one batched `CreateItems` + `EndCommit`), so a single `Undo` removes the whole
 * routing pass. Also the proto builders (`trackProto`, `viaProto`) the adapters and tests share.
 */
import { create } from "@bufbuild/protobuf";
import {
  BoardLayer,
  DrillShape,
  NetSchema,
  PadStackShape,
  PadStackType,
  TrackSchema,
  ViaSchema,
  ViaType,
  type Track as TrackProto,
  type Via as ViaProto,
} from "@fp-pcb/proto";
import { Track, Via, toDistance, toVector2, type Board, type CommitResult, type Item } from "@fp-pcb/client";
import type { NewTrack, NewVia, RouteResult } from "./types";

function net(name: string, code: number) {
  return create(NetSchema, { name, code: code ? { value: code } : undefined });
}

export function trackProto(t: NewTrack): TrackProto {
  return create(TrackSchema, {
    start: toVector2({ x: Math.round(t.start.x), y: Math.round(t.start.y) }),
    end: toVector2({ x: Math.round(t.end.x), y: Math.round(t.end.y) }),
    width: toDistance(Math.round(t.width)),
    layer: t.layer,
    net: net(t.net, t.netCode),
  });
}

/**
 * A through via. KiCad's `PADSTACK::Deserialize` requires the copper entry of a NORMAL pad stack
 * to be keyed on `F_Cu` (its `ALL_LAYERS` marker) — that is not "the via is only on F.Cu".
 */
export function viaProto(v: NewVia): ViaProto {
  const top = v.layers[0] ?? BoardLayer.BL_F_Cu;
  const bottom = v.layers[v.layers.length - 1] ?? BoardLayer.BL_B_Cu;
  const size = toVector2({ x: Math.round(v.diameter), y: Math.round(v.diameter) });
  const drill = toVector2({ x: Math.round(v.drill), y: Math.round(v.drill) });
  return create(ViaSchema, {
    position: toVector2({ x: Math.round(v.position.x), y: Math.round(v.position.y) }),
    type: top === BoardLayer.BL_F_Cu && bottom === BoardLayer.BL_B_Cu ? ViaType.VT_THROUGH : ViaType.VT_BLIND_BURIED,
    net: net(v.net, v.netCode),
    padStack: {
      type: PadStackType.PST_NORMAL,
      layers: [...v.layers],
      drill: { startLayer: top, endLayer: bottom, diameter: drill, shape: DrillShape.DS_CIRCLE },
      copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: PadStackShape.PSS_CIRCLE, size }],
    },
  });
}

/** Drops zero-length tracks and merges nothing else: the router owns the geometry. */
export function itemsFor(result: Pick<RouteResult, "tracks" | "vias">): Item[] {
  const items: Item[] = [];
  for (const t of result.tracks) {
    if (Math.round(t.start.x) === Math.round(t.end.x) && Math.round(t.start.y) === Math.round(t.end.y)) continue;
    items.push(new Track(trackProto(t)));
  }
  for (const v of result.vias) items.push(new Via(viaProto(v)));
  return items;
}

export interface ApplyOptions {
  /** Commit message shown in KiCad's undo history. */
  message?: string;
  /** Skip items KiCad rejects instead of dropping the commit (default: strict, i.e. throw). */
  strict?: boolean;
}

/** One commit with every track and via of `result`; resolves to the canonical items KiCad created. */
export async function applyRouteResult(board: Board, result: RouteResult, opts: ApplyOptions = {}): Promise<CommitResult<Item[]>> {
  const items = itemsFor(result);
  const message = opts.message ?? `Autoroute (${result.router}): ${result.tracks.length} tracks, ${result.vias.length} vias`;
  return board.commit(message, (tx) => (items.length ? tx.create(items) : Promise.resolve([])), undefined, { strict: opts.strict ?? true });
}
