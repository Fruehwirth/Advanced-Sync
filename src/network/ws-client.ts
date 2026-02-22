/**
 * WebSocket client with auto-reconnect and message queue.
 *
 * Uses the Node.js `ws` package via Electron's require() instead of the
 * browser window.WebSocket. This bypasses Electron's browser proxy layer
 * which mangles plain ws:// frames on certain network setups (e.g. Docker/WSL2
 * virtual interfaces). It also supports rejectUnauthorized:false for
 * self-signed certs when using wss://.
 */

import type { ProtocolMessage } from "@vault-sync/shared/protocol";

export type MessageHandler = (msg: ProtocolMessage) => void;
export type BinaryHandler = (data: ArrayBuffer) => void;
export type StateChangeHandler = (state: "open" | "closed" | "error") => void;

/** Minimal interface covering both browser WebSocket and ws.WebSocket. */
interface AnyWebSocket {
  readyState: number;
  send(data: string | ArrayBuffer | Buffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  binaryType?: string;
}

const WS_OPEN = 1;

/** Try to get the Node.js ws package (available in Electron). */
function createNodeWebSocket(url: string): AnyWebSocket | null {
  try {
    const WS = require("ws");
    const ws = new WS(url, {
      perMessageDeflate: false,
      rejectUnauthorized: false, // accept self-signed certs for wss://
    });
    // ws emits events rather than using .on* properties, bridge them
    const shim: AnyWebSocket = {
      readyState: WS.CONNECTING,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send(data: string | ArrayBuffer | Buffer) {
        ws.send(data);
      },
      close(code?: number, reason?: string) {
        ws.close(code, reason);
      },
    };
    ws.on("open", () => {
      shim.readyState = WS.OPEN;
      shim.onopen?.();
    });
    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (shim.onmessage) {
        if (isBinary || Buffer.isBuffer(data)) {
          // Convert Buffer → ArrayBuffer
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          shim.onmessage({ data: ab });
        } else {
          shim.onmessage({ data: data.toString() });
        }
      }
    });
    ws.on("close", (code: number) => {
      shim.readyState = WS.CLOSED;
      shim.onclose?.({ code });
    });
    ws.on("error", (err: Error) => {
      console.error("[WsClient] Node ws error:", err.message);
      shim.onerror?.({ message: err.message });
    });
    return shim;
  } catch {
    return null;
  }
}

/** Fall back to browser window.WebSocket (mobile / non-Electron). */
function createBrowserWebSocket(url: string): AnyWebSocket | null {
  try {
    const ws = new window.WebSocket(url) as any;
    ws.binaryType = "arraybuffer";
    return ws as AnyWebSocket;
  } catch {
    return null;
  }
}

export class WsClient {
  private ws: AnyWebSocket | null = null;
  private url: string = "";
  private messageHandler: MessageHandler;
  private binaryHandler: BinaryHandler;
  private stateHandler: StateChangeHandler;
  private messageQueue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  private shouldReconnect = false;
  private _isConnected = false;

  constructor(
    messageHandler: MessageHandler,
    binaryHandler: BinaryHandler,
    stateHandler: StateChangeHandler
  ) {
    this.messageHandler = messageHandler;
    this.binaryHandler = binaryHandler;
    this.stateHandler = stateHandler;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(url: string): void {
    this.url = url;
    this.shouldReconnect = true;
    this.backoffMs = 1000;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this._isConnected = false;
    this.stateHandler("closed");
  }

  /** Send a JSON message. Queues if not connected. */
  send(msg: ProtocolMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(data);
    } else {
      this.messageQueue.push(data);
    }
  }

  /** Send raw binary data (for file uploads). */
  sendBinary(data: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(data);
    }
  }

  private doConnect(): void {
    this.cleanup();

    // Prefer Node.js ws (bypasses browser proxy/frame mangling in Electron)
    this.ws = createNodeWebSocket(this.url) ?? createBrowserWebSocket(this.url);

    if (!this.ws) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._isConnected = true;
      this.backoffMs = 1000;
      this.stateHandler("open");

      // Flush queued messages
      while (this.messageQueue.length > 0) {
        const data = this.messageQueue.shift()!;
        this.ws?.send(data);
      }

      // Application-level keepalive ping every 30s
      this.pingInterval = setInterval(() => {
        this.send({ type: "PING" as any, timestamp: Date.now() });
      }, 30000);
    };

    this.ws.onmessage = (event: any) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.binaryHandler(data);
      } else if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          this.messageHandler(msg);
        } catch {
          // Ignore malformed messages
        }
      }
    };

    this.ws.onclose = () => {
      this._isConnected = false;
      this.cleanup();
      this.stateHandler("closed");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this._isConnected = false;
      this.stateHandler("error");
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.backoffMs);

    // Exponential backoff: 1s → 2s → 4s → 8s → max 30s
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
