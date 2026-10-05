/**
 * PRR-02 acceptance — credential masking for incomplete JSON trace tails.
 *
 * The 2026-10-04 review (F2) proved that a JSONL tail cut inside a credential value escaped the
 * text rules: the generic assignment rule's quoted-value alternatives require a closing quote, and
 * its unquoted alternative excludes a leading one, so `{"apiKey":"opaque-example-secret` matched
 * nothing and the secret survived into `TraceService.readFileRaw` — the function behind both the
 * trace read endpoint and the download attachment.
 *
 * Every case here is written as a *sentinel* assertion: the sentinel is chosen so that no vendor
 * token pattern (sk-, ghp_, AKIA, xox, glpat-, Bearer …) could ever catch it. A test that passed
 * because some unrelated rule fired would not prove the repair, so each case additionally asserts
 * that removing the sensitive field name leaves the sentinel *in place* — that is the control
 * which makes the field-name rule, and not a value-format rule, the thing under test.
 *
 * `redactTraceContent` is the single shared implementation behind the read and download paths
 * (packages/server/src/services/trace-service.ts), so exercising it here accepts both consumers.
 */
import { describe, expect, it } from "vitest";
import {
  REDACTED_MARKER,
  redactCredentials,
  redactTraceContent,
} from "../src/internal/credential-redactor.js";

/** Opaque, deliberately vendor-neutral, and long enough to be a credible credential. */
const SENTINEL = "t7q-opaque-tail-sentinel-value";
/** Short enough to miss the generic rule's `{8,}` bound, so only the field-name rule can catch it. */
const SHORT_SENTINEL = "q4w9";

/** The same secret under an ordinary field name, which no sensitive-key policy should censor. */
const control = (line: string): string => line;

/** Asserts the secret is gone and that the redacted form is still marked. */
function masked(input: string): string {
  const output = redactTraceContent(input);
  expect(output).not.toContain(SENTINEL);
  expect(output).not.toContain(SHORT_SENTINEL);
  return output;
}

describe("PRR-02 incomplete JSON tail masking", () => {
  it("masks a quoted credential value cut at EOF", () => {
    const torn = `{"apiKey":"${SENTINEL}`;
    // Control: the same secret under an ordinary field name is NOT masked, so this case can only
    // pass because the field name is recognized as sensitive.
    expect(redactTraceContent(control(`{"note":"${SENTINEL}`))).toContain(SENTINEL);

    const output = masked(torn);
    expect(output).toContain(`"apiKey":"${REDACTED_MARKER}"`);
    expect(output.startsWith('{"apiKey":"')).toBe(true);
  });

  it("masks a short opaque value that no vendor token pattern matches", () => {
    // The generic rule needs 8+ characters, so this length proves the field-name rule fired.
    expect(SHORT_SENTINEL.length).toBeLessThan(8);
    const output = masked(`{"token":"${SHORT_SENTINEL}`);
    expect(output).toContain(`"token":"${REDACTED_MARKER}"`);
  });

  it("masks a value whose tail ends on a trailing escape character", () => {
    // The torn byte is the backslash of an escape sequence, not the secret itself; a rule that
    // needs a complete escape pair leaves this prefix exposed.
    const output = masked(`{"password":"${SENTINEL}\\`);
    expect(output).toContain(`"password":"${REDACTED_MARKER}"`);
  });

  it("masks a value cut immediately after the field separator's opening quote", () => {
    const output = masked(`{"clientSecret":"${SENTINEL}"`);
    expect(output).toContain(`"clientSecret":"${REDACTED_MARKER}"`);
  });

  it("leaves a tail cut at the field separator itself intact and safe", () => {
    // Nothing was written after the separator, so there is nothing to mask — but the line must
    // still survive the fallback rather than being dropped or corrupted.
    const torn = '{"apiKey":';
    expect(redactTraceContent(torn)).toBe(torn);
  });

  it("recognizes an escaped field name through the shared sensitive-key policy", () => {
    // `\u004b` is `K`: the decoded field name is apiKey, so the shared policy — not the literal
    // text — decides. The control proves the escaping is what is decoded.
    expect(redactTraceContent(control(`{"note":"${SENTINEL}`))).toContain(SENTINEL);

    const output = masked(`{"api\\u004bey":"${SENTINEL}`);
    expect(output).toContain(`"api\\u004bey":"${REDACTED_MARKER}"`);
  });

  it("masks nested and non-ASCII-escaped credential fields", () => {
    const output = masked(`{"request":{"headers":{"x-api-key":"${SENTINEL}"},"n":1}`);
    expect(output).toContain(`"x-api-key":"${REDACTED_MARKER}"`);
    // Ordinary siblings survive so the record still reads as structured content.
    expect(output).toContain(`"n":1`);
  });

  it("keeps ordinary fields and complete records byte-identical", () => {
    const line = '{"event":"tool_result","name":"readFile","duration_ms":42,"note":"plain text"}';
    expect(redactTraceContent(line)).toBe(line);
    const multi = [line, '{"event":"done","ok":true}'].join("\n");
    expect(redactTraceContent(multi)).toBe(multi);
  });

  it("preserves a complete credential record's structure while masking only the secret", () => {
    // A complete line parses, so the structured path runs: the record stays valid JSONL.
    const output = redactTraceContent(`{"apiKey":"${SENTINEL}","model":"claude","n":2}`);
    expect(output).not.toContain(SENTINEL);
    expect(JSON.parse(output)).toEqual({
      apiKey: REDACTED_MARKER,
      model: "claude",
      n: 2,
    });
  });

  it("masks several credentials across one torn line", () => {
    const output = masked(`{"user":"bob","token":"${SENTINEL}","refreshToken":"${SHORT_SENTINEL}`);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(SHORT_SENTINEL);
    expect(output).toContain(`"user":"bob"`);
  });

  it("does not expose raw fallback bytes for other credential shapes in a torn line", () => {
    // The fallback must still run the text rules: a torn line carrying a Bearer token is masked
    // even though the JSON parse failed.
    const torn = `{"note":"calling with Bearer ${SENTINEL}`;
    expect(redactTraceContent(torn)).not.toContain(SENTINEL);
  });

  it("applies the same rule through redactCredentials, the rule-level entry point", () => {
    expect(redactCredentials(`{"apiKey":"${SENTINEL}`)).toBe(`{"apiKey":"${REDACTED_MARKER}"`);
  });

  it("masks a torn tail on the last line of a multi-record file", () => {
    const content = ['{"event":"session_start","session_id":"s1"}', `{"apiKey":"${SENTINEL}`].join(
      "\n",
    );
    const output = redactTraceContent(content);
    expect(output.split("\n")[0]).toBe('{"event":"session_start","session_id":"s1"}');
    expect(output).not.toContain(SENTINEL);
  });
});
