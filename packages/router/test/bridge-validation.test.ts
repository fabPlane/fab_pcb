import { expect, test } from "bun:test";
import { RuleSeverity } from "@fp-pcb/proto";
import { validationFixture } from "./bridge-validation-fixture";

for (const cleanupFirst of [false, true]) {
  test(`failed native validation restores tentative copper${cleanupFirst ? " after a cleanup retry" : ""}`, async () => {
    const fixture = validationFixture({ cleanupFirst });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("native DRC transport unavailable");
    expect(info.summary).toBeUndefined();
    expect(fixture.copper()).toEqual(fixture.original);
    expect(fixture.calls).toEqual(
      cleanupFirst ? ["save", "drc", "apply", "drc", "undoStack", "undo", "apply", "drc", "undoStack", "undo"] : ["save", "drc", "apply", "drc", "undoStack", "undo"],
    );
  });
}

for (const undo of ["zero", "throws"] as const) {
  test(`failed validation reports an unsuccessful rollback (${undo}) without claiming restoration`, async () => {
    const fixture = validationFixture({ undo });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("native DRC transport unavailable");
    expect(info.error).toContain("rollback failed");
    expect(info.error).toContain("KiCad memory");
    expect(fixture.calls).toEqual(["save", "drc", "apply", "drc", "undoStack", "undo"]);
    expect(fixture.copper().some((item) => item.id === "new-route")).toBe(true);
  });
}

test("successful native validation keeps and saves the applied route without undo", async () => {
  const fixture = validationFixture({ valid: true });
  const info = await fixture.done;
  expect(info.state).toBe("done");
  expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route"]);
  expect(fixture.calls).toEqual(["save", "drc", "apply", "drc", "save", "ratsnest"]);
});

test("failed validation preserves an unrelated edit above the route commit", async () => {
  const fixture = validationFixture({ foreignEdit: true });
  const info = await fixture.done;
  expect(info.state).toBe("failed");
  expect(info.error).toContain("native DRC transport unavailable");
  expect(info.error).toContain("rollback failed");
  expect(info.error).toContain("not at the top of the undo stack");
  expect(fixture.calls).toEqual(["save", "drc", "apply", "drc", "undoStack"]);
  expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route", "unrelated-edit"]);
});

for (const undo of [undefined, "zero", "throws"] as const) {
  test(`failed tentative ratsnest validation rolls back or reports rollback failure (${undo ?? "owned"})`, async () => {
    const fixture = validationFixture({ ratsnestFailure: true, ...(undo ? { undo } : {}) });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("native ratsnest transport unavailable");
    expect(fixture.calls.filter((call) => call === "undo")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
    expect(info.summary).toBeUndefined();
    if (!undo) expect(fixture.copper()).toEqual(fixture.original);
    else expect(info.error).toContain("rollback failed");
  });
}

test("relabelled route is validated and restored before a failed job", async () => {
  const fixture = validationFixture({ relabel: true });
  const info = await fixture.done;
  expect(info.state).toBe("failed");
  expect(info.error).toContain("native DRC transport unavailable");
  expect(info.summary).toBeUndefined();
  expect(fixture.calls.filter((call) => call === "drc")).toHaveLength(3);
  expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
  expect(fixture.copper()).toEqual(fixture.original);
  expect(fixture.calls.filter((call) => call === "undo")).toHaveLength(2);
});

test("relabelled route with successful validation is saved", async () => {
  const fixture = validationFixture({ relabel: true, valid: true });
  const info = await fixture.done;
  expect(info.state).toBe("done");
  expect(fixture.calls.filter((call) => call === "drc")).toHaveLength(3);
  expect(fixture.calls.filter((call) => call === "apply")).toHaveLength(2);
  expect(fixture.calls.filter((call) => call === "save")).toHaveLength(2);
  expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route"]);
});

test("unstable native connection counts stop without saving a replacement", async () => {
  const fixture = validationFixture({ relabel: true, valid: true, oscillatingCount: true });
  const info = await fixture.done;
  expect(info.state).toBe("failed");
  expect(info.error).toContain("did not converge");
  expect(info.summary).toBeUndefined();
  expect(fixture.copper()).toEqual(fixture.original);
  expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
  expect(fixture.calls.filter((call) => call === "apply").length).toBeLessThanOrEqual(4);
});

for (const undo of [undefined, "zero", "throws"] as const) {
  test(`failed post-apply refill rejects without saving (${undo ?? "owned"})`, async () => {
    const fixture = validationFixture({ valid: true, refill: "throws", ...(undo ? { undo } : {}) });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("native refill unavailable");
    expect(info.summary).toBeUndefined();
    expect(info.zoneRefill).toEqual({ before: true, after: false, error: "native refill unavailable" });
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
    if (!undo) expect(fixture.copper()).toEqual(fixture.original);
    else {
      expect(info.error).toContain("rollback failed");
      expect(info.error).toContain("KiCad memory");
    }
  });
}

test("failed refill with its own newer commit refuses a one-entry route rollback", async () => {
  const fixture = validationFixture({ valid: true, refill: "commit-then-throws" });
  const info = await fixture.done;
  expect(info.state).toBe("failed");
  expect(info.error).toContain("native refill unavailable");
  expect(info.error).toContain("not at the top of the undo stack");
  expect(info.error).toContain("KiCad memory");
  expect(info.summary).toBeUndefined();
  expect(fixture.calls).not.toContain("undo");
  expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
  expect(fixture.copper().some((item) => item.id === "new-route")).toBe(true);
});

test("successful post-apply refill keeps the route and saves", async () => {
  const fixture = validationFixture({ valid: true, refill: "valid" });
  const info = await fixture.done;
  expect(info.state).toBe("done");
  expect(info.zoneRefill).toEqual({ before: true, after: true });
  expect(fixture.calls).toEqual(["refill", "save", "drc", "apply", "drc", "refill", "drc", "save", "ratsnest"]);
  expect(fixture.copper().some((item) => item.id === "new-route")).toBe(true);
});

for (const undo of [undefined, "zero", "throws"] as const) {
  test(`failed filled native DRC query rejects before saving (${undo ?? "owned"})`, async () => {
    const fixture = validationFixture({ valid: true, refill: "valid", finalDrcFailure: true, ...(undo ? { undo } : {}) });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("filled DRC unavailable");
    expect(info.summary).toBeUndefined();
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "drc")).toHaveLength(3);
    if (!undo) expect(fixture.copper()).toEqual(fixture.original);
    else expect(info.error).toContain("rollback failed");
  });
}

test("failed filled DRC query preserves a newer unrelated edit", async () => {
  const fixture = validationFixture({ valid: true, refill: "valid", finalDrcFailure: true, finalForeignEdit: true });
  const info = await fixture.done;
  expect(info.state).toBe("failed");
  expect(info.error).toContain("filled DRC unavailable");
  expect(info.error).toContain("not at the top of the undo stack");
  expect(info.summary).toBeUndefined();
  expect(fixture.calls).not.toContain("undo");
  expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
  expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route", "unrelated-edit"]);
});

for (const filledMarkers of ["new", "duplicate", "replacement"] as const) {
  test(`rejects newly introduced filled native errors (${filledMarkers})`, async () => {
    const fixture = validationFixture({ valid: true, refill: "valid", filledMarkers });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("new filled native DRC");
    expect(info.summary).toBeUndefined();
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
    expect(fixture.copper()).toEqual(fixture.original);
  });
}
for (const filledMarkers of ["existing", "excluded"] as const) {
  test(`allows unchanged or excluded filled markers (${filledMarkers})`, async () => {
    const fixture = validationFixture({ valid: true, refill: "valid", filledMarkers });
    const info = await fixture.done;
    expect(info.state).toBe("done");
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(2);
    expect(fixture.calls).not.toContain("undo");
  });
}

for (const filledMarkers of ["new", "duplicate", "replacement"] as const) {
  test(`rejects new native errors with zone refill disabled (${filledMarkers})`, async () => {
    const fixture = validationFixture({ valid: true, unfilledErrors: true, filledMarkers });
    const info = await fixture.done;
    expect(info.state).toBe("failed");
    expect(info.error).toContain("new native DRC error(s)");
    expect(info.summary).toBeUndefined();
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
    expect(fixture.copper()).toEqual(fixture.original);
  });
}
for (const filledMarkers of ["existing", "excluded"] as const) {
  test(`allows existing or excluded errors with zone refill disabled (${filledMarkers})`, async () => {
    const fixture = validationFixture({ valid: true, unfilledErrors: true, filledMarkers });
    const info = await fixture.done;
    expect(info.state).toBe("done");
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(2);
    expect(fixture.calls).not.toContain("undo");
  });
}

for (const excludedDangling of ["existing", "generated"] as const) {
  test(`excluded dangling finding preserves ${excludedDangling} copper`, async () => {
    const fixture = validationFixture({ valid: true, excludedDangling });
    const info = await fixture.done;
    expect(info.state).toBe("done");
    expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route"]);
    expect(fixture.calls.filter((call) => call === "apply")).toHaveLength(1);
    expect(fixture.calls).not.toContain("undo");
    expect(fixture.calls.filter((call) => call === "save")).toHaveLength(2);
    expect(info.summary?.removedExistingCopper ?? []).toEqual([]);
  });
}

for (const danglingSeverity of [RuleSeverity.RS_IGNORE, RuleSeverity.RS_EXCLUSION, RuleSeverity.RS_INFO]) {
  test(`inactive dangling severity preserves existing copper (${danglingSeverity})`, async () => {
    const fixture = validationFixture({ valid: true, danglingSeverity });
    const info = await fixture.done;
    expect(info.state).toBe("done");
    expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route"]);
    expect(fixture.calls.filter((call) => call === "apply")).toHaveLength(1);
    expect(fixture.calls).not.toContain("undo");
    expect(info.summary?.removedExistingCopper ?? []).toEqual([]);
  });
}
for (const danglingSeverity of [RuleSeverity.RS_WARNING, RuleSeverity.RS_ERROR]) {
  test(`active dangling severity still cleans scoped existing copper (${danglingSeverity})`, async () => {
    const fixture = validationFixture({ valid: true, danglingSeverity });
    const info = await fixture.done;
    expect(info.state).toBe("done");
    expect(fixture.copper().map((item) => item.id)).toEqual(["protected", "other-net", "new-route"]);
    expect(fixture.calls.filter((call) => call === "apply")).toHaveLength(2);
    expect(fixture.calls.filter((call) => call === "undo")).toHaveLength(1);
  });
}
