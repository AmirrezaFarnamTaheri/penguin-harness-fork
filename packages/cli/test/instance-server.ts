import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** Starts a minimal peer that satisfies the server's root-bound identity probe. */
export async function startIdentityServer(
  root: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const rootId = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 16);
  const startedAt = new Date().toISOString();
  let port = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== "/api/instance") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ rootId, pid: process.pid, port, startedAt }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });

  let closePromise: Promise<void> | undefined;
  return {
    port,
    close: () => {
      closePromise ??= new Promise((resolve) => server.close(() => resolve()));
      return closePromise;
    },
  };
}
