import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, afterEach } from "vitest";
import type { MachineInfo } from "@prismshadow/penguin-server/api";
import { MachineHealth } from "../src/features/machines/machine-health";
import { setActiveStrings } from "../src/lib/strings";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";

const checkedAt = "2026-09-17T12:00:00.000Z";
const render = (status: MachineInfo["status"]) =>
  renderToStaticMarkup(createElement(MachineHealth, { status }));

afterEach(() => setActiveStrings(zh));

describe("recorded machine fleet health", () => {
  it("distinguishes an unprobed machine from a running server", () => {
    setActiveStrings(en);
    expect(render(null)).toContain("Not probed");
    expect(render(null)).not.toContain("Running");
  });

  it.each(["running", "stopped", "unreachable"] as const)(
    "shows %s as a dated observation, not a live claim",
    (state) => {
      setActiveStrings(en);
      const html = render({ state, checkedAt });
      expect(html).toContain(en.machines.health[state]);
      expect(html).toContain("Last probe");
      expect(html).toContain(`dateTime="${checkedAt}"`);
    },
  );

  it("renders escaped transport diagnostics and Chinese labels", () => {
    setActiveStrings(zh);
    const html = render({ state: "unreachable", checkedAt, detail: "<script>refused</script>" });
    expect(html).toContain(zh.machines.health.unreachable);
    expect(html).toContain("&lt;script&gt;refused&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});
