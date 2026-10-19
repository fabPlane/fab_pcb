import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runOwnedCommand } from "../src/owned-command";

for (const code of [0, 3]) for (const pipes of ["inherit", "ignore"] as const) {
  test.skipIf(process.platform === "win32")(`exit ${code} preserves status and removes ${pipes} pipe descendants`, async () => {
    const dir = mkdtempSync("/tmp/owned-exit-");
    const marker = join(dir, "child");
    try {
      const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 800)`;
      const result = await runOwnedCommand([process.execPath, "--eval", `
        Bun.spawn([process.execPath, "--eval", ${JSON.stringify(child)}], {
          stdin: "ignore", stdout: ${JSON.stringify(pipes)}, stderr: ${JSON.stringify(pipes)},
        });
        console.log("parent done"); process.stderr.write("diagnostic\\n"); process.exit(${code});
      `], { timeoutMs: 400 });
      expect(result.code).toBe(code);
      expect(result.timedOut).toBe(false);
      expect(result.stdout.trim()).toBe("parent done");
      expect(result.stderr.trim()).toBe("diagnostic");
      expect(result.wallMs).toBeLessThan(350);
      await Bun.sleep(900);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("deadline kills a group even when both processes ignore termination", async () => {
  const result = await runOwnedCommand([process.execPath, "--eval", `
    process.on("SIGTERM", () => {});
    Bun.spawn([process.execPath, "--eval", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 2000)'], {stdout: "inherit", stderr: "inherit"});
    console.log("ready"); setTimeout(() => {}, 2000);
  `], { timeoutMs: 150 });
  expect(result.code).toBe(124);
  expect(result.timedOut).toBe(true);
  expect(result.stdout.trim()).toBe("ready");
  expect(result.wallMs).toBeLessThan(800);
});

test("callback failure rejects and stops the owned child", async () => {
  const dir = mkdtempSync("/tmp/owned-callback-");
  const marker = join(dir, "survived");
  try {
    await expect(runOwnedCommand([process.execPath, "--eval", `
      console.log("ready");
      setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 600);
    `], { onStdout: () => { throw new Error("consumer failed"); } })).rejects.toThrow("consumer failed");
    await Bun.sleep(700);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation kills the group and pre-cancelled commands never spawn", async () => {
  const controller = new AbortController();
  const pending = runOwnedCommand([process.execPath, "--eval", 'console.log("ready"); setTimeout(() => {}, 2000)'], {
    signal: controller.signal, onStdout: () => controller.abort(),
  });
  expect(await pending).toMatchObject({ cancelled: true, timedOut: false, code: 124 });
  expect(await runOwnedCommand(["/nonexistent"], { signal: controller.signal })).toMatchObject({ cancelled: true });
});

test("invalid deadlines reject before spawning", async () => {
  for (const timeoutMs of [-1, NaN, Infinity, 2147483648]) {
    await expect(runOwnedCommand(["/nonexistent"], { timeoutMs })).rejects.toThrow(RangeError);
  }
});

test("stdout drains completely and streaming chunks preserve UTF-8", async () => {
  let chunks = "";
  const result = await runOwnedCommand([process.execPath, "--eval", 'process.stdout.write("✓".repeat(100000))'], {
    timeoutMs: 2000, onStdout: chunk => { chunks += chunk; },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("✓".repeat(100000));
  expect(chunks).toBe(result.stdout);
});

test.skipIf(process.platform === "win32")("detached pipe holders cannot extend a completed parent's result", async () => {
  const dir = mkdtempSync("/tmp/owned-detached-");
  const pidFile = join(dir, "pid");
  let pid: number | undefined;
  try {
    const result = await runOwnedCommand([process.execPath, "--eval", `
      const child = Bun.spawn([process.execPath, "--eval", "setTimeout(() => {}, 1500)"], {
        detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      console.log("done"); process.exit(0);
    `], { timeoutMs: 500 });
    pid = Number(await Bun.file(pidFile).text());
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout.trim()).toBe("done");
    expect(result.wallMs).toBeLessThan(400);
  } finally {
    // This deliberately detached child belongs to this test, outside the
    // wrapper's POSIX group. The test must clean it up itself.
    if (pid) try { process.kill(pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
