import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { installDir, pickAsset, platformName, type Manifest } from "./fetch";

const asset = (platform: string, entrypoint: string) => ({
  file: `kicad-cli-${platform}.tar.gz`,
  url: `https://github.com/TensorFleet/kicad/releases/download/nightly/kicad-cli-${platform}.tar.gz`,
  sha256: "0".repeat(64),
  size: 1,
  entrypoint,
  commit: "0c45443da6168edfba53f51a1195b54d7b708b45",
  version: "10.99.0-3760-g0c45443da6",
  tag: "nightly-20260910-0c45443da6",
  date: "20260910",
});

const manifest: Manifest = {
  schema: 1,
  repo: "TensorFleet/kicad",
  release: "nightly",
  tag: "nightly-20260910-0c45443da6",
  commit: "0c45443da6168edfba53f51a1195b54d7b708b45",
  version: "10.99.0-3760-g0c45443da6",
  date: "20260910",
  assets: {
    "linux-x86_64": asset("linux-x86_64", "kicad-cli/kicad-cli"),
    "windows-x86_64": asset("windows-x86_64", "kicad-cli/bin/kicad-cli.exe"),
  },
};

describe("platformName", () => {
  test("maps the runtimes the nightly builds for", () => {
    expect(platformName("linux", "x64")).toBe("linux-x86_64");
    expect(platformName("darwin", "arm64")).toBe("macos-arm64");
    expect(platformName("darwin", "x64")).toBe("macos-x86_64");
    expect(platformName("win32", "x64")).toBe("windows-x86_64");
  });

  test("rejects what is not built", () => {
    expect(() => platformName("linux", "arm64")).toThrow(/no nightly kicad-cli build for linux\/arm64/);
    expect(() => platformName("freebsd", "x64")).toThrow();
  });
});

describe("pickAsset", () => {
  test("returns the platform's entry", () => {
    expect(pickAsset(manifest, "windows-x86_64").entrypoint).toBe("kicad-cli/bin/kicad-cli.exe");
  });

  test("names the platforms the release does carry when one is missing", () => {
    expect(() => pickAsset(manifest, "macos-arm64")).toThrow(/no macos-arm64 build \(platforms: linux-x86_64, windows-x86_64\)/);
  });

  test("refuses a manifest schema it does not know", () => {
    expect(() => pickAsset({ ...manifest, schema: 2 }, "linux-x86_64")).toThrow(/schema 2/);
  });
});

describe("installDir", () => {
  test("is per build tag and platform so pins do not collide", () => {
    const a = pickAsset(manifest, "linux-x86_64");
    expect(installDir("/x", a, "linux-x86_64")).toBe(join("/x", "nightly-20260910-0c45443da6", "linux-x86_64"));
  });
});
