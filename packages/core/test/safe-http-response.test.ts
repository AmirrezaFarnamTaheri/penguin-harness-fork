import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { safeFetch } from "../src/internal/safe-http.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

it.each([true, false])(
  "rejects oversized responses without an unhandled stream error (length header: %s)",
  async (declareLength) => {
    const server = createServer((_request, response) => {
      if (declareLength) response.setHeader("Content-Length", "17");
      response.end("12345678901234567");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    await expect(
      safeFetch(`http://127.0.0.1:${address.port}/`, undefined, {
        allowLocalhost: true,
        maxBytes: 16,
      }),
    ).rejects.toThrow(/(?:exceeds limit|exceeded maximum limit)/);
  },
);
