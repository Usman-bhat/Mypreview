import { EventEmitter } from "node:events";

import WebSocket from "ws";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface CdpIncomingMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export class CdpClient extends EventEmitter {
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private socket: WebSocket | undefined;
  private nextId = 1;

  public constructor(private readonly websocketUrl: string) {
    super();
  }

  public async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.websocketUrl);
      this.socket = socket;

      socket.once("open", () => {
        resolve();
      });

      socket.once("error", (error) => {
        reject(error);
      });

      socket.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      socket.on("close", () => {
        this.emit("close");
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error(`CDP connection closed while waiting for ${pending.method}.`));
        }
        this.pendingRequests.clear();
      });
    });
  }

  public async close(): Promise<void> {
    if (!this.socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket) {
        resolve();
        return;
      }

      this.socket = undefined;

      socket.once("close", () => resolve());
      socket.close();
    });
  }

  public send<TResponse>(method: string, params?: Record<string, unknown>): Promise<TResponse> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open for ${method}.`));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
    });

    return new Promise<TResponse>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as TResponse),
        reject,
        method,
      });

      this.socket?.send(payload, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleMessage(rawMessage: string): void {
    const message = JSON.parse(rawMessage) as CdpIncomingMessage;

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.emit(message.method, message.params);
    }
  }
}
