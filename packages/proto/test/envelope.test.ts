import { describe, expect, test } from "bun:test";
import { create, equals, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  ApiRequestSchema,
  ApiResponseSchema,
  ApiStatusCode,
  GetVersionSchema,
  GetVersionResponseSchema,
  PingSchema,
  KiCadVersionSchema,
  anyHolds,
  kiapiRegistry,
  packAny,
  typeUrlOf,
  unpackAny,
  unpackAnyAs,
} from "../src/index.js";

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Captured from a working client talking to `kicad-cli api-server` (KiCad 10.99).
const PING_REQUEST = hex(
  "0a1312116b696361642d7765622f6d302d70696e6712320a2e747970652e676f6f676c65617069732e636f6d2f6b696170692e636f6d6d6f6e2e636f6d6d616e64732e50696e671200",
);
const PING_RESPONSE = hex(
  "0a260a2431316461653662352d653138392d343935322d626431632d63326339643038363134363312020801" +
    "1a2b0a29747970652e676f6f676c65617069732e636f6d2f676f6f676c652e70726f746f6275662e456d707479",
);

describe("google.protobuf.Any helpers", () => {
  test("typeUrlOf uses the type.googleapis.com prefix KiCad expects", () => {
    expect(typeUrlOf(PingSchema)).toBe("type.googleapis.com/kiapi.common.commands.Ping");
    expect(typeUrlOf(GetVersionSchema)).toBe("type.googleapis.com/kiapi.common.commands.GetVersion");
  });

  test("registry resolves kiapi and well-known types", () => {
    expect(kiapiRegistry.getMessage("kiapi.common.ApiRequest")).toBeDefined();
    expect(kiapiRegistry.getMessage("kiapi.board.types.Footprint")).toBeDefined();
    expect(kiapiRegistry.getMessage("kiapi.schematic.types.Group")).toBeDefined();
    expect(kiapiRegistry.getMessage("google.protobuf.Empty")).toBeDefined();
    expect(kiapiRegistry.getMessage("google.protobuf.Any")).toBeDefined();
    expect(kiapiRegistry.getEnum("kiapi.common.ApiStatusCode")).toBeDefined();
  });
});

describe("ApiRequest round trip", () => {
  for (const schema of [PingSchema, GetVersionSchema]) {
    test(`wraps ${schema.typeName} in an Any and decodes it back`, () => {
      const req = create(ApiRequestSchema, {
        header: { clientName: "kicad-web/test" },
        message: packAny(schema, create(schema)),
      });
      const bytes = toBinary(ApiRequestSchema, req);
      const back = fromBinary(ApiRequestSchema, bytes);
      expect(back.header?.clientName).toBe("kicad-web/test");
      expect(back.message?.typeUrl).toBe(typeUrlOf(schema));
      expect(anyHolds(back.message!, schema)).toBe(true);
      const inner = unpackAny(back.message!);
      expect(inner?.$typeName).toBe(schema.typeName);
      expect(unpackAnyAs(back.message!, schema)).toBeDefined();
      expect(equals(ApiRequestSchema, req, back)).toBe(true);
    });
  }

  test("encodes what the M0 client sent for Ping (modulo the empty Any.value field)", () => {
    const req = create(ApiRequestSchema, {
      header: { clientName: "kicad-web/m0-ping" },
      message: packAny(PingSchema, create(PingSchema)),
    });
    const ours = toBinary(ApiRequestSchema, req);
    // The hand-rolled M0 client always wrote Any.value, even when empty (`12 00` at the end);
    // protobuf-es omits proto3 default values, so the Any submessage is two bytes shorter (0x30 vs 0x32).
    // Both decode to the same message and KiCad accepts either.
    const capturedWithoutEmptyValue = toHex(PING_REQUEST).replace(/1200$/, "").replace(/^(0a13.{38})1232/, "$11230");
    expect(toHex(ours)).toBe(capturedWithoutEmptyValue);
    expect(equals(ApiRequestSchema, req, fromBinary(ApiRequestSchema, PING_REQUEST))).toBe(true);
  });
});

describe("real byte captures", () => {
  test("decodes the captured Ping request", () => {
    const req = fromBinary(ApiRequestSchema, PING_REQUEST);
    expect(req.header?.clientName).toBe("kicad-web/m0-ping");
    expect(req.header?.kicadToken).toBe("");
    expect(req.message?.typeUrl).toBe("type.googleapis.com/kiapi.common.commands.Ping");
    expect(req.message?.value.length).toBe(0);
    expect(unpackAny(req.message!)?.$typeName).toBe("kiapi.common.commands.Ping");
  });

  test("decodes the captured Ping response", () => {
    const res = fromBinary(ApiResponseSchema, PING_RESPONSE);
    expect(res.header?.kicadToken).toBe("11dae6b5-e189-4952-bd1c-c2c9d0861463");
    expect(res.status?.status).toBe(ApiStatusCode.AS_OK);
    expect(res.status?.errorMessage).toBe("");
    expect(res.message?.typeUrl).toBe("type.googleapis.com/google.protobuf.Empty");
    const inner = unpackAny(res.message!);
    expect(inner?.$typeName).toBe("google.protobuf.Empty");
    expect(unpackAnyAs(res.message!, EmptySchema)).toBeDefined();
    // re-encoding reproduces the capture
    expect(toHex(toBinary(ApiResponseSchema, res))).toBe(toHex(PING_RESPONSE));
  });

  test("a GetVersionResponse packs and unpacks through the registry", () => {
    const version = create(KiCadVersionSchema, { major: 10, minor: 99, patch: 0, fullVersion: "10.99.0-test" });
    const res = create(ApiResponseSchema, {
      status: { status: ApiStatusCode.AS_OK },
      message: packAny(GetVersionResponseSchema, create(GetVersionResponseSchema, { version })),
    });
    const back = fromBinary(ApiResponseSchema, toBinary(ApiResponseSchema, res));
    const inner = unpackAnyAs(back.message!, GetVersionResponseSchema);
    expect(inner?.version?.major).toBe(10);
    expect(inner?.version?.minor).toBe(99);
    expect(inner?.version?.fullVersion).toBe("10.99.0-test");
    // JSON with json_types=true: Any is serialised with @type
    const json = toJson(ApiResponseSchema, back, { registry: kiapiRegistry }) as Record<string, unknown>;
    expect((json.message as Record<string, unknown>)["@type"]).toBe(typeUrlOf(GetVersionResponseSchema));
  });
});
