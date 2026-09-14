/**
 * An in-memory `Transport` that speaks the KiCad envelope: decodes `ApiRequest`, dispatches on the
 * request type URL to a handler you register, and encodes `ApiResponse`. Lets the client, commit
 * and store layers be unit-tested without a KiCad process.
 */
import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { anyUnpack, type Any } from "@bufbuild/protobuf/wkt";
import {
  ApiRequestSchema,
  ApiResponseSchema,
  ApiStatusCode,
  EmptySchema,
  PingSchema,
  kiapiRegistry,
  packAny,
  type ApiRequest,
} from "@fp-pcb/proto";
import { TransportError, type SendOptions, type Transport, type TransportState } from "../src/transport/types";

export interface FakeReply {
  status?: ApiStatusCode;
  errorMessage?: string;
  /** Response payload (already packed) — omit for Empty. */
  message?: Any;
  /** Override the kicad token in this reply. */
  token?: string;
}

export type FakeHandler = (req: unknown, envelope: ApiRequest) => FakeReply | Promise<FakeReply>;

export interface RecordedCall {
  typeName: string;
  request: unknown;
  clientName: string;
  token: string;
}

export function reply<Desc extends DescMessage>(schema: Desc, init: Parameters<typeof create<Desc>>[1]): FakeReply {
  return { status: ApiStatusCode.AS_OK, message: packAny(schema, create(schema, init)) };
}

export function ok(): FakeReply {
  return { status: ApiStatusCode.AS_OK };
}

export function fail(status: ApiStatusCode, errorMessage = ""): FakeReply {
  return { status, errorMessage };
}

export class FakeTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  token = "fake-token-0000-0000-0000-000000000000";
  private readonly handlers = new Map<string, FakeHandler>();
  private _state: TransportState = "open";
  private readonly listeners = new Set<(s: TransportState) => void>();
  /** Artificial per-request latency in ms (lets tests observe batching). */
  latencyMs = 0;

  constructor() {
    this.on(PingSchema, () => ok());
  }

  on<Desc extends DescMessage>(
    schema: Desc,
    handler: (req: MessageShape<Desc>, envelope: ApiRequest) => FakeReply | Promise<FakeReply>,
  ): this {
    this.handlers.set(schema.typeName, handler as FakeHandler);
    return this;
  }

  /** Replies `status` for the next `n` requests of `schema`, then falls back to the handler. */
  failNext<Desc extends DescMessage>(schema: Desc, n: number, status: ApiStatusCode, errorMessage = ""): this {
    const prev = this.handlers.get(schema.typeName);
    let left = n;
    this.handlers.set(schema.typeName, (req, env) => {
      if (left-- > 0) return fail(status, errorMessage);
      if (prev) return prev(req, env);
      return ok();
    });
    return this;
  }

  get state(): TransportState {
    return this._state;
  }

  onStateChange(cb: (s: TransportState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  countOf(schema: DescMessage): number {
    return this.calls.filter((c) => c.typeName === schema.typeName).length;
  }

  requestsOf<Desc extends DescMessage>(schema: Desc): MessageShape<Desc>[] {
    return this.calls.filter((c) => c.typeName === schema.typeName).map((c) => c.request as MessageShape<Desc>);
  }

  async send(bytes: Uint8Array, _opts?: SendOptions): Promise<Uint8Array> {
    if (this._state !== "open") throw new TransportError("closed", "fake transport closed");
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    let envelope: ApiRequest;
    try {
      envelope = fromBinary(ApiRequestSchema, bytes);
    } catch {
      return this.encode({ status: ApiStatusCode.AS_BAD_REQUEST, errorMessage: "bad envelope" });
    }
    const any = envelope.message;
    const typeName = any ? any.typeUrl.slice(any.typeUrl.lastIndexOf("/") + 1) : "";
    const req = any ? anyUnpack(any, kiapiRegistry) : undefined;
    this.calls.push({ typeName, request: req, clientName: envelope.header?.clientName ?? "", token: envelope.header?.kicadToken ?? "" });
    const token = envelope.header?.kicadToken ?? "";
    if (token && token !== this.token) {
      return this.encode({ status: ApiStatusCode.AS_TOKEN_MISMATCH, errorMessage: "token mismatch" });
    }
    const handler = this.handlers.get(typeName);
    if (!handler) return this.encode({ status: ApiStatusCode.AS_UNHANDLED, errorMessage: `no handler for ${typeName}` });
    const r = await handler(req, envelope);
    return this.encode(r);
  }

  private encode(r: FakeReply): Uint8Array {
    const res = create(ApiResponseSchema, {
      header: { kicadToken: r.token ?? this.token },
      status: { status: r.status ?? ApiStatusCode.AS_OK, errorMessage: r.errorMessage ?? "" },
      message:
        r.message ?? (r.status === undefined || r.status === ApiStatusCode.AS_OK ? packAny(EmptySchema, create(EmptySchema)) : undefined),
    });
    return toBinary(ApiResponseSchema, res);
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    for (const cb of this.listeners) cb("closed");
  }
}
