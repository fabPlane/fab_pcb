/**
 * Embedded files (`kiapi.common.types.EmbeddedFile`). KiCad's API carries `data` in the same form
 * the `.kicad_pcb` file stores it — base64 text of a zstd frame — and `data_hash` may be empty.
 * These helpers convert raw bytes to and from that form. zstd is provided by the runtime: Bun
 * (`Bun.zstdCompressSync`) and Node >= 22.15 (`node:zlib`); in a browser pass already-encoded
 * data (or run the encoding on the bridge) — `hasZstd()` tells you which case you are in.
 */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { EmbeddedFileSchema, EmbeddedFileType, type EmbeddedFile } from "@fp-pcb/proto";

interface ZstdApi {
  compress(data: Uint8Array): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

function zstd(): ZstdApi | undefined {
  const b = (globalThis as { Bun?: { zstdCompressSync?: (d: Uint8Array) => Uint8Array; zstdDecompressSync?: (d: Uint8Array) => Uint8Array } }).Bun;
  if (b?.zstdCompressSync && b.zstdDecompressSync) {
    return { compress: (d) => b.zstdCompressSync!(d), decompress: (d) => b.zstdDecompressSync!(d) };
  }
  return undefined;
}

/** True when this runtime can zstd-encode/decode embedded file data. */
export function hasZstd(): boolean {
  return zstd() !== undefined;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Raw bytes -> base64(zstd(raw)) as KiCad expects in `EmbeddedFile.data`. */
export function encodeEmbeddedFileData(raw: Uint8Array): Uint8Array {
  const z = zstd();
  if (!z) throw new Error("zstd is not available in this runtime; pass pre-encoded embedded file data");
  return new TextEncoder().encode(toBase64(z.compress(raw)));
}

/** `EmbeddedFile.data` (base64 of a zstd frame) -> raw bytes. */
export function decodeEmbeddedFileData(encoded: Uint8Array | string): Uint8Array {
  const z = zstd();
  if (!z) throw new Error("zstd is not available in this runtime; cannot decode embedded file data");
  const text = typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded);
  return z.decompress(fromBase64(text));
}

export interface EmbeddedFileInput {
  name: string;
  type?: EmbeddedFileType;
  /** File content; raw bytes unless `encoded` is true. */
  data: Uint8Array;
  /** Set when `data` is already base64(zstd(...)). */
  encoded?: boolean;
  /** Optional hash; KiCad accepts an empty one. */
  dataHash?: string;
}

/** Builds the proto message, encoding raw data when needed. */
export function toEmbeddedFile(input: EmbeddedFileInput | MessageInitShape<typeof EmbeddedFileSchema>): EmbeddedFile {
  if ("encoded" in input || (input.data instanceof Uint8Array && !("dataHash" in input) && !("$typeName" in input))) {
    const i = input as EmbeddedFileInput;
    return create(EmbeddedFileSchema, {
      name: i.name,
      type: i.type ?? EmbeddedFileType.EFT_OTHER,
      data: i.encoded ? i.data : encodeEmbeddedFileData(i.data),
      dataHash: i.dataHash ?? "",
    });
  }
  return create(EmbeddedFileSchema, input as MessageInitShape<typeof EmbeddedFileSchema>);
}

/** Decoded content of a file returned by `GetEmbeddedFiles`. */
export function embeddedFileContent(file: EmbeddedFile): Uint8Array {
  return decodeEmbeddedFileData(file.data);
}
