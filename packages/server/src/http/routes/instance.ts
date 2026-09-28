/**
 * Instance-identity route: `GET /api/instance -> { rootId, pid, port, startedAt }`.
 *
 * PUBLIC and unauthenticated, and that is forced by what it is for. The caller is a process
 * that has not yet decided whether this server is one it may talk to; asking it for a
 * credential first would defeat the purpose, since the whole question is whether the
 * credential is safe to hand over. The answer carries no secret — a path fingerprint, a
 * pid and a port, of which the pid and port are already written in plaintext to
 * `server.lock` in the data root (see instance-identity.ts for why the root is a digest
 * rather than a path).
 *
 * RUNTIME-OWNED, which is the opposite of `installRoutes` and deliberate. A hot push
 * carries platform + cli + web dist as one version and never the runtime, so a
 * platform-mounted route can be replaced or withdrawn by a push — and discovery cannot
 * depend on a route that an update is allowed to take away, because the process asking is
 * by definition one that may predate the update. Mounted above the platform seam in
 * createRuntimeApp for that reason: this route has to be true for every build that can hold
 * a data root, which is what makes an upgrade overlap safe on the attaching side.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import { localInstanceIdentity } from "../../instance-identity.js";

/** What `GET /api/instance` returns. */
export type InstanceResponse = ReturnType<typeof localInstanceIdentity>;

export function instanceRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    // deps.config.port is mutated by index.ts to the ACTUAL bound port once the listener is
    // up, so this reads the real one rather than the requested 0.
    return c.json(
      localInstanceIdentity(deps.config.root, deps.config.port, deps.config.startedAt ?? ""),
    );
  });

  return app;
}
