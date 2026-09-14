import { CORPUS } from "./cases";
import { validateRouteOutput } from "./validate";
import { JsAutorouter } from "../src/js-autorouter";

const id = process.argv[2];
const testCase = CORPUS.find((candidate) => candidate.id === id);
if (!testCase) throw new Error(`unknown corpus case ${id ?? ""}`);
const result = await new JsAutorouter().route(testCase.input, { maxTimeMs: testCase.maxTimeMs });
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
