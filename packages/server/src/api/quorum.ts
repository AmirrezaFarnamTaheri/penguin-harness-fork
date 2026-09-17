import { Hono } from "hono";
import type { Context } from "hono";
import type { AppDeps } from "../app.js";
import type { AppEnv } from "../auth/middleware.js";
import { getOrCreateProjectRuntime } from "../cockpit/ws.js";
import {
  badRequest,
  optionalBoolean,
  optionalNumber,
  optionalString,
  readJson,
  requireString,
  requireValidId,
} from "../http/validate.js";

/** Project members share the cockpit's in-memory consensus, including its idle lifetime. */
export function quorumRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  function authorize(c: Context<AppEnv>): string {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return projectId;
  }

  async function consensus(projectId: string) {
    // The sync getSharedSwarmCoordinator uses a bare projectId key. Match cockpit HTTP/WS's
    // root + projectId key instead, or these proposals would live in a second coordinator.
    const runtime = await getOrCreateProjectRuntime(projectId, {
      root: deps.config.root,
      authService: deps.authService,
      projectService: deps.projectService,
      projectConfigService: deps.projectConfigService,
    });
    return runtime.coordinator.consensus;
  }

  app.get("/standings", async (c) => {
    const engine = await consensus(authorize(c));
    return c.json(engine.listStandings());
  });

  app.post("/propose", async (c) => {
    const projectId = authorize(c);
    const body = await readJson(c);
    const topic = requireString(body, "topic").trim();
    const proposerId = requireString(body, "proposerId").trim();
    if (!topic || !proposerId) throw badRequest("topic and proposerId must not be empty.");
    const initialGrounds = optionalString(body, "initialGrounds");
    const rawPolicy = body.policy;
    if (
      rawPolicy !== undefined &&
      (rawPolicy === null || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))
    ) {
      throw badRequest("policy must be a JSON object.");
    }
    const policy = (rawPolicy ?? {}) as Record<string, unknown>;
    const threshold = optionalNumber(policy, "threshold", { integer: true });
    const refutationCap = optionalNumber(policy, "refutationCap", { integer: true });
    const requireGrounded = optionalBoolean(policy, "requireGrounded");
    if (threshold !== undefined && threshold < 1) {
      throw badRequest("threshold must be a positive integer.");
    }
    if (refutationCap !== undefined && refutationCap < 1) {
      throw badRequest("refutationCap must be a positive integer.");
    }
    const engine = await consensus(projectId);
    return c.json(
      engine.proposeTopic({
        topic,
        proposerId,
        initialGrounds,
        policy: { threshold, requireGrounded, refutationCap },
      }),
      201,
    );
  });

  return app;
}
