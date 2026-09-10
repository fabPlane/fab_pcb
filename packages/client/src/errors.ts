/**
 * Errors raised above the transport layer. `TransportError` (connection, timeout, framing) stays in
 * `./transport`; everything here is about what KiCad answered.
 */
import { ApiStatusCode, ItemDeletionStatus, ItemRequestStatus, ItemStatusCode, RunActionStatus } from "@fp-pcb/proto";

export { ApiStatusCode, ItemStatusCode, ItemDeletionStatus, ItemRequestStatus, RunActionStatus };

/** Human-readable name of an `ApiStatusCode` (e.g. `AS_BUSY`). */
export function statusName(code: ApiStatusCode | number): string {
  return ApiStatusCode[code] ?? `ApiStatusCode(${code})`;
}

/** KiCad answered a request with a status other than `AS_OK`. */
export class KiCadApiError extends Error {
  override readonly name: string = "KiCadApiError";
  readonly code: ApiStatusCode;
  readonly command: string;

  constructor(code: ApiStatusCode, message: string, command: string, options?: { cause?: unknown }) {
    super(`${command}: ${statusName(code)}${message ? ` - ${message}` : ""}`, options);
    this.code = code;
    this.command = command;
  }

  /** The `error_message` KiCad sent, without the command / status prefix. */
  get serverMessage(): string {
    const prefix = `${this.command}: ${statusName(this.code)}`;
    return this.message.startsWith(`${prefix} - `) ? this.message.slice(prefix.length + 3) : "";
  }

  get codeName(): string {
    return statusName(this.code);
  }

  /** True when the server says the command exists but is not available headless (or at all). */
  get isUnsupported(): boolean {
    return this.code === ApiStatusCode.AS_UNIMPLEMENTED || this.code === ApiStatusCode.AS_UNHANDLED;
  }

  static is(e: unknown, code?: ApiStatusCode): e is KiCadApiError {
    return e instanceof KiCadApiError && (code === undefined || e.code === code);
  }
}

/** The client refused to send a command the connected server does not advertise. */
export class CapabilityError extends Error {
  override readonly name = "CapabilityError";
  constructor(
    readonly command: string,
    reason: string,
  ) {
    super(`${command}: ${reason}`);
  }
}

/** One item that KiCad rejected inside a Create/Update/Delete/Flip request. */
export interface ItemFailure {
  /** KIID of the item when known (deletes always know it; create/update use the request item's id). */
  id: string;
  /** Position of the item in the request. */
  index: number;
  /** `ItemStatusCode` for create/update/flip, `ItemDeletionStatus` for deletes. */
  code: number;
  codeName: string;
  message: string;
}

/** A Create/Update/Delete request came back `AS_OK` but one or more items were rejected. */
export class KiCadItemError extends Error {
  override readonly name = "KiCadItemError";
  constructor(
    readonly command: string,
    readonly failures: readonly ItemFailure[],
    readonly requestStatus: ItemRequestStatus = ItemRequestStatus.IRS_OK,
  ) {
    super(
      failures.length
        ? `${command}: ${failures.length} item(s) rejected: ${failures
            .slice(0, 3)
            .map((f) => `${f.id || `#${f.index}`} ${f.codeName}${f.message ? ` (${f.message})` : ""}`)
            .join("; ")}${failures.length > 3 ? "; ..." : ""}`
        : `${command}: request status ${ItemRequestStatus[requestStatus] ?? requestStatus}`,
    );
  }
}

/** A commit callback threw; the commit was dropped (`CMA_DROP`) and the original error is `cause`. */
export class CommitDroppedError extends Error {
  override readonly name = "CommitDroppedError";
  constructor(
    readonly commitId: string,
    cause: unknown,
  ) {
    super(`commit ${commitId} dropped: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** A job (`RunBoardJob*` / `RunSchematicJob*`) reported `JS_ERROR` (or `JS_WARNING` with `failOnWarning`). */
export class JobError extends Error {
  override readonly name = "JobError";
  constructor(
    readonly command: string,
    message: string,
    readonly outputPaths: readonly string[],
    /** Job id when KiCad assigned one (KiCad >= 11.0). */
    readonly jobId = "",
  ) {
    super(`${command}: ${message || "job failed"}`);
  }
}

/** `RunAction` answered something other than `RAS_OK` (unknown name, or GUI-only action headless). */
export class ActionError extends Error {
  override readonly name = "ActionError";
  constructor(
    readonly action: string,
    readonly status: RunActionStatus,
  ) {
    super(`RunAction ${action}: ${RunActionStatus[status] ?? status}`);
  }

  get statusName(): string {
    return RunActionStatus[this.status] ?? String(this.status);
  }
}
