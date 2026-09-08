import { describe, expect, test } from "bun:test";
import { targetSpec } from "./bundle-lib";

describe("backend bundle targets", () => {
  test("uses IPC on Unix and KiCad WebSockets on Windows", () => {
    expect(targetSpec("linux-x64")).toMatchObject({ bunTarget: "bun-linux-x64", socketTransport: "ipc", kicadCliName: "kicad-cli" });
    expect(targetSpec("darwin-arm64")).toMatchObject({ bunTarget: "bun-darwin-arm64", socketTransport: "ipc" });
    expect(targetSpec("windows-x64")).toMatchObject({ bunTarget: "bun-windows-x64", socketTransport: "ws", kicadCliName: "kicad-cli.exe" });
    expect(() => targetSpec("plan9-x64")).toThrow(/unsupported bundle target/);
  });
});
