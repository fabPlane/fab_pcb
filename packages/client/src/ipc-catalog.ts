import {
  ScalarType,
  fromJson,
  toJson,
  type DescEnum,
  type DescField,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import { kiapiRegistry } from "@fp-pcb/proto";
import { commandSchemas } from "./commands";
import { KICAD_COMMIT } from "./commands-data";
import { KiCadApiError } from "./errors";
import { TransportError } from "./transport/types";
import type { CallOptions, KiCadClient } from "./client";
import {
  IPC_CATALOG,
  IPC_CATALOG_SHA256,
  IPC_CATALOG_VERSION,
  IPC_SCHEMA_SHA256,
  type IpcCatalogEntry,
} from "./ipc-catalog-data";

export {
  IPC_CATALOG,
  IPC_CATALOG_SHA256,
  IPC_CATALOG_VERSION,
  IPC_SCHEMA_SHA256,
  type IpcCatalogEntry,
} from "./ipc-catalog-data";

export type IpcCatalogSearch = {
  query?: string;
  operation?: string;
  documentType?: string;
  objectType?: string;
  capability?: string;
  headless?: "ok" | "gui-only" | "partial" | "unregistered" | "any";
  limit?: number;
};

export type IpcSchemaField = {
  name: string;
  protoName: string;
  number: number;
  cardinality: "singular" | "repeated" | "map";
  type: string;
  oneof?: string;
  presence: "implicit" | "explicit" | "required";
  units?: string;
  constraints: string[];
  enumValues?: Array<{ name: string; number: number }>;
  deprecated?: boolean;
};

export type IpcMessageSchema = {
  type: string;
  fields: IpcSchemaField[];
  oneofs: Array<{ name: string; fields: string[]; constraint: string }>;
};

export type IpcOperationDescription = IpcCatalogEntry & {
  catalog: { version: string; sha256: string; schemaSha256: string; kicadCommit: string };
  requestSchema: IpcMessageSchema;
  responseSchema: IpcMessageSchema;
  referencedSchemas: IpcMessageSchema[];
  requestExample: JsonValue;
  constraints: string[];
};

export type IpcCallResult = {
  operation: string;
  requestType: string;
  responseType: string;
  response: JsonValue;
  catalog: { version: string; sha256: string; schemaSha256: string; operationSchemaSha256: string };
};

export type IpcFailureCode =
  | "unknown_operation"
  | "unsupported"
  | "non_headless"
  | "invalid_schema"
  | "timeout"
  | "kicad_status";

export class IpcCallError extends Error {
  override readonly name = "IpcCallError";
  constructor(
    readonly code: IpcFailureCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function includes(value: string, wanted: string | undefined): boolean {
  return wanted === undefined || value.toLowerCase().includes(wanted.toLowerCase());
}

function has(values: readonly string[], wanted: string | undefined): boolean {
  return wanted === undefined || values.some((value) => includes(value, wanted));
}

/** Search the generated catalog without opening a KiCad session. */
export function searchIpcCatalog(search: IpcCatalogSearch = {}): IpcCatalogEntry[] {
  const limit = Math.max(1, Math.min(100, search.limit ?? 20));
  const query = search.query?.trim().toLowerCase();
  return IPC_CATALOG.filter((entry) => {
    if (!includes(entry.operation, search.operation)) return false;
    if (!has(entry.documentTypes, search.documentType)) return false;
    if (!has(entry.objectTypes, search.objectType)) return false;
    if (!has(entry.capabilities, search.capability)) return false;
    if (search.headless && search.headless !== "any" && entry.headless !== search.headless) return false;
    if (!query) return true;
    return [
      entry.operation,
      entry.group,
      entry.requestType,
      entry.responseType,
      entry.summary,
      ...entry.handlers,
      ...entry.documentTypes,
      ...entry.objectTypes,
      ...entry.capabilities,
    ].some((value) => value.toLowerCase().includes(query));
  }).slice(0, limit);
}

function scalarName(value: ScalarType): string {
  return ScalarType[value]?.toLowerCase() ?? `scalar(${value})`;
}

function enumValues(value: DescEnum): Array<{ name: string; number: number }> {
  return value.values.map((entry) => ({ name: entry.name, number: entry.number }));
}

function valueType(field: DescField): string {
  if (field.fieldKind === "scalar") return scalarName(field.scalar);
  if (field.fieldKind === "enum") return field.enum.typeName;
  if (field.fieldKind === "message") return field.message.typeName;
  if (field.fieldKind === "list") {
    const inner =
      field.listKind === "scalar"
        ? scalarName(field.scalar)
        : field.listKind === "enum"
          ? field.enum.typeName
          : field.message.typeName;
    return `${inner}[]`;
  }
  const value =
    field.mapKind === "scalar"
      ? scalarName(field.scalar)
      : field.mapKind === "enum"
        ? field.enum.typeName
        : field.message.typeName;
  return `map<${scalarName(field.mapKey)}, ${value}>`;
}

function units(field: DescField): string | undefined {
  const name = field.name.toLowerCase();
  if (name.endsWith("_nm") || field.parent.typeName.endsWith(".Distance") || /Vector[23]D?$/.test(field.parent.typeName)) return "nanometres";
  if (name.endsWith("_degrees") || field.parent.typeName.endsWith(".Angle")) return "degrees";
  if (name.endsWith("_as") || field.parent.typeName.endsWith(".Time")) return "attoseconds";
  if (field.parent.typeName.endsWith(".Ratio")) return "ratio 0.0..1.0";
  return undefined;
}

function constraints(field: DescField): string[] {
  const out: string[] = [];
  if (field.fieldKind === "list") out.push("JSON array; order is preserved");
  if (field.fieldKind === "map") out.push("JSON object with string-form keys");
  if (field.oneof) out.push(`at most one field in oneof ${field.oneof.name}`);
  const scalar = field.fieldKind === "scalar" ? field.scalar : field.fieldKind === "list" && field.listKind === "scalar" ? field.scalar : undefined;
  if (scalar !== undefined) {
    if ([ScalarType.INT64, ScalarType.UINT64, ScalarType.SINT64, ScalarType.FIXED64, ScalarType.SFIXED64].includes(scalar))
      out.push("64-bit integer encoded as a decimal JSON string");
    if ([ScalarType.UINT32, ScalarType.UINT64, ScalarType.FIXED32, ScalarType.FIXED64].includes(scalar)) out.push("non-negative integer");
    if (scalar === ScalarType.BYTES) out.push("base64-encoded JSON string");
  }
  const unit = units(field);
  if (unit) out.push(`unit: ${unit}`);
  if (field.deprecated) out.push("deprecated");
  return out;
}

function describeMessage(schema: DescMessage): IpcMessageSchema {
  return {
    type: schema.typeName,
    fields: schema.fields.map((field) => ({
      name: field.jsonName,
      protoName: field.name,
      number: field.number,
      cardinality: field.fieldKind === "list" ? "repeated" : field.fieldKind === "map" ? "map" : "singular",
      type: valueType(field),
      ...(field.oneof ? { oneof: field.oneof.name } : {}),
      presence: field.presence === 3 ? "required" : field.presence === 2 ? "explicit" : "implicit",
      ...(units(field) ? { units: units(field) } : {}),
      constraints: constraints(field),
      ...((field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum") || (field.fieldKind === "map" && field.mapKind === "enum"))
        ? { enumValues: enumValues(field.enum) }
        : {}),
      ...(field.deprecated ? { deprecated: true } : {}),
    })),
    oneofs: schema.oneofs.map((oneof) => ({
      name: oneof.name,
      fields: oneof.fields.map((field) => field.jsonName),
      constraint: "set at most one listed field",
    })),
  };
}

function childMessages(schema: DescMessage): DescMessage[] {
  const out: DescMessage[] = [];
  for (const field of schema.fields) {
    if (field.fieldKind === "message") out.push(field.message);
    else if (field.fieldKind === "list" && field.listKind === "message") out.push(field.message);
    else if (field.fieldKind === "map" && field.mapKind === "message") out.push(field.message);
  }
  return out;
}

function referencedSchemas(roots: DescMessage[], depth: number): IpcMessageSchema[] {
  const seen = new Set(roots.map((root) => root.typeName));
  let level = roots;
  const out: IpcMessageSchema[] = [];
  for (let i = 0; i < depth; i++) {
    const next: DescMessage[] = [];
    for (const parent of level) {
      for (const child of childMessages(parent)) {
        if (seen.has(child.typeName)) continue;
        seen.add(child.typeName);
        out.push(describeMessage(child));
        next.push(child);
      }
    }
    level = next;
  }
  return out;
}

function sampleScalar(type: ScalarType): JsonValue {
  if (type === ScalarType.BOOL) return true;
  if (type === ScalarType.STRING) return "string";
  if (type === ScalarType.BYTES) return "AA==";
  if ([ScalarType.INT64, ScalarType.UINT64, ScalarType.SINT64, ScalarType.FIXED64, ScalarType.SFIXED64].includes(type)) return "0";
  return 0;
}

function sampleField(field: DescField, depth: number): JsonValue {
  if (field.fieldKind === "scalar") return sampleScalar(field.scalar);
  if (field.fieldKind === "enum") return field.enum.values[0]?.name ?? 0;
  if (field.fieldKind === "message") return sampleMessage(field.message, depth - 1);
  if (field.fieldKind === "list") {
    const value = field.listKind === "scalar" ? sampleScalar(field.scalar) : field.listKind === "enum" ? field.enum.values[0]?.name ?? 0 : sampleMessage(field.message, depth - 1);
    return [value];
  }
  return {};
}

function sampleMessage(schema: DescMessage, depth: number): JsonValue {
  if (depth < 0 || schema.typeName === "google.protobuf.Any") return {};
  const out: Record<string, JsonValue> = {};
  const usedOneofs = new Set<string>();
  for (const field of schema.fields.slice(0, 4)) {
    if (field.oneof && usedOneofs.has(field.oneof.name)) continue;
    out[field.jsonName] = sampleField(field, depth);
    if (field.oneof) usedOneofs.add(field.oneof.name);
  }
  return out;
}

/** Describe one operation and a bounded graph of its referenced message schemas. */
export function describeIpcOperation(operation: string, schemaDepth = 2): IpcOperationDescription | undefined {
  const entry = IPC_CATALOG.find(
    (candidate) => candidate.operation.toLowerCase() === operation.toLowerCase() || candidate.requestType === operation,
  );
  if (!entry) return undefined;
  const schemas = commandSchemas(entry.operation)!;
  const depth = Math.max(0, Math.min(4, schemaDepth));
  return {
    ...entry,
    catalog: {
      version: IPC_CATALOG_VERSION,
      sha256: IPC_CATALOG_SHA256,
      schemaSha256: IPC_SCHEMA_SHA256,
      kicadCommit: KICAD_COMMIT,
    },
    requestSchema: describeMessage(schemas.request),
    responseSchema: describeMessage(schemas.response),
    referencedSchemas: referencedSchemas([schemas.request, schemas.response], depth),
    requestExample: sampleMessage(schemas.request, 2),
    constraints: [
      entry.headless === "ok" ? "supported by headless kicad-cli api-server" : `headless status: ${entry.headless}`,
      "unknown JSON fields are rejected",
      "enum names and lowerCamelCase protobuf JSON field names are accepted",
    ],
  };
}

/** Validate protobuf JSON against the registry and invoke the operation through KiCadClient. */
export async function callIpcOperation(
  client: KiCadClient,
  operation: string,
  request: JsonValue,
  opts: CallOptions = {},
): Promise<IpcCallResult> {
  const entry = IPC_CATALOG.find(
    (candidate) => candidate.operation.toLowerCase() === operation.toLowerCase() || candidate.requestType === operation,
  );
  if (!entry) throw new IpcCallError("unknown_operation", `unknown KiCad IPC operation ${operation}`);
  if (entry.headless === "gui-only")
    throw new IpcCallError("non_headless", `${entry.operation} is GUI-only and unavailable in kicad-cli api-server`, { headless: entry.headless });
  if (entry.headless !== "ok")
    throw new IpcCallError("unsupported", `${entry.operation} is not supported by the headless IPC catalog`, { headless: entry.headless });
  const schemas = commandSchemas(entry.operation)!;
  let message: MessageInitShape<DescMessage>;
  try {
    message = fromJson(schemas.request, request, { registry: kiapiRegistry, ignoreUnknownFields: false });
  } catch (cause) {
    throw new IpcCallError(
      "invalid_schema",
      `${entry.operation} request does not match ${entry.requestType}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { requestType: entry.requestType, schemaHash: entry.schemaHash },
      { cause },
    );
  }
  try {
    const response = await client.call(schemas.request, message, schemas.response, {
      ...opts,
      command: entry.operation,
      retry: false,
    });
    return {
      operation: entry.operation,
      requestType: entry.requestType,
      responseType: entry.responseType,
      response: toJson(schemas.response, response, { registry: kiapiRegistry }),
      catalog: {
        version: IPC_CATALOG_VERSION,
        sha256: IPC_CATALOG_SHA256,
        schemaSha256: IPC_SCHEMA_SHA256,
        operationSchemaSha256: entry.schemaHash,
      },
    };
  } catch (cause) {
    if (cause instanceof TransportError && cause.code === "timeout")
      throw new IpcCallError("timeout", cause.message, { operation: entry.operation }, { cause });
    if (cause instanceof KiCadApiError)
      throw new IpcCallError(
        cause.isUnsupported ? "unsupported" : cause.codeName === "AS_TIMEOUT" ? "timeout" : "kicad_status",
        cause.message,
        { operation: entry.operation, status: cause.codeName, serverMessage: cause.serverMessage },
        { cause },
      );
    throw cause;
  }
}
