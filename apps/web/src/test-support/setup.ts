import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * jsdom has no WebSocket. The shell starts the realtime client in an effect;
 * a no-op stand-in keeps layout tests focused on rendering. realtime.test.ts
 * injects its own factory for behavioral coverage. OPEN/CONNECTING constants
 * mirror the DOM interface constants the client reads.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(): void {
    // no-op: stand-in transport for layout-level tests
  }

  addEventListener(): void {
    // no-op
  }

  removeEventListener(): void {
    // no-op
  }
}

beforeEach(() => {
  // Re-applied per test: afterEach's unstubAllGlobals clears it for the next.
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});
