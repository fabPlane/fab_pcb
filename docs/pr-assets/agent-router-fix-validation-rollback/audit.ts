import { validationFixture } from "./test/bridge-validation-fixture";

const scenarios = [
  ["first-check-failure", {}],
  ["cleanup-retry-failure", { cleanupFirst: true }],
  ["undo-zero", { undo: "zero" }],
  ["undo-throws", { undo: "throws" }],
  ["valid-control", { valid: true }],
] as const;
const rows = [];
for (let repeat = 1; repeat <= 3; repeat++) {
  for (const [scenario, options] of scenarios) {
    const fixture = validationFixture(options);
    const info = await fixture.done;
    rows.push({
      scenario, repeat, state: info.state, error: info.error ?? null,
      copper: fixture.copper().map((item) => item.id),
      original: fixture.original.map((item) => item.id), calls: fixture.calls,
      addedCopper: fixture.copper().filter((item) => !fixture.original.includes(item)).length,
      missingOriginal: fixture.original.filter((item) => !fixture.copper().includes(item)).length,
    });
  }
}
console.log(JSON.stringify(rows, null, 2));
