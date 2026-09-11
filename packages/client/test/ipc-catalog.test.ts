import { describe, expect, test } from "bun:test";
import { fromJson } from "@bufbuild/protobuf";
import { ApiStatusCode, GetVersionResponseSchema, GetVersionSchema, kiapiRegistry } from "@fp-pcb/proto";
import { KiCadClient } from "../src/client";
import { commandSchemas } from "../src/commands";
import {
  IPC_CATALOG,
  IPC_CATALOG_SHA256,
  IPC_CATALOG_VERSION,
  IPC_SCHEMA_SHA256,
  callIpcOperation,
  describeIpcOperation,
  searchIpcCatalog,
} from "../src/ipc-catalog";
import { FakeTransport, fail, reply } from "./fake-transport";

describe("versioned searchable IPC catalog", () => {
  test("covers every supported command and searches independent facets", () => {
    expect(IPC_CATALOG).toHaveLength(168);
    expect(IPC_CATALOG.filter((entry) => entry.headless === "ok")).toHaveLength(153);
    expect(IPC_CATALOG_VERSION).toBe("direct-kicad-ipc/1.0.0");
    expect(IPC_CATALOG_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(IPC_SCHEMA_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(searchIpcCatalog({ operation: "ratsnest" }).map((entry) => entry.operation)).toContain("GetRatsnest");
    expect(searchIpcCatalog({ documentType: "schematic", capability: "export", headless: "ok", limit: 100 }).length).toBeGreaterThan(0);
    expect(searchIpcCatalog({ objectType: "footprint", headless: "ok", limit: 100 }).length).toBeGreaterThan(0);
    expect(searchIpcCatalog({ headless: "gui-only", limit: 100 })).toHaveLength(15);
  });

  test("describes schemas, constraints, units, enum values and a compact example", () => {
    const getItems = describeIpcOperation("GetItems", 2)!;
    expect(getItems.requestSchema.type).toBe("kiapi.common.commands.GetItems");
    expect(getItems.responseSchema.type).toBe("kiapi.common.commands.GetItemsResponse");
    expect(getItems.referencedSchemas.some((schema) => schema.type === "kiapi.common.types.DocumentSpecifier")).toBe(true);
    const document = getItems.referencedSchemas.find((schema) => schema.type === "kiapi.common.types.DocumentSpecifier")!;
    expect(document.oneofs[0]?.constraint).toContain("at most one");
    expect(document.fields.find((field) => field.name === "type")?.enumValues?.some((value) => value.name === "DOCTYPE_PCB")).toBe(true);
    const vector = describeIpcOperation("GetBoardOrigin", 3)!.responseSchema;
    expect(vector.fields.find((field) => field.name === "xNm")?.units).toBe("nanometres");
    expect(getItems.requestExample).toBeDefined();
    expect(getItems.catalog.sha256).toBe(IPC_CATALOG_SHA256);
  });

  test("publishes a protobuf-JSON-valid request example for every operation", () => {
    for (const entry of IPC_CATALOG) {
      const description = describeIpcOperation(entry.operation)!;
      const schemas = commandSchemas(entry.operation)!;
      expect(() =>
        fromJson(schemas.request, description.requestExample, {
          registry: kiapiRegistry,
          ignoreUnknownFields: false,
        }),
      ).not.toThrow();
    }
  });
});

describe("generic typed IPC caller", () => {
  test("validates protobuf JSON and returns typed JSON with hashes", async () => {
    const transport = new FakeTransport().on(GetVersionSchema, () =>
      reply(GetVersionResponseSchema, { version: { major: 10, minor: 99, patch: 0, fullVersion: "10.99-test" } }),
    );
    const client = new KiCadClient(transport, { clientName: "ipc-catalog-test" });
    const result = await callIpcOperation(client, "GetVersion", {});
    expect(result.response).toMatchObject({ version: { major: 10, minor: 99, fullVersion: "10.99-test" } });
    expect(result.catalog.sha256).toBe(IPC_CATALOG_SHA256);
    expect(result.catalog.schemaSha256).toBe(IPC_SCHEMA_SHA256);
    expect(transport.countOf(GetVersionSchema)).toBe(1);
  });

  test("distinguishes invalid schemas, GUI-only calls and KiCad statuses", async () => {
    const transport = new FakeTransport().on(GetVersionSchema, () => fail(ApiStatusCode.AS_BAD_REQUEST, "bad version request"));
    const client = new KiCadClient(transport, { clientName: "ipc-catalog-test" });
    await expect(callIpcOperation(client, "GetVersion", { unknown: true })).rejects.toMatchObject({ code: "invalid_schema" });
    await expect(callIpcOperation(client, "GetSelection", {})).rejects.toMatchObject({ code: "non_headless" });
    await expect(callIpcOperation(client, "GetVersion", {})).rejects.toMatchObject({ code: "kicad_status", detail: { status: "AS_BAD_REQUEST" } });
    expect(transport.countOf(GetVersionSchema)).toBe(1);
  });
});
