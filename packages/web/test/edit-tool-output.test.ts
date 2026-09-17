import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditToolOutput } from "../src/features/chat/edit-tool-output";

const output = 'Replaced 1 occurrence in "a.ts".\n@@ -1,1 +1,1 @@\n-old value\n+new value';
describe("edit tool output", () => {
  it("renders actual unified diff lines with add/remove styling", () => {
    const html = renderToStaticMarkup(createElement(EditToolOutput, { output }));
    expect(html).toContain("old value");
    expect(html).toContain("new value");
    expect(html).toContain("bg-emerald-50");
    expect(html).toContain("bg-rose-50");
    expect(html).toContain("Replaced 1 occurrence");
  });

  it("does not fabricate diffs from errors or legacy summaries", () => {
    for (const text of ['old_string not found in "a.ts".', 'Replaced 1 occurrence in "a.ts".']) {
      const html = renderToStaticMarkup(createElement(EditToolOutput, { output: text }));
      expect(html).not.toContain("bg-emerald-50");
      expect(html).not.toContain("Copy diff");
    }
  });

  it("preserves omission notes and runtime attribution outside the diff", () => {
    const html = renderToStaticMarkup(
      createElement(EditToolOutput, {
        output: `${output}\n…and 9 more replacements\n[editor attribution: runtime]`,
      }),
    );
    expect(html).toContain("…and 9 more replacements");
    expect(html).toContain("[editor attribution: runtime]");
  });
});
