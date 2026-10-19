import { expect, test } from "bun:test";
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
      cleanupFirst ? ["save", "apply", "drc", "undoStack", "undo", "apply", "drc", "undoStack", "undo"] : ["save", "apply", "drc", "undoStack", "undo"],
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
    expect(fixture.calls).toEqual(["save", "apply", "drc", "undoStack", "undo"]);
    expect(fixture.copper().some((item) => item.id === "new-route")).toBe(true);
  });
}

test("successful native validation keeps and saves the applied route without undo", async () => {
  const fixture = validationFixture({ valid: true });
  const info = await fixture.done;
  expect(info.state).toBe("done");
  expect(fixture.copper().map((item) => item.id)).toEqual(["stub", "protected", "other-net", "new-route"]);
  expect(fixture.calls).toEqual(["save", "apply", "drc", "save", "ratsnest"]);
});

test("failed validation preserves an unrelated edit above the route commit", async () => {
  const fixture = validationFixture({ foreignEdit: true });
  const info = await fixture.done;
  expect(info.state).toBe("failed");
  expect(info.error).toContain("native DRC transport unavailable");
  expect(info.error).toContain("rollback failed");
  expect(info.error).toContain("not at the top of the undo stack");
  expect(fixture.calls).toEqual(["save", "apply", "drc", "undoStack"]);
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
  expect(fixture.calls.filter((call) => call === "drc")).toHaveLength(2);
  expect(fixture.calls.filter((call) => call === "save")).toHaveLength(1);
  expect(fixture.copper()).toEqual(fixture.original);
  expect(fixture.calls.filter((call) => call === "undo")).toHaveLength(2);
});

test("relabelled route with successful validation is saved", async () => {
  const fixture = validationFixture({ relabel: true, valid: true });
  const info = await fixture.done;
  expect(info.state).toBe("done");
  expect(fixture.calls.filter((call) => call === "drc")).toHaveLength(2);
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
