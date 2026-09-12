/**
 * Agent Client Protocol (ACP) JSON-RPC 2.0 Protocol Engine.
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
  error?: { code: number; message: string; data?: unknown };
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
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private lineBuffer = "";
  private disposed = false;
  private transportError: Error | null = null;

  constructor(
    private readonly sendRawLine: (line: string) => void | Promise<void>,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private failTransport(error: unknown): Error {
    const normalized = this.normalizeError(error);
    if (!this.transportError) this.transportError = normalized;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(normalized);
    }
    this.pending.clear();
    return normalized;
  }

  private async writeLine(message: JsonRpcMessage): Promise<void> {
    if (this.disposed) throw new Error("ACP connection disposed");
    if (this.transportError) throw this.transportError;
    try {
      await this.sendRawLine(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw this.failTransport(error);
    }
  }

  public onRequest<P = unknown, R = unknown>(
    method: string,
    handler: (params: P) => Promise<R> | R,
  ): void {
    this.requestHandlers.set(method, handler as (params: unknown) => Promise<unknown>);
  }

  public onNotification<P = unknown>(method: string, handler: (params: P) => void): void {
    this.notificationHandlers.set(method, handler as (params: unknown) => void);
  }

  public async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) throw new Error("ACP connection disposed");
    if (this.transportError) throw this.transportError;

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `ACP request '${method}' with id ${id} timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      void this.writeLine(req).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.normalizeError(error));
      });
    });
  }

  public sendNotification(method: string, params?: unknown): void {
    const notif: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    void this.writeLine(notif).catch(() => {
      // writeLine already records the transport failure and rejects pending requests.
    });
  }

  public async handleChunk(chunk: string): Promise<void> {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    const requestTasks: Promise<void>[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        // Request handlers are allowed to issue their own outbound requests. Do not await them
        // before dispatching later frames in the same transport chunk, or a response already in
        // this chunk can be starved behind the handler that is waiting for it.
        if ("id" in msg && "method" in msg) {
          requestTasks.push(this.handleMessage(msg));
        } else {
          await this.handleMessage(msg);
        }
      } catch (error) {
        if (this.transportError) throw this.transportError;
        if (!(error instanceof SyntaxError)) throw error;
      }
    }

    if (requestTasks.length > 0) {
      await Promise.all(requestTasks);
    }
  }

  public async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (this.disposed) throw new Error("ACP connection disposed");

    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`ACP Error ${msg.error.code}: ${msg.error.message}`));
        else entry.resolve(msg.result);
      }
      return;
    }

    if ("id" in msg && "method" in msg) {
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        await this.writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method '${msg.method}' not found` },
        });
        return;
      }

      let response: JsonRpcResponse<unknown>;
      try {
        const result = await handler(msg.params);
        // JSON.stringify omits undefined object properties. JSON-RPC success responses must carry
        // a result member, so normalize a void handler to the protocol-safe null result.
        response = { jsonrpc: "2.0", id: msg.id, result: result ?? null };
      } catch (error) {
        const normalized = this.normalizeError(error);
        response = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: normalized.message || "Internal error" },
        };
      }
      await this.writeLine(response);
      return;
    }

    if ("method" in msg) {
      const notifHandler = this.notificationHandlers.get(msg.method);
      if (notifHandler) notifHandler(msg.params);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("ACP connection disposed");
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.requestHandlers.clear();
    this.notificationHandlers.clear();
    this.lineBuffer = "";
  }
}
