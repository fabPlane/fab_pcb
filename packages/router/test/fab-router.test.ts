import { describe, expect, test } from "bun:test";
import { mm } from "@fp-pcb/client";
import { FabRouter, type FabRouterHooks, type FabRouterSettings, type FabRouterTextResult } from "../src/fab-router";
import { B, F, twoNetBoard } from "./fixtures";
import { writeDsn } from "../src/specctra/dsn";

const SES = `(session "board.ses"
  (base_design "board.dsn")
  (placement (resolution um 10))
  (was_is)
  (routes
    (resolution um 10)
    (parser (host_cad "fab_router") (host_version "0.0.0"))
    (library_out (padstack Via[0-1]_800:400_um (shape (circle F.Cu 8000)) (shape (circle B.Cu 8000))))
    (network_out
      (net A (wire (path F.Cu 2500 50000 -50000 250000 -250000)))
      (net B (wire (path B.Cu 2500 250000 -50000 50000 -250000)) (via Via[0-1]_800:400_um 150000 -150000))
    )
  )
)`;

function success(
  perNet = [
    { net: "A", incomplete: 0 },
    { net: "B", incomplete: 0 },
  ],
): FabRouterTextResult {
  return {
    ok: true,
    ses: SES,
    diagnostics: [],
    report: {
      passes: 1,
      attempted: 2,
      completed: 2,
      incompleteBefore: 2,
      incompleteAfter: perNet.reduce((sum, net) => sum + net.incomplete, 0),
      added: { tracks: 2, barrels: 1 },
      violationsBefore: 0,
      violationsAdded: 0,
      timedOut: false,
      aborted: false,
      stoppedBy: "complete",
      wallClockMs: 3,
      perNet,
    },
  };
}

describe("FabRouter", () => {
  test("uses native hole settings without Freerouting pin classes, retaining NPTH obstacles", async () => {
    const input = twoNetBoard();
    input.rules.holeClearance = mm(0.25);
    input.pads[0]!.size = { x: mm(0.8), y: mm(0.8) };
    input.pads.push({ ...input.pads[0]!, id: "npth", net: "", netCode: 0, nonPlated: true });
    let dsn = "";
    let settings: FabRouterSettings | undefined;
    await new FabRouter({
      routeDsn: (text, received) => {
        dsn = text;
        settings = received;
        return success();
      },
    }).route(input);
    expect(dsn).not.toContain("wire_pin");
    expect(dsn).not.toContain("pin_pin");
    expect(dsn).toContain("fabdesk-drill-npth");
    expect(settings?.holeClearanceUm).toBe(250);
    expect(writeDsn(input)).toContain("wire_pin");
    expect(writeDsn(input)).toContain("fabdesk-drill-npth");
  });

  test("maps controls and native progress hooks, then converts the SES", async () => {
    let settings: FabRouterSettings | undefined;
    let hooks: FabRouterHooks | undefined;
    const phases: string[] = [];
    const router = new FabRouter({
      routeDsn: (_dsn, receivedSettings, receivedHooks) => {
        settings = receivedSettings;
        hooks = receivedHooks;
        receivedHooks?.onPass?.({ pass: 1, incomplete: 1, elapsedMs: 1 });
        receivedHooks?.onProgress?.({ done: 2, total: 2, elapsedMs: 2 });
        return success();
      },
    });

    const result = await router.route(twoNetBoard(), { effort: 3, maxTimeMs: 12_345, viaCost: 9, seed: 7 }, (event) =>
      phases.push(event.phase),
    );

    expect(settings).toEqual({ maxPasses: 3, timeBudgetMs: 12_345, viaCost: 9, seed: 7, copperToEdgeClearanceUm: 200, holeClearanceUm: 0 });
    expect(hooks?.signal).toBeUndefined();
    expect(phases).toEqual(["export", "pass 1", "routing", "import", "done"]);
    expect(result.router).toBe("fab-router");
    expect(result.unrouted).toEqual([]);
    expect(result.tracks).toHaveLength(2);
    expect(result.vias).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ net: "A", netCode: 1, width: mm(0.25), layer: F });
    expect(result.tracks[1]).toMatchObject({ net: "B", netCode: 2, width: mm(0.25), layer: B });
  });

  test("retains copper on incomplete nets for native connection-level cleanup", async () => {
    const router = new FabRouter({
      routeDsn: () =>
        success([
          { net: "A", incomplete: 0 },
          { net: "B", incomplete: 1 },
        ]),
    });
    const result = await router.route(twoNetBoard());

    expect(result.tracks.map((track) => track.net)).toEqual(["A", "B"]);
    expect(result.vias).toHaveLength(1);
    expect(result.unrouted.map((connection) => connection.net)).toEqual(["B"]);
    expect(result.diagnostics?.discarded).toEqual({ tracks: 0, vias: 0 });
  });

  test("surfaces parse diagnostics and honours cancellation", async () => {
    const broken = new FabRouter({
      routeDsn: () => ({
        ok: false,
        error: { message: "missing structure" },
        diagnostics: [{ level: "warning", code: "parse", message: "recovered nothing" }],
      }),
    });
    await expect(broken.route(twoNetBoard())).rejects.toThrow("fab_router failed: missing structure");

    const abort = new AbortController();
    abort.abort();
    let called = false;
    const cancelled = new FabRouter({
      routeDsn: () => {
        called = true;
        return success();
      },
    });
    await expect(cancelled.route(twoNetBoard(), { signal: abort.signal })).rejects.toMatchObject({ name: "RouteCancelled" });
    expect(called).toBe(false);
  });

  test("reports a missing runtime module and rejects unsupported prefab via claiming", async () => {
    const missing = new FabRouter({ moduleSpecifier: "/definitely/missing/fab_router.ts" });
    expect(await missing.available()).toMatchObject({ ok: false, reason: expect.stringContaining("fab_router unavailable") });

    const input = twoNetBoard();
    input.vias.push({
      id: "free-via",
      net: "",
      netCode: 0,
      position: { x: mm(15), y: mm(15) },
      diameter: mm(0.8),
      drill: mm(0.4),
      layers: [F, B],
    });
    await expect(new FabRouter({ routeDsn: () => success() }).route(input)).rejects.toThrow("assignable prefab via");
  });
});

test("declarations reach the DSN request and measurement-only outcomes stay visible", async () => {
  const input = twoNetBoard();
  input.differentialPairs = [{ p: "A", n: "B", widthMm: 0.25, gapMm: 0.2, skewToleranceMm: 0.1 }];
  let received: Parameters<import("../src/fab-router").FabRouteDsn>[3];
  const result = await new FabRouter({
    routeDsn: (_text, _settings, _hooks, request) => {
      received = request;
      return success();
    },
  }).route(input);
  expect(received).toEqual({ differentialPairs: input.differentialPairs, minimumClearanceMm: input.rules.minClearance / 1e6 });
  expect(result.pairRouting).toMatchObject({ capability: "measurement-only", pairs: [{ p: "A", n: "B", status: "independent-fallback" }] });
});
test("coupled-capable solver outcomes are preserved without inventing measurements", async () => {
  const input = twoNetBoard();
  input.differentialPairs = [{ p: "A", n: "B" }];
  const native = success();
  if (!native.ok) throw new Error("fixture");
  native.report.pairCapability = "coupled";
  native.report.pairs = [{ p: "A", n: "B", status: "coupled", reason: null, coupledLengthMm: 12, tuningAddedLengthMm: 0.2 }];
  const result = await new FabRouter({ routeDsn: () => native }).route(input);
  expect(result.pairRouting).toEqual({ capability: "coupled", pairs: native.report.pairs });
});
test("seven-net partial solver result preserves generated copper despite every net remaining open", async () => {
  const input = twoNetBoard();
  const nets = ["GND", "VBUS_USBA", "USB_A_DN", "USB_A_DP", "VBUS_USBA2", "USB_A2_DN", "USB_A2_DP"];
  input.nets = nets.map((name, i) => ({ name, code: i + 1, netClass: "Default" }));
  input.connections = nets.flatMap((net, i) => Array.from({ length: i === 0 ? 4 : 2 }, () => ({ ...input.connections[0]!, net })));
  const native = success(nets.map((net, i) => ({ net, incomplete: i === 0 ? 2 : 1 })));
  if (!native.ok) throw new Error("fixture");
  native.ses = SES.replace(
    /\(net A .*?\n      \(net B .*?\n/s,
    nets
      .map(
        (net, i) =>
          `(net ${net} ${Array.from({ length: i === 0 ? 3 : 2 }, (_, j) => `(wire (path F.Cu 2000 ${50000 + j * 1000} -50000 ${60000 + j * 1000} -50000))`).join(" ")} (via Via[0-1]_800:400_um ${70000 + i * 1000} -70000))`,
      )
      .join("\n"),
  );
  Object.assign(native.report, {
    passes: 4,
    incompleteBefore: 16,
    incompleteAfter: 8,
    stoppedBy: "stagnant",
    added: { tracks: 15, barrels: 7 },
  });
  const result = await new FabRouter({ routeDsn: () => native }).route(input);
  expect(result.tracks).toHaveLength(15);
  expect(result.vias).toHaveLength(7);
  expect(result.diagnostics).toMatchObject({
    solverOpens: { before: 16, after: 8 },
    generated: { tracks: 15, vias: 7 },
    discarded: { tracks: 0, vias: 0 },
    physicalBlockerEstablished: false,
    remaining: { nets: 7, opens: 8 },
  });
  expect(result.diagnostics!.text).toContain("solver opens 16 → 8");
  expect(result.diagnostics!.text).toContain("measured by the bridge");
  expect(JSON.stringify(result)).not.toContain("blockedPads");
});

test("generated and discarded counts exclude protected copper echoed in SES", async () => {
  const input = twoNetBoard();
  input.tracks.push({
    id: "protected",
    net: "A",
    netCode: 1,
    layer: F,
    width: mm(0.25),
    start: { x: mm(5), y: mm(5) },
    end: { x: mm(25), y: mm(25) },
  });
  const native = success([
    { net: "A", incomplete: 1 },
    { net: "B", incomplete: 1 },
  ]);
  const result = await new FabRouter({ routeDsn: () => native }).route(input);
  expect(result.diagnostics).toMatchObject({ generated: { tracks: 1, vias: 1 }, discarded: { tracks: 0, vias: 0 } });
  expect(input.tracks).toHaveLength(1);
});

test("forwards native clearance floors in micrometres and honors explicit solver overrides", async () => {
  const input = twoNetBoard();
  input.rules.edgeClearance = mm(0.5);
  input.rules.holeClearance = mm(0.25);
  let settings: FabRouterSettings | undefined;
  const router = new FabRouter({
    routeDsn: (_dsn, received) => {
      settings = received;
      return success();
    },
  });
  await router.route(input);
  expect(settings).toMatchObject({ copperToEdgeClearanceUm: 500, holeClearanceUm: 250 });
  await router.route(input, { extra: { copperToEdgeClearanceUm: 600, holeClearanceUm: 300 } });
  expect(settings).toMatchObject({ copperToEdgeClearanceUm: 600, holeClearanceUm: 300 });
  await expect(router.route(input, { extra: { holeClearanceUm: -1 } })).rejects.toThrow("invalid fab_router holeClearanceUm");
});
