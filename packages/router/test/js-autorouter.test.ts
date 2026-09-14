import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { JsAutorouter, type JsAutorouterRouteOptions } from "../src/js-autorouter";
import { mm } from "@fp-pcb/client";
import { twoNetBoard, F, B } from "./fixtures";

const SES = `(session "board.ses"
  (base_design "board.dsn")
  (placement (resolution um 10))
  (was_is)
  (routes
    (resolution um 10)
    (parser (host_cad "js_autorouter") (host_version "0.0.0"))
    (library_out)
    (network_out
      (net A (wire (path F.Cu 2500 50000 -50000 250000 -250000)))
      (net B (wire (path B.Cu 2500 250000 -50000 50000 -250000)))
    )
  )
)`;

describe("JsAutorouter", () => {
  test("routes DSN through the injected private solver and converts its SES", async () => {
    let received: JsAutorouterRouteOptions | undefined;
    const phases: string[] = [];
    const router = new JsAutorouter({
      routeDsn: async (_input, workDir, options) => {
        received = options;
        const output = join(workDir, "result.ses");
        await Bun.write(output, SES);
        return output;
      },
    });
    expect(await router.available()).toEqual({ ok: true });

    const result = await router.route(twoNetBoard(), { effort: 3, maxTimeMs: 12_345 }, (progress) => phases.push(progress.phase));

    expect(received).toEqual({ maxPasses: 3, maxTotalMs: 12_345 });
    expect(phases).toEqual(["export", "js-autorouter", "import", "done"]);
    expect(result.router).toBe("js-autorouter");
    expect(result.unrouted).toEqual([]);
    expect(result.tracks).toHaveLength(2);
    expect(result.vias).toEqual([]);
    expect(result.tracks[0]).toMatchObject({ net: "A", netCode: 1, width: mm(0.25), layer: F });
    expect(result.tracks[1]).toMatchObject({ net: "B", netCode: 2, width: mm(0.25), layer: B });
  });

  test("reports a missing runtime module instead of claiming the router is ready", async () => {
    const router = new JsAutorouter({ moduleSpecifier: "/definitely/missing/js_autorouter.ts" });
    const available = await router.available();
    expect(available.ok).toBe(false);
    expect(available.reason).toContain("js_autorouter unavailable");
  });

  test("fails closed for prefab-via routing until js_autorouter can claim fixed vias", async () => {
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
    const router = new JsAutorouter({
      routeDsn: async () => {
        throw new Error("must not run");
      },
    });
    await expect(router.route(input)).rejects.toThrow("assignable prefab via");
    await expect(router.route(input, { preset: "default" })).rejects.toThrow("assignable prefab via");
  });

  test("honours cancellation before invoking the synchronous solver boundary", async () => {
    const abort = new AbortController();
    abort.abort();
    let called = false;
    const router = new JsAutorouter({
      routeDsn: async () => {
        called = true;
        throw new Error("must not run");
      },
    });
    await expect(router.route(twoNetBoard(), { signal: abort.signal })).rejects.toMatchObject({
      name: "RouteCancelled",
    });
    expect(called).toBe(false);
  });
});
