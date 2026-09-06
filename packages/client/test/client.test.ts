import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  ApiRequestSchema,
  ApiStatusCode,
  GetSupportedCommandsResponseSchema,
  GetSupportedCommandsSchema,
  GetVersionResponseSchema,
  GetVersionSchema,
  PingSchema,
  packAny,
  unpackAnyAs,
} from "@kicad-web/proto";
import { KiCadClient } from "../src/client";
import { COMMANDS, KICAD_COMMIT } from "../src/commands-data";
import * as commands from "../src/commands";
import { KiCadApiError } from "../src/errors";
import { FakeTransport, fail, reply } from "./fake-transport";

function versionTransport(): FakeTransport {
  return new FakeTransport().on(GetVersionSchema, () => reply(GetVersionResponseSchema, { version: { major: 10, minor: 99, patch: 0, fullVersion: "10.99.0-test" } }));
}

describe("KiCadClient envelope", () => {
  test("encodeRequest packs header + Any with the kiapi type URL", () => {
    const c = new KiCadClient(new FakeTransport(), { clientName: "kicad-web/test", kicadToken: "tok" });
    const bytes = c.encodeRequest(PingSchema, {});
    const env = fromBinary(ApiRequestSchema, bytes);
    expect(env.header?.clientName).toBe("kicad-web/test");
    expect(env.header?.kicadToken).toBe("tok");
    expect(env.message?.typeUrl).toBe("type.googleapis.com/kiapi.common.commands.Ping");
    expect(unpackAnyAs(env.message!, PingSchema)).toBeDefined();
  });

  test("connect() pings, learns the token, call() unpacks the typed response", async () => {
    const t = versionTransport();
    const c = await KiCadClient.connect(t, { clientName: "kicad-web/test" });
    expect(c.kicadToken).toBe(t.token);
    const v = await commands.getVersion(c);
    expect(v.version?.fullVersion).toBe("10.99.0-test");
    expect(t.calls.map((x) => x.typeName)).toEqual(["kiapi.common.commands.Ping", "kiapi.common.commands.GetVersion"]);
    expect(t.calls[1]!.token).toBe(t.token);
  });

  test("Empty-returning commands resolve to an empty message even when the Any is missing", async () => {
    const t = new FakeTransport().on(PingSchema, () => ({ status: ApiStatusCode.AS_OK }));
    const c = await KiCadClient.connect(t, { clientName: "x" });
    await expect(c.ping()).resolves.toBeUndefined();
  });

  test("non-OK statuses become KiCadApiError with code, command and server message", async () => {
    const t = new FakeTransport().on(GetVersionSchema, () => fail(ApiStatusCode.AS_BAD_REQUEST, "nope"));
    const c = await KiCadClient.connect(t, { clientName: "x" });
    const err = await commands.getVersion(c).catch((e: unknown) => e);
    expect(KiCadApiError.is(err, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    const e = err as KiCadApiError;
    expect(e.command).toBe("GetVersion");
    expect(e.serverMessage).toBe("nope");
    expect(e.message).toContain("AS_BAD_REQUEST");
  });

  test("mismatched response type is an error, not a silent empty message", async () => {
    const t = new FakeTransport().on(GetVersionSchema, () => ({ status: ApiStatusCode.AS_OK, message: packAny(PingSchema, create(PingSchema)) }));
    const c = await KiCadClient.connect(t, { clientName: "x" });
    await expect(commands.getVersion(c)).rejects.toThrow(/expected response type/);
  });
});

describe("KiCadClient retry and restart handling", () => {
  test("AS_BUSY and AS_NOT_READY are retried with backoff until success", async () => {
    const t = versionTransport().failNext(GetVersionSchema, 3, ApiStatusCode.AS_BUSY, "busy");
    const c = await KiCadClient.connect(t, { clientName: "x", retry: { baseDelayMs: 1, maxDelayMs: 2 } });
    const traces: number[] = [];
    c.onCall((tr) => traces.push(tr.attempts));
    const v = await commands.getVersion(c);
    expect(v.version?.major).toBe(10);
    expect(t.countOf(GetVersionSchema)).toBe(4);
    expect(traces).toEqual([4]);
  });

  test("retry gives up at the deadline and throws the last status", async () => {
    const t = versionTransport().failNext(GetVersionSchema, 1000, ApiStatusCode.AS_NOT_READY);
    const c = await KiCadClient.connect(t, { clientName: "x" });
    const err = await commands.getVersion(c, {}, { retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 15 } }).catch((e: unknown) => e);
    expect(KiCadApiError.is(err, ApiStatusCode.AS_NOT_READY)).toBe(true);
  });

  test("retry: false disables it", async () => {
    const t = versionTransport().failNext(GetVersionSchema, 1, ApiStatusCode.AS_BUSY);
    const c = await KiCadClient.connect(t, { clientName: "x" });
    await expect(commands.getVersion(c, {}, { retry: false })).rejects.toMatchObject({ code: ApiStatusCode.AS_BUSY });
    expect(t.countOf(GetVersionSchema)).toBe(1);
  });

  test("AS_TOKEN_MISMATCH fires onServerRestarted, adopts the new token, and throws once", async () => {
    const t = versionTransport();
    const c = await KiCadClient.connect(t, { clientName: "x" });
    const events: string[] = [];
    c.onServerRestarted((i) => events.push(`${i.previousToken}->${i.newToken}`));
    const old = t.token;
    t.token = "new-token";
    await expect(commands.getVersion(c)).rejects.toMatchObject({ code: ApiStatusCode.AS_TOKEN_MISMATCH });
    expect(events).toEqual([`${old}->new-token`]);
    expect(c.kicadToken).toBe("new-token");
    await expect(commands.getVersion(c)).resolves.toBeDefined();
  });
});

describe("capabilities", () => {
  test("uses GetSupportedCommands when the server has it", async () => {
    const t = versionTransport().on(GetSupportedCommandsSchema, () =>
      reply(GetSupportedCommandsResponseSchema, {
        commands: [
          { typeUrl: "type.googleapis.com/kiapi.common.commands.GetVersion", responseTypeUrl: "type.googleapis.com/kiapi.common.commands.GetVersionResponse", headless: true },
          { typeUrl: "type.googleapis.com/kiapi.common.commands.GetSelection", responseTypeUrl: "type.googleapis.com/kiapi.common.commands.SelectionResponse", headless: false },
        ],
      }),
    );
    const c = await KiCadClient.connect(t, { clientName: "x" });
    const caps = await c.capabilities();
    expect(caps.source).toBe("server");
    expect(caps.has("GetVersion")).toBe(true);
    expect(caps.has(GetVersionSchema)).toBe(true);
    expect(caps.isHeadless("GetSelection")).toBe(false);
    expect(caps.get("GetVersion")?.info?.group).toBe("common/base");
    expect(await c.supports("GetSelection")).toBe(false);
    expect(await c.supports("GetVersion")).toBe(true);
    expect(await c.supports("Ping")).toBe(false);
  });

  test("falls back to the bundled coverage table when GetSupportedCommands is unhandled", async () => {
    const t = versionTransport(); // no GetSupportedCommands handler -> AS_UNHANDLED
    const c = await KiCadClient.connect(t, { clientName: "x" });
    const caps = await c.capabilities();
    expect(caps.source).toBe("bundled");
    expect(caps.size).toBe(COMMANDS.length);
    expect(caps.bundledCommit).toBe(KICAD_COMMIT);
    expect(caps.isHeadless("GetVersion")).toBe(true);
    expect(caps.isHeadless("GetSelection")).toBe(false);
  });

  test("checkCapabilities short-circuits GUI-only commands without a round trip", async () => {
    const t = versionTransport().on(GetSupportedCommandsSchema, () =>
      reply(GetSupportedCommandsResponseSchema, {
        commands: [{ typeUrl: "type.googleapis.com/kiapi.common.commands.GetSelection", responseTypeUrl: "", headless: false }],
      }),
    );
    const c = await KiCadClient.connect(t, { clientName: "x", checkCapabilities: true });
    await expect(commands.getSelection(c, {})).rejects.toMatchObject({ code: ApiStatusCode.AS_UNIMPLEMENTED });
    await expect(commands.getVersion(c)).rejects.toMatchObject({ code: ApiStatusCode.AS_UNHANDLED });
    expect(t.countOf(GetVersionSchema)).toBe(0);
    await expect(commands.getVersion(c, {}, { force: true })).resolves.toBeDefined();
  });
});

describe("generated commands table", () => {
  test("every command has a wrapper and matching schemas", () => {
    for (const info of COMMANDS) {
      const fn = (commands as unknown as Record<string, unknown>)[info.command.charAt(0).toLowerCase() + info.command.slice(1)];
      expect(typeof fn).toBe("function");
      const s = commands.commandSchemas(info.command)!;
      expect(s.request.typeName).toBe(info.requestType);
      expect(s.response.typeName).toBe(info.responseType ?? "google.protobuf.Empty");
      expect(commands.commandSchemas(info.requestType)).toBe(s);
    }
  });
});
