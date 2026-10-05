import { describe, expect, test } from "bun:test";
import { mm } from "@fp-pcb/client";
import { FabRouter, type FabRouterHooks, type FabRouterSettings, type FabRouterTextResult } from "../src/fab-router";
import { B, F, twoNetBoard } from "./fixtures";

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

    expect(settings).toEqual({ maxPasses: 3, timeBudgetMs: 12_345, viaCost: 9, seed: 7 });
    expect(hooks?.signal).toBeUndefined();
    expect(phases).toEqual(["export", "pass 1", "routing", "import", "done"]);
    expect(result.router).toBe("fab-router");
    expect(result.unrouted).toEqual([]);
    expect(result.tracks).toHaveLength(2);
    expect(result.vias).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ net: "A", netCode: 1, width: mm(0.25), layer: F });
    expect(result.tracks[1]).toMatchObject({ net: "B", netCode: 2, width: mm(0.25), layer: B });
  });

  test("drops partial copper for an incomplete net instead of applying dangling stubs", async () => {
    const router = new FabRouter({
      routeDsn: () =>
        success([
          { net: "A", incomplete: 0 },
          { net: "B", incomplete: 1 },
        ]),
    });
    const result = await router.route(twoNetBoard());

    expect(result.tracks.map((track) => track.net)).toEqual(["A"]);
    expect(result.vias).toEqual([]);
    expect(result.unrouted.map((connection) => connection.net)).toEqual(["B"]);
    expect(result.log).toContain("discarded partial copper on 1 incomplete net(s): 1 track(s), 1 via(s)");
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
test("seven-net partial solver result reports 16 → 8, 15 discarded tracks and 7 vias", async () => {
  const input = twoNetBoard();
  const nets = ["GND","VBUS_USBA","USB_A_DN","USB_A_DP","VBUS_USBA2","USB_A2_DN","USB_A2_DP"];
  input.nets=nets.map((name,i)=>({name,code:i+1,netClass:"Default"}));
  input.connections=nets.flatMap((net,i)=>Array.from({length:i===0?4:2},()=>({...input.connections[0]!,net})));
  const native=success(nets.map((net,i)=>({net,incomplete:i===0?2:1})));
  if(!native.ok)throw new Error("fixture");
  native.ses=SES.replace(/\(net A .*?\n      \(net B .*?\n/s,nets.map((net,i)=>`(net ${net} ${Array.from({length:i===0?3:2},(_,j)=>`(wire (path F.Cu 2000 ${50000+j*1000} -50000 ${60000+j*1000} -50000))`).join(" ")} (via Via[0-1]_800:400_um ${70000+i*1000} -70000))`).join("\n"));
  Object.assign(native.report,{passes:4,incompleteBefore:16,incompleteAfter:8,stoppedBy:"stagnant",added:{tracks:15,barrels:7},search:{searches:148,popsUsed:4440148,popLimit:30000,maxPopsUsed:30001,maxSearchLimit:30000,stoppedBy:{"pop-limit":148}}});
  const result=await new FabRouter({routeDsn:()=>native}).route(input);
  expect(result.tracks).toHaveLength(0);
  expect(result.vias).toHaveLength(0);
  expect(result.diagnostics).toMatchObject({solverOpens:{before:16,after:8},generated:{tracks:15,vias:7},discarded:{tracks:15,vias:7},physicalBlockerEstablished:false,remaining:{nets:7,opens:8},search:{popLimit:30000}});
  expect(result.diagnostics!.text).toContain("solver opens 16 → 8");
  expect(result.diagnostics!.text).toContain("No physical blocker was established");
  expect(JSON.stringify(result)).not.toContain("blockedPads");
});

test("collision evidence names native UUIDs and clearance, without inferring enclosure", async () => {
  const input = twoNetBoard(), pad = input.pads[0]!, blocker = input.pads[2]!;
  const native=success([{net:"A",incomplete:1},{net:"B",incomplete:1}]);
  if(!native.ok)throw new Error("fixture");
  native.report.endpointCollisions=[{endpoint:{modelId:1,ref:"DSN",pin:"1",xMm:pad.position.x/1e6,yMm:pad.position.y/1e6},layer:"F.Cu",blocker:{modelId:2,type:"pad",net:"B",xMm:blocker.position.x/1e6,yMm:blocker.position.y/1e6},requiredClearanceMm:0.2,measuredClearanceMm:0.05,test:"endpoint-track-width"}];
  const result=await new FabRouter({routeDsn:()=>native}).route(input);
  expect(result.diagnostics!.collisions[0]).toMatchObject({endpoint:{uuid:pad.id,ref:pad.footprint,pin:pad.number,layer:"F.Cu"},blocker:{uuid:blocker.id,type:"pad",net:blocker.net},requiredClearanceMm:0.2,measuredClearanceMm:0.05});
  expect(result.diagnostics!.text).toContain("blocked pad under endpoint-track-width test");
  expect(result.diagnostics!.text).toContain("does not establish that every escape is blocked");
});
