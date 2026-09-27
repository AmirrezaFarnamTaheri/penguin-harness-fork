/**
 * Provider-failure bucketing, shared by every advisory surface.
 *
 * This lives in its own module because two surfaces now map provider errors to diagnostic
 * words, and two copies of that mapping is two places to forget to update. It was extracted
 * from advisor.ts unchanged in behaviour: the words it returns are the closed vocabulary
 * that `activity.bucketReason` parses, and the `provider_http_<status>` shape it produces for
 * HTTP failures is what that parser splits the status out of.
 *
 * The rule the mapping exists to enforce: a diagnostic word is drawn from a fixed set, or is
 * a status code. A provider's own error text never becomes the word. That is what keeps an
 * error body from reaching an operator's log or a reader's screen through a metric.
 */

/** Maps a thrown provider error to a diagnostic word from a closed set. */
export function safeDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "JevCircuitOpenError") return "circuit_open";
    if (error.name === "JevProtocolError" || error.name === "SurfaceProtocolError") {
      return "invalid_response";
    }
    if (error.name === "APIUserAbortError") return "cancelled";
    if (error.name === "APITimeoutError") return "timeout";
    if (error.name === "APIConnectionError") return "connection_error";
  }
  const status =
    error !== null && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    return `provider_http_${status}`;
  }
  return "provider_error";
}
