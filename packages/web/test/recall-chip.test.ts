/**
 * Recall chip: the affordance that turns an archived tool result back into readable text (F18).
 *
 * The web suite is node-only by design (vitest.config.ts: "tests pure logic only, no DOM tests").
 * What that leaves assertable here, and what this file therefore covers: the chip's closed state as
 * static markup (accessible name, size, aria-expanded/controls, no panel and no read until asked),
 * the card's decision function `recallAffordance` in full, and the wiring between the two (the
 * transcript's Session reaching the card; every decision going through the tested seam). The
 * interactive contract that needs a live DOM (open → page → load more, Escape, aria-live) is
 * asserted structurally against the component source, and the paging logic itself is covered
 * exhaustively in recall.test.ts.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecallChip } from "../src/features/chat/recall-chip";
import { recallAffordance } from "../src/features/chat/tool-call-card";
import { S } from "../src/lib/strings";

// The suite boots the Chinese dictionary (test/setup.ts), so copy is read from `S` rather than
// hardcoded here — an assertion on a literal would pass only in one language.
const LABEL = S.chat.recallChipLabel;

const ID = "3f9a1c8b2d4e6f70a1b2c3d4e5f60718";
const note = `[full output archived — {"recallId":"${ID}","sizeBytes":524288,"tokenCount":131072} call recall_output with recall_id "${ID}" and offset 0]`;

const chipSource = readFileSync(
  new URL("../src/features/chat/recall-chip.tsx", import.meta.url),
  "utf8",
);
const cardSource = readFileSync(
  new URL("../src/features/chat/tool-call-card.tsx", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../src/features/chat/chat-page.tsx", import.meta.url),
  "utf8",
);

function renderChip(props: {
  sessionId: string;
  recall: { recallId: string; sizeBytes: number | null; tokenCount: number | null };
}): string {
  return renderToStaticMarkup(createElement(RecallChip, props));
}

describe("F18 recall chip", () => {
  it("renders a closed button that names what it reveals", () => {
    const html = renderChip({
      sessionId: "session-1",
      recall: { recallId: ID, sizeBytes: 524288, tokenCount: null },
    });
    // Collapsed: a button, not a panel — nothing is read until the reader asks.
    expect(html).toContain(LABEL);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-controls="recall-panel-${ID}"`);
    // The size the note published is part of the accessible name, not decoration.
    expect(html).toContain(`${LABEL} (512KB)`);
    expect(html).toContain('type="button"');
    // The panel itself is absent while collapsed.
    expect(html).not.toContain('role="region"');
    expect(html).not.toContain("<pre");
  });

  it("omits the size when the note did not publish one", () => {
    const html = renderChip({
      sessionId: "session-1",
      recall: { recallId: ID, sizeBytes: null, tokenCount: null },
    });
    expect(html).toContain(`aria-label="${LABEL}"`);
    expect(html).not.toContain(`${LABEL} (`);
  });

  it("keeps the interactive contract in the component, and the read bounded", () => {
    // A labelled region with a polite live status: an announcement, not a silent change.
    expect(chipSource).toContain('role="region"');
    expect(chipSource).toContain('aria-live="polite"');
    // Escape closes and focus stays on the chip (the reader's place in the transcript).
    expect(chipSource).toContain('event.key === "Escape"');
    expect(chipSource).toContain("buttonRef.current?.focus()");
    // Bounded per open, and the loader never accumulates beyond what it displays.
    expect(chipSource).toMatch(/pageLimit: PAGES_PER_CLICK/);
    // The archive is read through the app's own client, and an archive refusal (an expired entry)
    // must not be treated as an expired session.
    expect(chipSource).toMatch(/apiFetch<RecallPage>\(url, \{ handleUnauthorized: false \}\)/);
    expect(chipSource).toContain("apiErrorText(err)");
    // The id shown is the published one, never a path or a constructed file name.
    expect(chipSource).not.toContain("Files.create");
  });

  it("offers the chip for a settled result whose note published an id", () => {
    const recall = recallAffordance(
      { output: `line one\n${note}`, outputComplete: true },
      "session-1",
    );
    expect(recall).toEqual({ recallId: ID, sizeBytes: 524288, tokenCount: 131072 });
  });

  it("stays out of the way when there is no id, no Session, or a still-streaming output", () => {
    const cases: Array<[string, Parameters<typeof recallAffordance>[0], string | undefined]> = [
      ["no note at all", { output: "plain output", outputComplete: true }, "session-1"],
      [
        "a path instead of an id",
        { output: '{"recallId":"../../etc/passwd"}', outputComplete: true },
        "session-1",
      ],
      ["still streaming", { output: note, outputComplete: false }, "session-1"],
      ["no owning Session", { output: note, outputComplete: true }, undefined],
    ];
    for (const [label, call, sessionId] of cases) {
      expect(recallAffordance(call, sessionId), label).toBeNull();
    }
  });

  it("wires the owning Session through the render context", () => {
    // The chip resolves the id against one Session's archive, so the transcript must carry that
    // Session down to the card rather than the card guessing one; the card must route every
    // decision through the tested seam.
    expect(pageSource).toMatch(/sessionId: selected\?\.sessionId/);
    expect(cardSource).toContain("recallAffordance(item, ctx.sessionId)");
    expect(cardSource).toContain("recall && ctx.sessionId !== undefined");
  });
});
