/**
 * `penguin recall` — read archived tool output by the recall id a tool result published.
 *
 *   penguin recall <recallId> [sessionId] [--offset <n>] [--pages <n>] [--json] [--server <url>]
 *
 * When a tool's output is too large to keep inline, the result note carries an opaque recall id.
 * The model can page it back with `recall_output`; this command is the same handle for a human, so
 * output that was compressed away is not lost to the person reading the session.
 *
 * Pages are written to stdout AS THEY ARRIVE — the stored text can be megabytes, so nothing here
 * accumulates it (F18.2) — and `--pages` bounds how far one invocation reads when a caller wants
 * only a prefix (`--offset` then continues where it stopped). `--json` emits one object per page
 * (NDJSON) rather than a single object holding the whole text, for the same streaming reason.
 *
 * The id is validated locally to the same 12/32-hex shape the server enforces, so a typo — or a
 * path someone pasted in its place — fails without a request and can never become a file read on
 * any layer (F18.3). The session id is optional and resolves exactly like `penguin logs`: omitted,
 * it is the agent's most recent session.
 *
 * Docs: /docs/cli § "penguin recall".
 */
import type { Command } from "commander";
import type { RecallPageResponse } from "@prismshadow/penguin-server/api";
import {
  ApiError,
  resolveAgentId,
  resolveConnection,
  resolveProjectId,
  ServerClient,
  shortSessionId,
} from "../client.js";
import { resolveSessionTarget } from "../server-session.js";
import type { Messages } from "../i18n.js";

/** The id shape the server route enforces: 12 or 32 lowercase hex characters, and nothing else. */
const RECALL_ID_SHAPE = /^(?:[a-f0-9]{12}|[a-f0-9]{32})$/;

export function registerRecallCommand(program: Command, t: Messages): void {
  program
    .command("recall <recallId> [sessionId]")
    .description(t.recall.desc)
    .option("--offset <n>", t.recall.offset)
    .option("--pages <n>", t.recall.pages)
    .option("--project-id <id>", t.common.projectId)
    .option("--agent-id <id>", t.common.latestAgentId)
    .option("--json", t.common.json)
    .option("--server <url>", t.common.server)
    .action(async (recallIdArg: string, sessionRef: string | undefined, opts) => {
      const recallId = String(recallIdArg).trim().toLowerCase();
      if (!RECALL_ID_SHAPE.test(recallId)) {
        process.stderr.write(`${t.error(t.recall.invalidId(String(recallIdArg)))}\n`);
        process.exitCode = 1;
        return;
      }
      let offset = 0;
      if (opts.offset !== undefined) {
        offset = Number(opts.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          process.stderr.write(`${t.error(t.recall.offsetInvalid(String(opts.offset)))}\n`);
          process.exitCode = 1;
          return;
        }
      }
      let maxPages = Number.POSITIVE_INFINITY;
      if (opts.pages !== undefined) {
        maxPages = Number(opts.pages);
        if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
          process.stderr.write(`${t.error(t.recall.pagesInvalid(String(opts.pages)))}\n`);
          process.exitCode = 1;
          return;
        }
      }

      const projectId = resolveProjectId(opts.projectId);
      const agentId = resolveAgentId(opts.agentId);
      let sessionId = "";
      try {
        const client = new ServerClient(await resolveConnection({ server: opts.server }, t), t);
        const target = await resolveSessionTarget(
          client,
          { ref: sessionRef, projectId, agentId },
          t,
        );
        if (target === null) return; // the resolver already reported why and set the exit code
        sessionId = target;

        let pages = 0;
        for (;;) {
          const page = await client.requestJson<RecallPageResponse>(
            "GET",
            `/api/sessions/${encodeURIComponent(sessionId)}/recall/${recallId}?offset=${offset}`,
          );
          if (opts.json) process.stdout.write(`${JSON.stringify(page)}\n`);
          else process.stdout.write(page.page);
          pages += 1;
          if (page.nextOffset === null) break;
          if (pages >= maxPages) {
            // Stopping early is a soft yield, like `logs -f --timeout`: what was read is real, and
            // the note carries the offset that continues it, so nothing is silently truncated.
            process.stderr.write(`\n${t.recall.moreRemaining(page.nextOffset)}\n`);
            break;
          }
          offset = page.nextOffset;
        }
      } catch (err) {
        const message = recallFailureMessage(err, { recallId, sessionId, t });
        if (message !== null) {
          process.stderr.write(`${t.error(message)}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}

/**
 * The one place a recall failure becomes a sentence. Each code says what actually happened — a
 * bad id, an entry that aged out of a bounded store, an id this Session never held, a position
 * outside the text — because "unavailable" for all four would leave a reader unable to tell a
 * typo from an expiry, and the fix differs in each case. Unknown failures are not translated
 * here; they keep their own error and message.
 */
export function recallFailureMessage(
  err: unknown,
  ctx: { recallId: string; sessionId: string; t: Messages },
): string | null {
  if (!(err instanceof ApiError)) return null;
  const { t } = ctx;
  switch (err.code) {
    case "recall_id_invalid":
      return t.recall.invalidId(ctx.recallId);
    case "recall_expired":
      return t.recall.expired();
    case "recall_unavailable":
      return t.recall.unavailableIn(shortSessionId(ctx.sessionId));
    case "recall_offset_invalid":
    case "recall_offset_out_of_range":
      return t.recall.offsetRejected(err.message);
    default:
      // Everything else (an unreachable server, a session deleted mid-read) keeps its own error
      // and message: translating a code this command does not own would only obscure it.
      return null;
  }
}
