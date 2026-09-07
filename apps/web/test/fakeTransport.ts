// In-memory `Transport` speaking the KiCad envelope, for testing the kicad services without
// a bridge or a `kicad-cli` process (a trimmed copy of packages/client/test/fake-transport.ts).
import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { anyUnpack, type Any } from '@bufbuild/protobuf/wkt';
import { ApiRequestSchema, ApiResponseSchema, ApiStatusCode, EmptySchema, PingSchema, kiapiRegistry, packAny, type ApiRequest } from '@fp-pcb/proto';
import { TransportError, type SendOptions, type Transport, type TransportState } from '@fp-pcb/client';

export interface FakeReply {
  status?: ApiStatusCode;
  errorMessage?: string;
  message?: Any;
}

export function reply<Desc extends DescMessage>(schema: Desc, init: Parameters<typeof create<Desc>>[1]): FakeReply {
  return { status: ApiStatusCode.AS_OK, message: packAny(schema, create(schema, init)) };
}

export const ok = (): FakeReply => ({ status: ApiStatusCode.AS_OK });
export const fail = (status: ApiStatusCode, errorMessage = ''): FakeReply => ({ status, errorMessage });

export interface RecordedCall {
  typeName: string;
  request: unknown;
  clientName: string;
}

export class FakeTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  token = 'fake-token-0000-0000-0000-000000000000';
  private readonly handlers = new Map<string, (req: unknown, envelope: ApiRequest) => FakeReply | Promise<FakeReply>>();
  private _state: TransportState = 'open';
  private readonly listeners = new Set<(s: TransportState) => void>();

  constructor() {
    this.on(PingSchema, () => ok());
  }

  on<Desc extends DescMessage>(schema: Desc, handler: (req: MessageShape<Desc>, envelope: ApiRequest) => FakeReply | Promise<FakeReply>): this {
    this.handlers.set(schema.typeName, handler as (req: unknown, envelope: ApiRequest) => FakeReply | Promise<FakeReply>);
    return this;
  }

  get state(): TransportState {
    return this._state;
  }

  onStateChange(cb: (s: TransportState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  requestsOf<Desc extends DescMessage>(schema: Desc): MessageShape<Desc>[] {
    return this.calls.filter((c) => c.typeName === schema.typeName).map((c) => c.request as MessageShape<Desc>);
  }

  async send(bytes: Uint8Array, _opts?: SendOptions): Promise<Uint8Array> {
    if (this._state !== 'open') throw new TransportError('closed', 'fake transport closed');
    const envelope = fromBinary(ApiRequestSchema, bytes);
    const any = envelope.message;
    const typeName = any ? any.typeUrl.slice(any.typeUrl.lastIndexOf('/') + 1) : '';
    const req = any ? anyUnpack(any, kiapiRegistry) : undefined;
    this.calls.push({ typeName, request: req, clientName: envelope.header?.clientName ?? '' });
    const handler = this.handlers.get(typeName);
    const r = handler ? await handler(req, envelope) : fail(ApiStatusCode.AS_UNHANDLED, `no handler for ${typeName}`);
    const res = create(ApiResponseSchema, {
      header: { kicadToken: this.token },
      status: { status: r.status ?? ApiStatusCode.AS_OK, errorMessage: r.errorMessage ?? '' },
      message: r.message ?? (r.status === undefined || r.status === ApiStatusCode.AS_OK ? packAny(EmptySchema, create(EmptySchema)) : undefined),
    });
    return toBinary(ApiResponseSchema, res);
  }

  /** Simulates the WebSocket dropping. */
  drop(): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    for (const cb of this.listeners) cb('closed');
  }

  async close(): Promise<void> {
    this.drop();
  }
}
