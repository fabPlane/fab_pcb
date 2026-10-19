import { constants } from "node:os";

/** Own a command and its POSIX process group until its direct child exits. */
export interface OwnedCommandResult {
  code: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  wallMs: number;
}

export async function runOwnedCommand(
  cmd: string[],
  opts: {
    cwd?: string | undefined;
    timeoutMs?: number | undefined;
    killSignal?: number | undefined;
    env?: Record<string, string> | undefined;
    signal?: AbortSignal | undefined;
    onStdout?: ((chunk: string) => void) | undefined;
    onStderr?: ((chunk: string) => void) | undefined;
  } = {},
): Promise<OwnedCommandResult> {
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0)) {
    throw new RangeError("timeoutMs must be a finite nonnegative number");
  }
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must not exceed 2147483647");
  }
  if (opts.killSignal !== undefined &&
      (!Number.isInteger(opts.killSignal) || opts.killSignal <= 0 ||
       !Object.values(constants.signals).includes(opts.killSignal))) {
    throw new RangeError("killSignal must be a supported nonzero signal number");
  }
  const started = performance.now();
  if (opts.signal?.aborted) return {
    code: 124, exitCode: 124, stdout: "", stderr: "", timedOut: false, cancelled: true,
    wallMs: performance.now() - started,
  };
  const grouped = process.platform !== "win32";
  const proc = Bun.spawn(cmd, {
    detached: grouped, stdout: "pipe", stderr: "pipe",
    env: opts.env ?? process.env, ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const stop = (signal: number = 9) => {
    try {
      if (grouped) process.kill(-proc.pid, signal);
      else if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const outputAbort = new AbortController();
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false, cancelled = false;
  const onAbort = () => { cancelled = true; stop(); outputAbort.abort(); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    const signal = opts.killSignal ?? 9;
    stop(signal);
    // Caller-selected signals get a bounded grace period. Direct-child exit
    // clears this timer before final group cleanup, avoiding a delayed kill.
    if (signal !== 9) escalation = setTimeout(() => stop(), 100);
    outputAbort.abort();
  }, opts.timeoutMs) : undefined;
  // Start draining before waiting for exit so a full pipe cannot block the child.
  const stdout = consume(proc.stdout, outputAbort.signal, opts.onStdout);
  const stderr = consume(proc.stderr, outputAbort.signal, opts.onStderr);
  // Do not wait for inherited pipes before stopping descendants. The direct
  // child's exit is the outcome; its helpers cannot extend the deadline.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = proc.exited.then((code) => {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    opts.signal?.removeEventListener("abort", onAbort);
    stop();
    // A deliberately detached child can retain pipes outside our group. Bound
    // final draining without turning a completed parent into a timeout.
    drainTimer = setTimeout(() => outputAbort.abort(), 100);
    return code;
  });
  try {
    const [out, err, code] = await Promise.all([stdout, stderr, exited]);
    return { code: timedOut || cancelled ? 124 : code, exitCode: code, stdout: out, stderr: err,
      timedOut, cancelled, wallMs: performance.now() - started };
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    opts.signal?.removeEventListener("abort", onAbort);
    stop();
    outputAbort.abort();
    await Promise.allSettled([stdout, stderr, exited]);
    if (drainTimer) clearTimeout(drainTimer);
  }
}

async function consume(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal,
  callback?: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      callback?.(chunk);
    }
    const tail = decoder.decode();
    if (tail) callback?.(tail);
    return text + tail;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
