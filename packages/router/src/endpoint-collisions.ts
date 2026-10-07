/** Report-only clearance evidence. No search decisions or copper mutations. All distances are nm. */
import type { Vec2 } from "@fp-pcb/client";
import type { EndpointCollision, EndpointCollisions, RouteConnection, RouteInput, RoutePad } from "./types";

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Distance to actual copper, not a bounding rectangle. Undefined means unsupported. */
function padDistance(p: Vec2, pad: RoutePad): number | undefined {
  if (pad.collisionGeometryUnsupported || pad.size.x <= 0 || pad.size.y <= 0) return undefined;
  // Custom bounds describe only an envelope, never its occupied copper. Do not claim collisions
  // from that envelope or from the anchor's size/rotation, even if a bbox is supplied.
  if (pad.shape === "custom" || pad.shape === "trapezoid" || pad.shape === "chamferedrect") return undefined;
  const angle = (pad.rotation * Math.PI) / 180;
  // KiCad positive rotations are counterclockwise in a board coordinate system with y down.
  const dx = p.x - pad.position.x,
    dy = p.y - pad.position.y;
  const x = Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle));
  const y = Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle));
  const hx = pad.size.x / 2,
    hy = pad.size.y / 2;
  switch (pad.shape) {
    case "circle":
      return hx === hy ? Math.max(0, Math.hypot(x, y) - hx) : undefined;
    case "rect":
      return Math.hypot(Math.max(0, x - hx), Math.max(0, y - hy));
    case "oval": {
      const r = Math.min(hx, hy);
      return Math.max(0, Math.hypot(Math.max(0, x - (hx - r)), Math.max(0, y - (hy - r))) - r);
    }
    case "roundrect": {
      const r = pad.cornerRadius;
      if (r === undefined || !Number.isFinite(r) || r < 0 || r > Math.min(hx, hy)) return undefined;
      return Math.max(0, Math.hypot(Math.max(0, x - (hx - r)), Math.max(0, y - (hy - r))) - r);
    }
  }
}

export function endpointCollisions(input: RouteInput, open: readonly RouteConnection[]): EndpointCollisions {
  const collisions: EndpointCollision[] = [];
  let testedEndpoints = 0,
    unsupported = 0,
    total = 0;
  const pads = new Map(input.pads.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const rules = (net: string) => input.rules.perNet.get(net) ?? input.rules.default;
  // The same effective rules the routers receive, including request overlays. A pad override
  // replaces its net-class clearance; take the larger of the two item rules and board minimum.
  const clearance = (net: string, pad?: RoutePad) => pad?.clearance ?? rules(net).clearance;
  for (const connection of open)
    for (const end of [connection.from, connection.to]) {
      const endpoint = pads.get(end.itemId);
      if (!endpoint) continue;
      for (const layer of endpoint.layers) {
        const key = `${endpoint.id}\0${layer}`;
        if (seen.has(key)) continue;
        seen.add(key);
        testedEndpoints++;
        const radius = rules(endpoint.net).trackWidth / 2;
        const layerName = input.copperLayers.find((l) => l.id === layer)?.userName ?? String(layer);
        const testedItems = new Set<string>();
        const check = (
          item: { id: string; net: string },
          type: EndpointCollision["blocker"]["type"],
          distance: number | undefined,
          pad?: RoutePad,
        ) => {
          if (item.id === endpoint.id || item.net === endpoint.net || testedItems.has(item.id)) return;
          testedItems.add(item.id);
          if (distance === undefined || !Number.isFinite(distance)) {
            unsupported++;
            return;
          }
          const required = Math.max(input.rules.minClearance, clearance(endpoint.net, endpoint), clearance(item.net, pad));
          const measured = Math.max(0, distance - radius);
          if (measured >= required) return;
          total++;
          if (collisions.length < 24)
            collisions.push({
              endpoint: { uuid: endpoint.id, ref: endpoint.footprint, pin: endpoint.number, layer: layerName },
              blocker: { uuid: item.id, type, net: item.net },
              requiredClearanceMm: required / 1e6,
              measuredClearanceMm: measured / 1e6,
              test: "endpoint-track-width",
            });
        };
        for (const pad of input.pads)
          if (pad.layers.includes(layer)) {
            // A custom bbox is useful only to exclude distant envelopes; it is never positive evidence.
            if (pad.shape === "custom" && pad.bounds) {
              const b = pad.bounds,
                p = endpoint.position;
              const lowerBound = Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h));
              const required = Math.max(input.rules.minClearance, clearance(endpoint.net, endpoint), clearance(pad.net, pad));
              if (lowerBound - radius >= required) continue;
            }
            check(pad, "pad", padDistance(endpoint.position, pad), pad);
          }
        for (const via of input.vias)
          if (via.layers.includes(layer))
            check(
              via,
              "via",
              Math.max(0, Math.hypot(endpoint.position.x - via.position.x, endpoint.position.y - via.position.y) - via.diameter / 2),
            );
        for (const track of input.tracks)
          if (track.layer === layer)
            check(
              track,
              "track",
              track.collisionGeometryUnsupported
                ? undefined
                : Math.max(0, segmentDistance(endpoint.position, track.start, track.end) - track.width / 2),
            );
      }
    }
  const detail = collisions
    .slice(0, 3)
    .map(
      (c) =>
        `${c.endpoint.ref}.${c.endpoint.pin} ${c.endpoint.uuid} on ${c.endpoint.layer}; blocker ${c.blocker.uuid} ${c.blocker.type} net ${c.blocker.net || "unassigned"}; clearance required ${c.requiredClearanceMm.toFixed(3)} mm, measured ${c.measuredClearanceMm.toFixed(3)} mm`,
    )
    .join("; ");
  const text = `Endpoint-track-width probe tested against the board before routing: ${testedEndpoints} pad/layer endpoint(s), ${unsupported} unsupported comparison(s). ${total ? `${total} collision(s) established${total > collisions.length ? `; showing ${collisions.length}` : ""}: ${detail}. This does not establish that every escape is blocked.` : "No physical blocker was established by this test."}`;
  return {
    text,
    obstacleSet: "pre-route",
    testedEndpoints,
    unsupported,
    total,
    truncated: total > collisions.length,
    physicalBlockerEstablished: total > 0,
    collisions,
  };
}
