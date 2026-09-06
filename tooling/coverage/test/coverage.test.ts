import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyze, renderJson, renderMarkdown, scanHandlerSource, summarize, TOOL_DIR, REPO_DIR } from "../run.js";

describe("scanHandlerSource", () => {
  test("parses qualified names, digits, multi-line calls, GUI_ONLY and checkForHeadless", () => {
    const src = `
      registerHandler<commands::GetVersion, GetVersionResponse>( &API_HANDLER_COMMON::handleGetVersion );
      registerHandler<RunBoardJobExport3D, types::RunJobResponse>(
              &API_HANDLER_PCB::handleRunBoardJobExport3D );
      registerHandler<GetSelection, SelectionResponse>( &H::handleGetSelection, HANDLER_MODE::GUI_ONLY );
      registerHandler<SetTitleBlockInfo, google::protobuf::Empty>( &H::x );
      if( std::optional<ApiResponseStatus> headless = checkForHeadless( "RunAction" ) )
    `;
    const s = scanHandlerSource("x", src);
    expect(s.registrations).toEqual([
      { request: "commands::GetVersion", response: "GetVersionResponse", guiOnly: false },
      { request: "RunBoardJobExport3D", response: "types::RunJobResponse", guiOnly: false },
      { request: "GetSelection", response: "SelectionResponse", guiOnly: true },
      { request: "SetTitleBlockInfo", response: "google::protobuf::Empty", guiOnly: false },
    ]);
    expect([...s.gated]).toEqual(["RunAction"]);
  });
});

const kicad = process.env.KICAD_SRC ?? join(REPO_DIR, "..", "kicad");
const haveKicad = existsSync(join(kicad, "api", "proto", "common", "envelope.proto"));

/** HEAD of the KiCad checkout; the pinned bindings only know the commands of KICAD_COMMIT. */
function kicadHead(): string {
  const r = Bun.spawnSync(["git", "-C", kicad, "rev-parse", "HEAD"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}
async function pinnedCommit(): Promise<string> {
  return (await readFile(join(REPO_DIR, "packages", "proto", "KICAD_COMMIT"), "utf8")).trim();
}
async function drifted(): Promise<boolean> {
  const pinned = await pinnedCommit();
  const head = kicadHead();
  if (head !== pinned || process.env.KICAD_WORKTREE === "1") {
    console.warn(`KiCad checkout is at ${head.slice(0, 10)}, KICAD_COMMIT pins ${pinned.slice(0, 10)}; skipping (regenerate with bun run gen && bun run coverage)`);
    return true;
  }
  return false;
}

describe.skipIf(!haveKicad)("coverage against the pinned KiCad checkout (git HEAD)", () => {
  test("matches commands.json and docs/api-coverage.md on disk", async () => {
    if (await drifted()) return;
    const r = await analyze(kicad);
    expect(r.warnings).toEqual([]);
    expect(renderJson(r)).toBe(await readFile(join(TOOL_DIR, "commands.json"), "utf8"));
    expect(renderMarkdown(r)).toBe(await readFile(join(REPO_DIR, "docs", "api-coverage.md"), "utf8"));
    const s = summarize(r.commands);
    // The fork keeps adding commands; the invariants are: every command is either headless or
    // one of the 16 known GUI-only ones, nothing is partial or unregistered, and the totals agree
    // with the committed commands.json (checked byte-for-byte above).
    expect(s.total).toBeGreaterThanOrEqual(115);
    expect(s.ok + s["gui-only"]).toBe(s.total);
    expect(s["gui-only"]).toBe(16);
    expect(s.partial).toBe(0);
    expect(s.unregistered).toBe(0);
    expect(r.commands.find((c) => c.command === "GetSupportedCommands")).toMatchObject({
      group: "common/base",
      requestType: "kiapi.common.commands.GetSupportedCommands",
      responseType: "kiapi.common.commands.GetSupportedCommandsResponse",
      handlers: ["server"],
      headless: "ok",
    });
  });

  test("every registered command has a full response type and known handlers", async () => {
    if (await drifted()) return;
    const r = await analyze(kicad);
    for (const c of r.commands) {
      expect(c.requestType.startsWith("kiapi.")).toBe(true);
      if (c.headless === "unregistered") {
        expect(c.handlers).toEqual([]);
        expect(c.responseType).toBeNull();
      } else {
        expect(c.responseType).toMatch(/^(kiapi|google\.protobuf)\./);
        expect(c.handlers.length).toBeGreaterThan(0);
      }
    }
  });
});
