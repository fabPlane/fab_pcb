/** Bridge checks that need no KiCad binary: config, path confinement, static hosting, control errors. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesError, configFromEnv, resolveInRoot, startBridge, type BridgeServer } from "../src/index";
import { decodeApiResponse, encodeApiRequest, encodePing } from "../src/kicad-ping";

describe("configFromEnv", () => {
  test("defaults and env overrides", () => {
    const c = configFromEnv({});
    expect(c.port).toBe(4020);
    expect(c.hostname).toBe("127.0.0.1");
    expect(c.socketDir).toBe("/tmp/kicad");
    expect(c.staticDir).toBeNull();
    const d = configFromEnv({ PORT: "0", HOST: "0.0.0.0", KICAD_CLI: "/x/kicad-cli", STATIC_DIR: "/srv", WS_MAX_PAYLOAD_BYTES: "1024" });
    expect(d.port).toBe(0);
    expect(d.hostname).toBe("0.0.0.0");
    expect(d.kicadCli).toBe("/x/kicad-cli");
    expect(d.staticDir).toBe("/srv");
    expect(d.maxPayloadBytes).toBe(1024);
    expect(() => configFromEnv({ PORT: "abc" })).toThrow();
  });
});

describe("kicad-ping envelope", () => {
  test("encodes the same bytes as the M0 script", () => {
    const hex = Array.from(encodePing("kicad-web/m0-ping") /* the M0 capture predates the rename */, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(
      "0a1312116b696361642d7765622f6d302d70696e6712320a2e747970652e676f6f676c65617069732e636f6d2f6b696170692e636f6d6d6f6e2e636f6d6d616e64732e50696e671200",
    );
    expect(encodeApiRequest("c", "kiapi.common.commands.GetVersion").length).toBeGreaterThan(40);
  });
  test("decodes a recorded AS_OK reply", () => {
    // ApiResponse{ header{kicad_token:"11dae6b5-e189-4952-bd1c-c2c9d0861463"}, status{status:AS_OK} }
    const token = "11dae6b5-e189-4952-bd1c-c2c9d0861463";
    const bytes = Uint8Array.from([0x0a, 0x26, 0x0a, 0x24, ...new TextEncoder().encode(token), 0x12, 0x02, 0x08, 0x01]);
    expect(decodeApiResponse(bytes)).toEqual({ token, status: 1, statusName: "AS_OK", error: "" });
    const notReady = Uint8Array.from([0x12, 0x06, 0x08, 0x04, 0x12, 0x02, 0x6e, 0x6f]);
    expect(decodeApiResponse(notReady)).toMatchObject({ status: 4, statusName: "AS_NOT_READY", error: "no" });
  });
});

describe("resolveInRoot", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fp-pcb-files-"));
    await mkdir(join(root, "inside"));
    await writeFile(join(root, "inside", "f.txt"), "x");
    await symlink("/etc", join(root, "escape"));
    await symlink(join(root, "inside"), join(root, "alias"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("accepts paths inside, rejects escapes", async () => {
    expect(await resolveInRoot(root, null)).toBe(await realRoot());
    expect(await resolveInRoot(root, "inside/f.txt")).toBe(join(await realRoot(), "inside/f.txt"));
    expect(await resolveInRoot(root, "inside/new/file.txt")).toBe(join(await realRoot(), "inside/new/file.txt"));
    expect(await resolveInRoot(root, "alias/f.txt")).toBe(join(await realRoot(), "inside/f.txt"));
    expect(await resolveInRoot(root, join(root, "inside"))).toBe(join(await realRoot(), "inside"));
    await expect(resolveInRoot(root, "../x")).rejects.toBeInstanceOf(FilesError);
    await expect(resolveInRoot(root, "/etc/passwd")).rejects.toMatchObject({ status: 403 });
    await expect(resolveInRoot(root, "escape/passwd")).rejects.toMatchObject({ status: 403 });
    await expect(resolveInRoot(root, "inside/../../y")).rejects.toMatchObject({ status: 403 });
  });
  async function realRoot() {
    const { realpath } = await import("node:fs/promises");
    return realpath(root);
  }
});

describe("bridge HTTP without KiCad", () => {
  let bridge: BridgeServer;
  let staticDir: string;
  beforeAll(async () => {
    staticDir = await mkdtemp(join(tmpdir(), "fp-pcb-static-"));
    await writeFile(join(staticDir, "index.html"), "<h1>app</h1>");
    await mkdir(join(staticDir, "assets"));
    await writeFile(join(staticDir, "assets", "a.js"), "console.log(1)");
    bridge = await startBridge(configFromEnv({}, { port: 0, kicadCli: "/nonexistent/kicad-cli", staticDir, workspaceRoot: staticDir, log: () => {} }));
  });
  afterAll(async () => {
    await bridge.stop();
    await rm(staticDir, { recursive: true, force: true });
  });

  test("health reports the missing binary", async () => {
    const h = (await (await fetch(`${bridge.url}/health`)).json()) as { ok: boolean; kicadCliExists: boolean };
    expect(h.ok).toBe(true);
    expect(h.kicadCliExists).toBe(false);
  });
  test("POST /sessions fails with 502 when kicad-cli cannot be spawned", async () => {
    const res = await fetch(`${bridge.url}/sessions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("spawn");
    expect(bridge.sessions.size).toBe(0);
  });
  test("static hosting with SPA fallback", async () => {
    expect(await (await fetch(`${bridge.url}/`)).text()).toBe("<h1>app</h1>");
    expect(await (await fetch(`${bridge.url}/assets/a.js`)).text()).toBe("console.log(1)");
    expect(await (await fetch(`${bridge.url}/some/route`)).text()).toBe("<h1>app</h1>");
    expect((await fetch(`${bridge.url}/missing.png`)).status).toBe(404);
  });
  test("CORS preflight and unknown session on /ws", async () => {
    const pre = await fetch(`${bridge.url}/sessions`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${bridge.url}/ws?session=zzz`)).status).toBe(404);
    expect((await fetch(`${bridge.url}/sessions/zzz`)).status).toBe(404);
  });
});
