/**
 * The microVM isolated tier: the server-side half of the sandbox subsystem's
 * tiered execution model.
 *
 * Core decides *whether* a script escalates (`decideTier` in
 * @prismshadow/penguin-core); this directory decides *how*: the wire protocol that
 * talks to a hardware-isolated microVM plane, and the escalation runtime that
 * presents it as the `IsolatedBackend` core's runtime calls.
 *
 * The two modules split along the same seam as the donor remote-sandbox SDK did —
 * a stateless client that owns the protocol (timeouts, replay, error taxonomy) and
 * a stateful layer that owns the sandbox lifecycle (boot, reuse within a session,
 * release, telemetry). Neither half is reachable from the sandbox service's plugin
 * contract; both are internal to this server.
 */
export * from "./microvm-sandbox-client.js";
export * from "./microvm-escalation-runtime.js";
