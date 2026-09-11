import { describe, expect, it } from "vitest";
import {
  extractArtifactsFromText,
  createSandboxedHtmlDocument,
} from "../src/omnimessage/artifact-extractor.js";

describe("ArtifactExtractor", () => {
  it("extracts HTML, SVG, and Mermaid code blocks from markdown", () => {
    const markdown = `
Here is an interactive mockup:
\`\`\`html title="Landing Page Mockup"
<div class="hero">
  <h1>Welcome to Penguin</h1>
</div>
\`\`\`

And the system architecture:
\`\`\`mermaid
graph TD
  A[Client] --> B[Server]
\`\`\`

And a code snippet:
\`\`\`ts
const x = 42;
\`\`\`
`;

    const artifacts = extractArtifactsFromText(markdown);
    expect(artifacts).toHaveLength(3);

    expect(artifacts[0]!.kind).toBe("html");
    expect(artifacts[0]!.title).toBe("Landing Page Mockup");
    expect(artifacts[0]!.previewable).toBe(true);

    expect(artifacts[1]!.kind).toBe("mermaid");
    expect(artifacts[1]!.title).toContain("graph TD");
    expect(artifacts[1]!.previewable).toBe(true);

    expect(artifacts[2]!.kind).toBe("code");
    expect(artifacts[2]!.language).toBe("ts");
    expect(artifacts[2]!.previewable).toBe(false);
  });

  it("wraps HTML fragments into complete sandboxed documents", () => {
    const snippet = "<button class=\"btn\">Click me</button>";
    const doc = createSandboxedHtmlDocument(snippet, {
      title: "Button Test",
      theme: "dark",
    });

    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).toContain("<title>Button Test</title>");
    expect(doc).toContain('<meta name="viewport"');
    expect(doc).toContain(snippet);
    expect(doc).toContain("background-color: #0d1117");
  });

  it("preserves already complete HTML documents while ensuring viewport meta exists", () => {
    const fullHtml = `<!DOCTYPE html><html><head><title>Full Doc</title></head><body><h1>Hello</h1></body></html>`;
    const doc = createSandboxedHtmlDocument(fullHtml);

    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).toContain('name="viewport"');
    expect(doc).toContain("<h1>Hello</h1>");
  });
});
