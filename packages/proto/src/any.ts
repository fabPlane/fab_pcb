/**
 * google.protobuf.Any helpers and the type registry covering every kiapi message plus the
 * well-known types KiCad uses (Any, Empty, FieldMask, ...).
 */
import { createRegistry, type DescMessage, type Message, type MessageShape, type Registry } from "@bufbuild/protobuf";
import {
  anyIs,
  anyPack,
  anyUnpack,
  file_google_protobuf_any,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_wrappers,
  type Any,
} from "@bufbuild/protobuf/wkt";
import { kiapiFiles } from "./gen/index.js";

/** Well-known-type descriptors included in {@link kiapiRegistry}. */
export const wellKnownFiles = [
  file_google_protobuf_any,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_duration,
  file_google_protobuf_timestamp,
  file_google_protobuf_struct,
  file_google_protobuf_wrappers,
] as const;

/** Registry of every kiapi.* message/enum plus google.protobuf well-known types; use it to unpack Any. */
export const kiapiRegistry: Registry = createRegistry(...kiapiFiles, ...wellKnownFiles);

/** The type URL KiCad expects inside google.protobuf.Any: `type.googleapis.com/<fullName>`. */
export function typeUrlOf(schema: DescMessage | { typeName: string }): string {
  return `type.googleapis.com/${schema.typeName}`;
}

/** Wraps `msg` in a google.protobuf.Any with the `type.googleapis.com/...` URL. */
export function packAny<Desc extends DescMessage>(schema: Desc, msg: MessageShape<Desc>): Any {
  return anyPack(schema, msg);
}

/**
 * Unpacks an Any using the registry (default {@link kiapiRegistry}); returns undefined when the Any is
 * empty or its type is unknown to the registry.
 */
export function unpackAny(any: Any, registry: Registry = kiapiRegistry): Message | undefined {
  return anyUnpack(any, registry);
}

/** Unpacks an Any as a specific message type; returns undefined if the Any holds a different type. */
export function unpackAnyAs<Desc extends DescMessage>(any: Any, schema: Desc): MessageShape<Desc> | undefined {
  return anyUnpack(any, schema);
}

/** True if the Any holds a message of the given schema / full type name. */
export function anyHolds(any: Any, schema: DescMessage | string): boolean {
  return typeof schema === "string" ? anyIs(any, schema) : anyIs(any, schema);
}
