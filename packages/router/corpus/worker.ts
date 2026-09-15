import { CORPUS } from "./cases";
import { validateRouteOutput } from "./validate";
import { FabRouter } from "../src/fab-router";
import { JsAutorouter } from "../src/js-autorouter";

const id = process.argv[2];
const testCase = CORPUS.find((candidate) => candidate.id === id);
if (!testCase) throw new Error(`unknown corpus case ${id ?? ""}`);
const configuredRouter = process.env["FP_PCB_CAPACITY_ROUTER"]?.trim();
if (configuredRouter && configuredRouter !== "fab-router" && configuredRouter !== "js-autorouter") {
  throw new Error(`FP_PCB_CAPACITY_ROUTER must be "fab-router" or "js-autorouter", got ${JSON.stringify(configuredRouter)}`);
}
const router = configuredRouter === "js-autorouter" ? new JsAutorouter() : new FabRouter();
const result = await router.route(testCase.input, { maxTimeMs: testCase.maxTimeMs });
const violations = validateRouteOutput(testCase.input, result);
console.log(
  JSON.stringify({
    id: testCase.id,
    quality: testCase.quality,
    result: {
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut,
      totalConnections: result.totalConnections,
      unrouted: result.unrouted.length,
      tracks: result.tracks.length,
      vias: result.vias.length,
    },
    violations,
  }),
);
