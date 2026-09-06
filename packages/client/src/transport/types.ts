/**
 * Layer 1 — transport. Moves opaque `ApiRequest` bytes to a KiCad API server and returns the
 * opaque `ApiResponse` bytes. Everything protobuf lives above this layer.
 */

export type TransportState = "connecting" | "open" | "closed";

export interface SendOptions {
  /** Reject with `TransportError('timeout')` if no reply arrives within this many milliseconds. */
  timeoutMs?: number;
}

export interface Transport {
  /** Send one request and resolve with the raw reply bytes. Calls may be issued concurrently;
   *  each implementation decides whether they are pipelined or serialised. */
  send(request: Uint8Array, opts?: SendOptions): Promise<Uint8Array>;
  /** Close the transport. Pending requests are rejected with `TransportError('closed')`. Idempotent. */
  close(): Promise<void>;
  readonly state: TransportState;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(cb: (state: TransportState) => void): () => void;
}

export type TransportErrorCode = "timeout" | "closed" | "protocol" | "connect";

export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  static is(e: unknown, code?: TransportErrorCode): e is TransportError {
    return e instanceof TransportError && (code === undefined || e.code === code);
  }
}
