/**
 * Agent Client Protocol (ACP) JSON-RPC 2.0 Protocol Engine
 * Derived from claurst (src-rust/crates/acp/src/connection.rs)
 * and cocode-host-supervisor (host-jsonrpc-plugin).
 */

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly requestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown> | unknown
  >();
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();
  private lineBuffer = "";

  constructor(
    private readonly sendRawLine: (line: string) => void | Promise<void>,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  public onRequest<P = unknown, R = unknown>(
    method: string,
    handler: (params: P) => Promise<R> | R,
  ): void {
    this.requestHandlers.set(method, handler as (params: unknown) => Promise<unknown>);
  }

  public onNotification<P = unknown>(
    method: string,
    handler: (params: P) => void,
  ): void {
    this.notificationHandlers.set(method, handler as (params: unknown) => void);
  }

  public async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request '${method}' with id ${id} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      void this.sendRawLine(JSON.stringify(req) + "\n");
    });
  }

  public sendNotification(method: string, params?: unknown): void {
    const notif: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    void this.sendRawLine(JSON.stringify(notif) + "\n");
  }

  public async handleChunk(chunk: string): Promise<void> {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        await this.handleMessage(msg);
      } catch {
        // Drop malformed frame
      }
    }
  }

  public async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      // Inbound Response
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`ACP Error ${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    if ("id" in msg && "method" in msg) {
      // Inbound Request
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        const errorResp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: `Method '${msg.method}' not found`,
          },
        };
        void this.sendRawLine(JSON.stringify(errorResp) + "\n");
        return;
      }

      try {
        const result = await handler(msg.params);
        const successResp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          result,
        };
        void this.sendRawLine(JSON.stringify(successResp) + "\n");
      } catch (err: any) {
        const failureResp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32603,
            message: err?.message ?? "Internal error",
          },
        };
        void this.sendRawLine(JSON.stringify(failureResp) + "\n");
      }
      return;
    }

    if ("method" in msg) {
      // Inbound Notification
      const notifHandler = this.notificationHandlers.get(msg.method);
      if (notifHandler) {
        notifHandler(msg.params);
      }
    }
  }

  public dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("ACP connection disposed"));
    }
    this.pending.clear();
    this.requestHandlers.clear();
    this.notificationHandlers.clear();
    this.lineBuffer = "";
  }
}
