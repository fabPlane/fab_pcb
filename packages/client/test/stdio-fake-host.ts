#!/usr/bin/env bun
/**
 * A stand-in for `kicad-api-host-native` used by `stdio.test.ts`: it speaks the same framing
 * (`uint32be length || payload` on stdin/stdout, events on fd 3) but answers with the request
 * payload reversed instead of running KiCad, so the transport can be tested without a build.
 *
 *   --delay <ms>       wait this long before answering each request
 *   --events <n>       publish n event frames (`event-<i>`) on fd 3 at startup
 *   --event-per-reply  publish one event frame per request, from inside the request handler
 *   --exit-after <n>   exit(7) after answering n requests
 *   --no-events        do not touch fd 3 at all
 */
import { writeSync } from "node:fs";

const argv = Bun.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
};

const delayMs = value("--delay", 0);
const startupEvents = value("--events", 0);
const exitAfter = value("--exit-after", 0);
const eventPerReply = flag("--event-per-reply");
const noEvents = flag("--no-events");

const EVENTS_FD = 3;
const enc = new TextEncoder();

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

function publish(text: string): void {
  if (noEvents) return;
  try {
    writeSync(EVENTS_FD, frame(enc.encode(text)));
  } catch {
    /* the parent did not open fd 3 */
  }
}

for (let i = 0; i < startupEvents; i++) publish(`event-${i}`);

let buf = new Uint8Array(0);
let answered = 0;

const stdin = Bun.stdin.stream().getReader();
for (;;) {
  const { done, value: chunk } = await stdin.read();
  if (done) break;
  const next = new Uint8Array(buf.length + chunk.length);
  next.set(buf);
  next.set(chunk, buf.length);
  buf = next;
  for (;;) {
    if (buf.length < 4) break;
    const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
    if (buf.length < 4 + len) break;
    const payload = buf.slice(4, 4 + len);
    buf = buf.subarray(4 + len);
    if (delayMs > 0) await Bun.sleep(delayMs);
    if (eventPerReply) publish(`event-for-${new TextDecoder().decode(payload)}`);
    Bun.write(Bun.stdout, frame(payload.slice().reverse()));
    answered++;
    if (exitAfter > 0 && answered >= exitAfter) {
      await Bun.sleep(10);
      process.exit(7);
    }
  }
}
