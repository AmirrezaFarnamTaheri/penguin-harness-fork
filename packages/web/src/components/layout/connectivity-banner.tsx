/**
 * Posture banner (F17.2): the one place the app tells the user what it knows about reaching the
 * server. Three rules it exists to keep:
 *
 *   - It never shows while the app has no evidence of a problem (posture `online`/`checking`) —
 *     a transient failure is not a banner, it is one retry away from being nothing.
 *   - Its copy never promises that a message will be delivered later. The app does not queue
 *     sends, so "your message will be sent when the connection returns" would be a lie; what is
 *     true is that the already-loaded conversation stays readable.
 *   - The retry control is a real control: focusable, keyboard-operable, disabled with the reason
 *     when a retry is not available yet, and it disappears entirely once the posture is healthy.
 *
 * Read-only rendering: all state comes from the provider, so this component can be hidden
 * (rollback) without touching the cached-content path.
 */
import { S } from "../../lib/strings";
import { useConnectivity } from "../../state/connectivity";

export function ConnectivityBanner() {
  const { state, retry } = useConnectivity();
  if (state.banner === "none") return null;

  const tone =
    state.banner === "recovered" ? "ok" : state.banner === "reconnecting" ? "info" : "warn";
  const text =
    state.banner === "browser-offline"
      ? S.connectivity.browserOffline
      : state.banner === "server-unreachable"
        ? S.connectivity.serverUnreachable
        : state.banner === "reconnecting"
          ? // A link that just came back has not been verified yet; the message says exactly that.
            state.browserOnline
            ? S.connectivity.reconnecting
            : S.connectivity.browserOffline
          : S.connectivity.recovered;

  // `recovered` is a notice, not a state to act on; `browser-offline` cannot be fixed by probing.
  const showRetry = state.banner === "server-unreachable" || state.banner === "reconnecting";
  const retryBlockedReason =
    state.retry.allowed === true
      ? null
      : state.retry.reason === "in-flight"
        ? S.connectivity.retryInFlight
        : S.connectivity.retryRateLimited;

  return (
    <div
      role={tone === "warn" ? "alert" : "status"}
      aria-live={tone === "warn" ? "assertive" : "polite"}
      data-connectivity-posture={state.posture}
      data-connectivity-banner={state.banner}
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          : tone === "ok"
            ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            : "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
      }`}
    >
      <span className="min-w-0 flex-1">{text}</span>
      {/* Not shown for `recovered`: there is nothing left to recover from. */}
      {state.banner === "recovered" ? null : (
        <span className="text-[11px] opacity-80">{S.connectivity.cachedReadable}</span>
      )}
      {showRetry ? (
        <button
          type="button"
          onClick={() => retry()}
          disabled={!state.retry.allowed}
          title={retryBlockedReason ?? undefined}
          aria-label={S.connectivity.retry}
          className="rounded border border-current/30 px-2 py-0.5 font-medium transition-colors duration-150 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
        >
          {S.connectivity.retry}
        </button>
      ) : null}
    </div>
  );
}
