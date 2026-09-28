/**
 * A stand-in for "a server process is listening on some port", used by the instance-identity
 * tests. Plain .mjs on purpose: it has to be runnable by bare `node` in a child process, so
 * it cannot import the TypeScript lock module — it reproduces only the two things a real
 * server does that the tests care about, namely answering /api/instance and publishing
 * `server.lock`. Everything it publishes about itself comes from the environment, which is
 * how one fixture can play the part of our own server, a different root's server, and a
 * build that predates the route.
 *
 * CHILD_ROOT_ID  the rootId to answer with (what a real server computes for the root it
 *                claimed; a different value makes this peer a stranger's server)
 * CHILD_LOCK     path to publish server.lock to; when unset the peer answers but publishes
 *                nothing, which is the "listening but undiscoverable" case
 * CHILD_ROUTE    "yes" (default) to serve /api/instance, "no" to 404 everything, which is
 *                how a build predating the route behaves
 */
import http from "node:http";
import fs from "node:fs";

const route = process.env.CHILD_ROUTE ?? "yes";
const lockPath = process.env.CHILD_LOCK;

const server = http.createServer((req, res) => {
  if (route === "yes" && req.url === "/api/instance") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        rootId: process.env.CHILD_ROOT_ID ?? "",
        pid: process.pid,
        port: server.address().port,
        startedAt: new Date().toISOString(),
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  if (lockPath !== undefined) {
    // The same tmp + rename the real publisher uses, so a reader never sees a partial write.
    const tmp = `${lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }) + "\n",
    );
    fs.renameSync(tmp, lockPath);
  }
  // Tells the parent the port is bound and the record is out, so it can stop polling.
  process.stdout.write(`${port}\n`);
});

// Keep the event loop alive without a listener on stdin, which a piped child never gets.
process.stdin.resume();
