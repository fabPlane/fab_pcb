import { describe, expect, test } from "bun:test";
import { persistAppliedRoute } from "../src/bridge-job";

describe("persistAppliedRoute", () => {
  test("saves a route after it has been applied", async () => {
    let saves = 0;
    await persistAppliedRoute({
      async save() {
        saves++;
      },
    });
    expect(saves).toBe(1);
  });

  test("explains that an applied route remains only in memory when saving fails", async () => {
    const failure = new Error("disk full");
    const saving = persistAppliedRoute({
      async save() {
        throw failure;
      },
    });
    await expect(saving).rejects.toThrow(
      "route was applied in KiCad memory but SaveDocument failed; retry saving before closing the session: disk full",
    );
    await expect(saving).rejects.toMatchObject({ cause: failure });
  });
});
