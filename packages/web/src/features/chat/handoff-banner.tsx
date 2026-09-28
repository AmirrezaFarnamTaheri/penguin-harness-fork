/**
 * Provenance banners for conversations opened from another conversation — each collapses a
 * machine-inserted source block (the raw text is never shown; the model still sees it):
 * - `HandoffBanner` (`[handoff_from]`, the /agent handoff): "Handed off from <agent>'s chat";
 * - `ModelSwitchBanner` (`[model_switch_from]`, the /model command): "switched model —
 *   continued from the earlier conversation".
 * When there's a source Session, the whole line is clickable and jumps back to it (the
 * source Session's title goes into the title hover tooltip, taking no space in the body).
 */
import { useNavigate } from "react-router";
import { S } from "../../lib/strings";
import { STREAM_BANNER_FRAME } from "./disclosure-row";
import type { HandoffOrigin, ModelSwitchOrigin } from "./agent-handoff";

/**
 * Display name of the source agent: `displayName (id)` when the display name differs from the
 * id, otherwise just the id. No `@` sigil — the mention trigger it stood for is gone (`/agent`
 * replaced it), and the composer's own handoff chip spells the agent out without one, so the
 * banner would otherwise name the same agent differently from the control that started it.
 */
function agentLabel(origin: HandoffOrigin): string {
  return origin.agentName && origin.agentName !== origin.agentId
    ? `${origin.agentName} (${origin.agentId})`
    : origin.agentId;
}

/** This banner's own placement on top of the shared notice chrome: an in-transcript line, so
 *  it enters with `anim-msg` and hugs its content. */
const BANNER_FRAME = `anim-msg my-2 flex w-fit ${STREAM_BANNER_FRAME}`;

export function HandoffBanner({ origin }: { origin: HandoffOrigin }) {
  const navigate = useNavigate();
  const text = S.chat.handoffFrom(agentLabel(origin));
  // A handoff initiated from draft state has no source Session: only the origin is shown, with nowhere to jump to.
  if (!origin.sessionId) return <p className={BANNER_FRAME}>{text}</p>;
  const sessionId = origin.sessionId;
  return (
    <button
      type="button"
      title={S.chat.handoffBack(origin.sessionTitle)}
      onClick={() => navigate(`/chat/${sessionId}`)}
      className={`${BANNER_FRAME} transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200`}
    >
      {text}
      <span aria-hidden className="text-gray-400 dark:text-gray-500">
        →
      </span>
    </button>
  );
}

/**
 * Notice for a conversation opened by the `/model` switch (`[model_switch_from]` first
 * message): a single line naming the previous model, clickable to jump back to the source
 * session — the same interaction as the handoff banner's back-link.
 */
export function ModelSwitchBanner({ origin }: { origin: ModelSwitchOrigin }) {
  const navigate = useNavigate();
  const sessionId = origin.sessionId;
  return (
    <button
      type="button"
      title={S.chat.handoffBack(origin.sessionTitle)}
      onClick={() => navigate(`/chat/${sessionId}`)}
      className={`${BANNER_FRAME} transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200`}
    >
      {S.chat.modelSwitchFrom(origin.prevModelId)}
      <span aria-hidden className="text-gray-400 dark:text-gray-500">
        →
      </span>
    </button>
  );
}
