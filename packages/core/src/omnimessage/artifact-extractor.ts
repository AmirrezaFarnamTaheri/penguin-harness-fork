/**
 * Artifact Extractor & Sandbox Document Builder.
 *
 * Scans agent outputs and markdown message streams to isolate renderable artifacts:
 * HTML prototypes, SVG vectors, Mermaid architecture diagrams, and structured JSON receipts.
 * Wraps snippets into self-contained, preview-safe sandboxed HTML documents.
 *
 * Synthesized from html-anything, archify, and effective-html engines.
 */

export type ArtifactKind = "html" | "svg" | "mermaid" | "code" | "json";

export interface ExtractedArtifact {
  id: string;
  kind: ArtifactKind;
  language: string;
  title: string;
  content: string;
  startIndex: number;
  endIndex: number;
  previewable: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Extracts code and diagram blocks from markdown text.
 */
export function extractArtifactsFromText(text: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*(?:title="([^"]*)")?\r?\n([\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  let counter = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const rawLang = (match[1] ?? "").toLowerCase().trim();
    const explicitTitle = match[2];
    const content = (match[3] ?? "").trim();
    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;

    if (!content) continue;

    counter++;
    let kind: ArtifactKind = "code";
    let previewable = false;
    let language = rawLang || "text";

    if (
      rawLang === "html" ||
      rawLang === "htm" ||
      (rawLang === "" && (content.startsWith("<!DOCTYPE html>") || content.startsWith("<html")))
    ) {
      kind = "html";
      language = "html";
      previewable = true;
    } else if (rawLang === "svg" || content.startsWith("<svg")) {
      kind = "svg";
      language = "svg";
      previewable = true;
    } else if (rawLang === "mermaid") {
      kind = "mermaid";
      language = "mermaid";
      previewable = true;
    } else if (rawLang === "json") {
      kind = "json";
      language = "json";
      previewable = false;
    }

    const title = explicitTitle || inferArtifactTitle(kind, content, counter);

    artifacts.push({
      id: `artifact_${Date.now()}_${counter}`,
      kind,
      language,
      title,
      content,
      startIndex,
      endIndex,
      previewable,
    });
  }

  return artifacts;
}

function inferArtifactTitle(kind: ArtifactKind, content: string, index: number): string {
  if (kind === "html") {
    const titleMatch = /<title>(.*?)<\/title>/i.exec(content);
    if (titleMatch?.[1]) return titleMatch[1].trim();
    const h1Match = /<h1[^>]*>(.*?)<\/h1>/i.exec(content);
    if (h1Match?.[1]) return h1Match[1].replace(/<[^>]+>/g, "").trim();
    return `HTML Prototype ${index}`;
  }

  if (kind === "mermaid") {
    const firstLine = content.split("\n")[0]?.trim() || "";
    return `Diagram: ${firstLine}`;
  }

  if (kind === "svg") {
    return `Vector SVG ${index}`;
  }

  return `Code Snippet ${index}`;
}

export interface SandboxHtmlOptions {
  title?: string;
  theme?: "light" | "dark";
  includeTailwindCdn?: boolean;
}

/**
 * Wraps raw HTML or HTML fragments into a complete, secure, responsive HTML document
 * ready to be rendered in a sandboxed iframe.
 */
export function createSandboxedHtmlDocument(
  rawContent: string,
  options: SandboxHtmlOptions = {},
): string {
  const isFullDocument =
    rawContent.includes("<!DOCTYPE html>") ||
    rawContent.includes("<html") ||
    rawContent.includes("<body");

  const title = options.title || "Preview Artifact";
  const theme = options.theme || "light";
  const bgClass =
    theme === "dark"
      ? "background-color: #0d1117; color: #c9d1d9;"
      : "background-color: #ffffff; color: #1f2328;";

  if (isFullDocument) {
    // If full document, inject meta charset and responsive viewport if missing
    let doc = rawContent;
    if (!doc.includes("<meta charset")) {
      doc = doc.replace(/<head[^>]*>/i, `$&<meta charset="utf-8">`);
    }
    if (!doc.includes('name="viewport"')) {
      doc = doc.replace(
        /<head[^>]*>/i,
        `$&<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
      );
    }
    return doc;
  }

  // Wrap snippet with modern baseline CSS
  const tailwindScript =
    options.includeTailwindCdn !== false
      ? '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>'
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${tailwindScript}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      ${bgClass}
      min-height: 100vh;
    }
  </style>
</head>
<body>
${rawContent}
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
