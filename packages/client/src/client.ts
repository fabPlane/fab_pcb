/**
 * Layer 2 — `KiCadClient`: packs a request message into `ApiRequest{header, Any}`, sends it through a
 * `Transport`, unpacks `ApiResponse`, and maps status codes to `KiCadApiError`. Retries `AS_BUSY` /
 * `AS_NOT_READY` with backoff, detects server restarts through `AS_TOKEN_MISMATCH`, and exposes the
 * server's command capabilities (`GetSupportedCommands`, falling back to the bundled coverage table).
 */
import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { anyUnpack, type Any } from "@bufbuild/protobuf/wkt";
import {
  ApiRequestSchema,
  ApiResponseSchema,
  ApiStatusCode,
  EmptySchema,
  GetSupportedCommandsResponseSchema,
  GetSupportedCommandsSchema,
  GetVersionResponseSchema,
  GetVersionSchema,
  PingSchema,
  kiapiRegistry,
  packAny,
  type ApiResponse,
  type KiCadVersion,
} from "@kicad-web/proto";
import { COMMANDS, KICAD_COMMIT, type CommandInfo } from "./commands-data";
import { KiCadApiError, statusName } from "./errors";
import { TransportError, type Transport } from "./transport/types";

export interface RetryOptions {
  /** First delay after an `AS_BUSY` / `AS_NOT_READY` reply. Default 50 ms. */
  baseDelayMs?: number;
  /** Upper bound of the exponential backoff. Default 1000 ms. */
  maxDelayMs?: number;
  /** Give up (and throw the last `KiCadApiError`) after this long. Default 30 000 ms. */
  deadlineMs?: number;
  /** Give up after this many attempts. Default unlimited (the deadline governs). */
  maxAttempts?: number;
}

export interface CallOptions {
  /** Per-request transport timeout; defaults to `KiCadClientOptions.defaultTimeoutMs`. */
  timeoutMs?: number;
  /** `false` disables the busy/not-ready retry for this call; an object overrides the defaults. */
  retry?: boolean | RetryOptions;
  /** Name used in errors and logs; defaults to the request message's simple name. */
  command?: string;
  /** Skip the capability check even when `KiCadClientOptions.checkCapabilities` is on. */
  force?: boolean;
}

export interface KiCadClientOptions {
  /** Identifies this client instance to KiCad (`ApiRequestHeader.client_name`); commits are keyed by it. */
  clientName: string;
  /** Token of the KiCad instance we expect to talk to; learned from the first reply when omitted. */
  kicadToken?: string;
  /** Default transport timeout per request. Default 30 000 ms. */
  defaultTimeoutMs?: number;
  /** Default retry policy for `AS_BUSY` / `AS_NOT_READY`. */
  retry?: RetryOptions;
  /** `connect()` pings until the server answers `AS_OK` (it answers `AS_NOT_READY` while loading). Default true. */
  waitForReady?: boolean;
  /** How long `connect()` waits for readiness. Default 60 000 ms. */
  readyTimeoutMs?: number;
  /**
   * When true, `call()` consults `capabilities()` first and throws `KiCadApiError(AS_UNIMPLEMENTED)`
   * for commands the server does not advertise, saving a round trip. Default false.
   */
  checkCapabilities?: boolean;
  log?: (message: string) => void;
}

export interface ServerRestartInfo {
  previousToken: string;
  newToken: string;
  command: string;
}

export interface CallTrace {
  command: string;
  status: ApiStatusCode;
  /** Wall time of the whole call including retries. */
  ms: number;
  attempts: number;
  requestBytes: number;
  responseBytes: number;
}

export interface CommandCapability {
  /** Simple command name, e.g. `GetVersion`. */
  command: string;
  /** Full request type name, e.g. `kiapi.common.commands.GetVersion`. */
  requestType: string;
  responseType: string | null;
  /** `true`/`false` from the server; from the bundled table `ok` -> true, `gui-only` -> false. */
  headless: boolean;
  /** Present when the bundled table knows the command. */
  info?: CommandInfo;
}

/** What the connected server can do. From `GetSupportedCommands` when available, else the bundled table. */
export class Capabilities {
  readonly byRequestType: ReadonlyMap<string, CommandCapability>;
  readonly byCommand: ReadonlyMap<string, CommandCapability>;

  constructor(
    readonly source: "server" | "bundled",
    entries: Iterable<CommandCapability>,
    /** KiCad commit the bundled table was generated from. */
    readonly bundledCommit: string = KICAD_COMMIT,
  ) {
    const byType = new Map<string, CommandCapability>();
    const byCmd = new Map<string, CommandCapability>();
    for (const e of entries) {
      byType.set(e.requestType, e);
      byCmd.set(e.command, e);
    }
    this.byRequestType = byType;
    this.byCommand = byCmd;
  }

  static fromBundled(): Capabilities {
    return new Capabilities(
      "bundled",
      COMMANDS.map((c) => ({
        command: c.command,
        requestType: c.requestType,
        responseType: c.responseType,
        headless: c.headless === "ok",
        info: c,
      })),
    );
  }

  private lookup(command: string | DescMessage): CommandCapability | undefined {
    if (typeof command === "string") {
      return this.byCommand.get(command) ?? this.byRequestType.get(command);
    }
    return this.byRequestType.get(command.typeName);
  }

  /** True when the server (or bundled table) lists the command at all. */
  has(command: string | DescMessage): boolean {
    return this.lookup(command) !== undefined;
  }

  get(command: string | DescMessage): CommandCapability | undefined {
    return this.lookup(command);
  }

  /** True when the command works without a GUI frame; `undefined` when unknown. */
  isHeadless(command: string | DescMessage): boolean | undefined {
    return this.lookup(command)?.headless;
  }

  commands(): CommandCapability[] {
    return [...this.byCommand.values()];
  }

  get size(): number {
    return this.byCommand.size;
  }
}

const DEFAULT_RETRY: Required<RetryOptions> = { baseDelayMs: 50, maxDelayMs: 1000, deadlineMs: 30_000, maxAttempts: Infinity };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function simpleName(typeName: string): string {
  const i = typeName.lastIndexOf(".");
  return i < 0 ? typeName : typeName.slice(i + 1);
}

function stripTypeUrl(url: string): string {
  const i = url.lastIndexOf("/");
  return i < 0 ? url : url.slice(i + 1);
}

export class KiCadClient {
  readonly transport: Transport;
  readonly clientName: string;
  readonly defaultTimeoutMs: number;
  readonly checkCapabilities: boolean;
  private token: string | undefined;
  private readonly retryDefaults: Required<RetryOptions>;
  private readonly readyTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly restartListeners = new Set<(info: ServerRestartInfo) => void>();
  private readonly traceListeners = new Set<(t: CallTrace) => void>();
  private caps: Promise<Capabilities> | undefined;
  private versionCache: Promise<KiCadVersion> | undefined;
  private closed = false;

  /** Creates the client and (by default) pings until the server is ready. */
  static async connect(transport: Transport, opts: KiCadClientOptions): Promise<KiCadClient> {
    const client = new KiCadClient(transport, opts);
    if (opts.waitForReady !== false) await client.waitUntilReady();
    return client;
  }

  constructor(transport: Transport, opts: KiCadClientOptions) {
    if (!opts.clientName) throw new Error("KiCadClient requires a clientName");
    this.transport = transport;
    this.clientName = opts.clientName;
    this.token = opts.kicadToken;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.retryDefaults = { ...DEFAULT_RETRY, ...opts.retry };
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
    this.checkCapabilities = opts.checkCapabilities ?? false;
    this.log = opts.log ?? (() => {});
  }

  /** The `kicad_token` of the instance we are talking to; set after the first successful reply. */
  get kicadToken(): string | undefined {
    return this.token;
  }

  /** Fired when a reply carries a different token than the one we know (KiCad restarted). */
  onServerRestarted(cb: (info: ServerRestartInfo) => void): () => void {
    this.restartListeners.add(cb);
    return () => this.restartListeners.delete(cb);
  }

  /** Debug/metrics hook called once per completed `call()` (successful or not). */
  onCall(cb: (trace: CallTrace) => void): () => void {
    this.traceListeners.add(cb);
    return () => this.traceListeners.delete(cb);
  }

  /** Pings until `AS_OK`; KiCad answers `AS_NOT_READY` while a preloaded document is loading. */
  async waitUntilReady(timeoutMs: number = this.readyTimeoutMs): Promise<void> {
    await this.call(PingSchema, {}, EmptySchema, {
      command: "Ping",
      retry: { deadlineMs: timeoutMs, baseDelayMs: 20, maxDelayMs: 200 },
    });
  }

  async ping(): Promise<void> {
    await this.call(PingSchema, {}, EmptySchema, { command: "Ping" });
  }

  /** `GetVersion`, cached for the life of the client. */
  version(): Promise<KiCadVersion> {
    this.versionCache ??= this.call(GetVersionSchema, {}, GetVersionResponseSchema, { command: "GetVersion" }).then(
      (r) => r.version ?? create(GetVersionResponseSchema).version!,
    );
    return this.versionCache;
  }

  /** Encodes `ApiRequest{header, Any(req)}` — exposed for tests and for pipelining custom transports. */
  encodeRequest<Req extends DescMessage>(reqSchema: Req, req: MessageInitShape<Req>): Uint8Array {
    const message = packAny(reqSchema, create(reqSchema, req));
    const envelope = create(ApiRequestSchema, {
      header: { kicadToken: this.token ?? "", clientName: this.clientName },
      message,
    });
    return toBinary(ApiRequestSchema, envelope);
  }

  decodeResponse(bytes: Uint8Array): ApiResponse {
    return fromBinary(ApiResponseSchema, bytes);
  }

  /**
   * Sends one command and returns the typed response. Throws `KiCadApiError` for any status other
   * than `AS_OK` (after retrying busy/not-ready), `TransportError` for connection problems.
   */
  async call<Req extends DescMessage, Res extends DescMessage>(
    reqSchema: Req,
    req: MessageInitShape<Req>,
    resSchema: Res,
    opts: CallOptions = {},
  ): Promise<MessageShape<Res>> {
    const command = opts.command ?? simpleName(reqSchema.typeName);
    const res = await this.callRaw(reqSchema, req, opts);
    if (!res.message || !res.message.typeUrl) {
      // Empty-returning commands may omit the Any entirely.
      return create(resSchema);
    }
    const unpacked = anyUnpack(res.message, resSchema);
    if (unpacked) return unpacked;
    const actual = stripTypeUrl(res.message.typeUrl);
    if (actual === EmptySchema.typeName) return create(resSchema);
    throw new KiCadApiError(
      ApiStatusCode.AS_UNKNOWN,
      `expected response type ${resSchema.typeName}, got ${actual}`,
      command,
    );
  }

  /**
   * Like `call` but returns the response payload as an `Any` (or `undefined`), for callers that
   * decide the response type dynamically (`unpackAny` with `kiapiRegistry`).
   */
  async callAny<Req extends DescMessage>(reqSchema: Req, req: MessageInitShape<Req>, opts: CallOptions = {}): Promise<Any | undefined> {
    const res = await this.callRaw(reqSchema, req, opts);
    return res.message && res.message.typeUrl ? res.message : undefined;
  }

  /** Sends one command and returns the whole `ApiResponse` after status handling and retries. */
  async callRaw<Req extends DescMessage>(reqSchema: Req, req: MessageInitShape<Req>, opts: CallOptions = {}): Promise<ApiResponse> {
    if (this.closed) throw new TransportError("closed", "KiCadClient is closed");
    const command = opts.command ?? simpleName(reqSchema.typeName);
    const exempt = reqSchema.typeName === GetSupportedCommandsSchema.typeName || reqSchema.typeName === PingSchema.typeName;
    if (this.checkCapabilities && !opts.force && !exempt) {
      const caps = await this.capabilities();
      const cap = caps.get(reqSchema);
      if (cap && !cap.headless && caps.source === "server") {
        throw new KiCadApiError(ApiStatusCode.AS_UNIMPLEMENTED, `${command} is not available on this server (GUI-only)`, command);
      }
      if (!cap && caps.source === "server") {
        throw new KiCadApiError(ApiStatusCode.AS_UNHANDLED, `${command} is not advertised by this server`, command);
      }
    }
    const retry = opts.retry === false ? null : { ...this.retryDefaults, ...(typeof opts.retry === "object" ? opts.retry : {}) };
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const started = performance.now();
    let attempts = 0;
    let delay = retry?.baseDelayMs ?? 0;
    let requestBytes = 0;
    let responseBytes = 0;
    let status = ApiStatusCode.AS_UNKNOWN;
    try {
      for (;;) {
        attempts++;
        const bytes = this.encodeRequest(reqSchema, req);
        requestBytes = bytes.length;
        const replyBytes = await this.transport.send(bytes, { timeoutMs });
        responseBytes = replyBytes.length;
        const res = this.decodeResponse(replyBytes);
        status = res.status?.status ?? ApiStatusCode.AS_UNKNOWN;
        const replyToken = res.header?.kicadToken ?? "";
        if (status === ApiStatusCode.AS_TOKEN_MISMATCH) {
          const previous = this.token ?? "";
          this.token = replyToken || undefined;
          this.log(`${command}: token mismatch (server restarted? ${previous} -> ${replyToken})`);
          for (const cb of this.restartListeners) cb({ previousToken: previous, newToken: replyToken, command });
          throw new KiCadApiError(status, res.status?.errorMessage ?? "", command);
        }
        if (status === ApiStatusCode.AS_OK) {
          if (replyToken && replyToken !== this.token) {
            const previous = this.token;
            this.token = replyToken;
            if (previous !== undefined) {
              for (const cb of this.restartListeners) cb({ previousToken: previous, newToken: replyToken, command });
            }
          }
          return res;
        }
        if ((status === ApiStatusCode.AS_BUSY || status === ApiStatusCode.AS_NOT_READY) && retry) {
          const elapsed = performance.now() - started;
          if (elapsed + delay <= retry.deadlineMs && attempts < retry.maxAttempts) {
            this.log(`${command}: ${statusName(status)}, retrying in ${delay} ms (attempt ${attempts})`);
            await sleep(delay);
            delay = Math.min(delay * 2, retry.maxDelayMs);
            continue;
          }
        }
        throw new KiCadApiError(status, res.status?.errorMessage ?? "", command);
      }
    } finally {
      if (this.traceListeners.size) {
        const trace: CallTrace = { command, status, ms: performance.now() - started, attempts, requestBytes, responseBytes };
        for (const cb of this.traceListeners) cb(trace);
      }
    }
  }

  /**
   * Commands the server supports. Uses `GetSupportedCommands` when the server implements it (KiCad
   * >= the `web-api` branch), otherwise the coverage table bundled at build time. Cached.
   */
  capabilities(): Promise<Capabilities> {
    this.caps ??= this.fetchCapabilities();
    return this.caps;
  }

  /** Drops the cached capabilities (call after a server restart). */
  invalidateCapabilities(): void {
    this.caps = undefined;
    this.versionCache = undefined;
  }

  private async fetchCapabilities(): Promise<Capabilities> {
    const bundled = new Map(COMMANDS.map((c) => [c.requestType, c]));
    try {
      const res = await this.call(GetSupportedCommandsSchema, {}, GetSupportedCommandsResponseSchema, {
        command: "GetSupportedCommands",
        force: true,
      });
      const entries: CommandCapability[] = res.commands.map((c) => {
        const requestType = stripTypeUrl(c.typeUrl);
        return {
          command: simpleName(requestType),
          requestType,
          responseType: c.responseTypeUrl ? stripTypeUrl(c.responseTypeUrl) : null,
          headless: c.headless,
          info: bundled.get(requestType),
        };
      });
      this.log(`capabilities: ${entries.length} commands from GetSupportedCommands`);
      return new Capabilities("server", entries);
    } catch (e) {
      if (KiCadApiError.is(e) && e.isUnsupported) {
        this.log(`capabilities: GetSupportedCommands not available (${e.codeName}); using bundled table @ ${KICAD_COMMIT.slice(0, 10)}`);
        return Capabilities.fromBundled();
      }
      throw e;
    }
  }

  /** Convenience: does the server advertise `command` (simple name, full type name, or schema)? */
  async supports(command: string | DescMessage): Promise<boolean> {
    const caps = await this.capabilities();
    const cap = caps.get(command);
    return cap !== undefined && (caps.source === "bundled" || cap.headless);
  }

  /** Resolves a request type name to its descriptor through the kiapi registry. */
  static schemaFor(typeName: string): DescMessage | undefined {
    return kiapiRegistry.getMessage(typeName);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.transport.close();
  }
}
