/**
 * An in-process stand-in for a loaded KiCad wasm module (`@fp-pcb/kicad-wasm`), in the spirit of
 * `fake-transport.ts`: `dispatch()` is synchronous, may publish events while it runs, and records
 * whether it was ever re-entered — which is what `WasmTransport` must prevent.
 */
import type { KiCadWasmInstance } from "../src/transport/wasm";

export class FakeWasmInstance implements KiCadWasmInstance {
  /** Every request payload handed to `dispatch()`, in order. */
  readonly requests: Uint8Array[] = [];
  /** True if `dispatch()` was entered while another dispatch was still running. */
  reentered = false;
  shutdowns = 0;
  /** Busy-wait this many ms inside `dispatch()` (the module is synchronous, so this blocks). */
  blockMs = 0;
  /** Set to make the next `dispatch()` throw. */
  throwNext: Error | null = null;
  /** Event frames published from inside `dispatch()`, computed from the request. */
  eventsPerDispatch: (request: Uint8Array) => Uint8Array[] = () => [];
  /** Reply for a request; by default the payload reversed. */
  reply: (request: Uint8Array) => Uint8Array = (r) => r.slice().reverse();

  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private inDispatch = false;

  dispatch(request: Uint8Array): Uint8Array {
    if (this.inDispatch) this.reentered = true;
    this.inDispatch = true;
    try {
      this.requests.push(request.slice());
      if (this.throwNext) {
        const e = this.throwNext;
        this.throwNext = null;
        throw e;
      }
      if (this.blockMs > 0) {
        const until = Date.now() + this.blockMs;
        while (Date.now() < until) {
          /* the wasm module owns the thread while it works */
        }
      }
      for (const ev of this.eventsPerDispatch(request)) this.publish(ev);
      return this.reply(request);
    } finally {
      this.inDispatch = false;
    }
  }

  /** Emit an event frame the way `Module.__kiapiEvent` would. */
  publish(bytes: Uint8Array): void {
    for (const cb of Array.from(this.listeners)) cb(bytes);
  }

  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  get eventListeners(): number {
    return this.listeners.size;
  }

  shutdown(): void {
    this.shutdowns++;
    this.listeners.clear();
  }
}
