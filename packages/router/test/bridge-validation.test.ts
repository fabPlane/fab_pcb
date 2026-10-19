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
      cleanupFirst ? ["save", "apply", "drc", "undo", "apply", "drc", "undo"] : ["save", "apply", "drc", "undo"],
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
    expect(fixture.calls).toEqual(["save", "apply", "drc", "undo"]);
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
