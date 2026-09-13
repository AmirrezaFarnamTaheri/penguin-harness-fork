import { expect, it } from "vitest";
import { requestBegin, requestEnd, tokenUsage, userText } from "@prismshadow/penguin-core";
import {
  deserializePrefix,
  initialScanState,
  scanMessages,
  serializePrefix,
} from "../src/services/message-window.js";

it("carries failed consumption across cached shards without inflating committed context", async () => {
  const state = initialScanState();
  const counts = (total: number) => ({ cache_read: 0, cache_write: total, output: 0, total });
  await scanMessages(
    state,
    [
      userText("first"),
      requestBegin(),
      requestEnd("retryable", { usage: counts(25) }),
      requestBegin(),
      tokenUsage(counts(100), counts(100)),
      requestEnd("completed"),
    ],
    () => {},
    null,
  );
  expect(state.totals.sessionTokens).toBe(125);
  expect(state.totals.contextTokens).toBe(100);
  const restored = deserializePrefix(serializePrefix(state))!;
  expect(restored.totals.failedSessionTokens).toBe(25);
  await scanMessages(
    restored,
    [
      userText("second"),
      requestBegin(),
      tokenUsage(counts(300), counts(200)),
      requestEnd("completed"),
    ],
    () => {},
    null,
  );
  expect(restored.totals.sessionTokens).toBe(325);
  expect(restored.totals.contextTokens).toBe(200);
});
