/**
 * Artifact Live Preview Drawer.
 *
 * Provides a sandboxed iframe viewer with responsive viewport switching (Desktop,
 * Tablet, Mobile), theme toggle, popout window, and file download.
 *
 * Synthesized from archify showcase and effective-html preview runners.
 */
import { useState, useMemo } from "react";
import { Drawer } from "../../components/ui/drawer";
import { CopyButton } from "../../components/ui/copy-button";

export interface ArtifactPreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: "html" | "svg" | "mermaid" | "code";
  content: string;
}

type ViewportSize = "desktop" | "tablet" | "mobile";

const VIEWPORTS: Record<ViewportSize, { label: string; width: string }> = {
  desktop: { label: "Desktop", width: "w-full" },
  tablet: { label: "Tablet (768px)", width: "w-[768px]" },
  mobile: { label: "Mobile (375px)", width: "w-[375px]" },
};

export function ArtifactPreviewDrawer({
  open,
  onClose,
  title,
  kind,
  content,
}: ArtifactPreviewDrawerProps) {
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">("light");

  const sandboxedHtml = useMemo(() => {
    if (kind === "svg") {
      return `<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${
        previewTheme === "dark" ? "#0d1117" : "#ffffff"
      };">${content}</body></html>`;
    }

    if (kind === "html") {
      const isFull = content.includes("<!DOCTYPE") || content.includes("<html");
      if (isFull) return content;
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: ${previewTheme === "dark" ? "#0d1117" : "#ffffff"};
      color: ${previewTheme === "dark" ? "#c9d1d9" : "#1f2328"};
    }
  </style>
</head>
<body>
${content}
</body>
</html>`;
    }

    return `<!DOCTYPE html><html><body><pre style="padding:16px;">${content.replace(
      /</g,
      "&lt;",
    )}</pre></body></html>`;
  }, [kind, content, previewTheme]);

  const handleOpenInNewTab = () => {
    // Wrap content inside an isolated document with strict CSP and a sandboxed iframe (opaque origin)
    // to prevent model-generated content from executing scripts in the application's origin.
    const escapedContent = sandboxedHtml.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const isolatedWrapper = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title.replace(/</g, "&lt;")}</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src data: blob: 'self';">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${
      previewTheme === "dark" ? "#0d1117" : "#ffffff"
    }; }
    iframe { width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe sandbox="${kind === "svg" ? "" : "allow-scripts"}" srcdoc="${escapedContent}"></iframe>
</body>
</html>`;
    const blob = new Blob([isolatedWrapper], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const handleDownload = () => {
    const ext = kind === "svg" ? "svg" : "html";
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${ext}`;
    const blob = new Blob([content], {
      type: kind === "svg" ? "image/svg+xml" : "text/html",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Drawer open={open} title={title} onClose={onClose} widthClass="sm:max-w-4xl">
      <div className="flex h-full flex-col">
        {/* Top Controls Bar */}
        <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
          {/* Viewport Selectors */}
          <div className="flex items-center gap-1 rounded-lg bg-gray-200/70 p-0.5 dark:bg-gray-800">
            {(["desktop", "tablet", "mobile"] as ViewportSize[]).map((vp) => (
              <button
                key={vp}
                type="button"
                onClick={() => setViewport(vp)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewport === vp
                    ? "bg-white text-gray-900 shadow-xs dark:bg-gray-700 dark:text-gray-100"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                }`}
              >
                {VIEWPORTS[vp].label}
              </button>
            ))}
          </div>

          {/* Actions: Theme Toggle, Popout, Download, Copy */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewTheme((t) => (t === "light" ? "dark" : "light"))}
              className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              title={`Switch to ${previewTheme === "light" ? "dark" : "light"} mode`}
            >
              {previewTheme === "light" ? "🌙" : "☀️"}
            </button>

            <button
              type="button"
              onClick={handleOpenInNewTab}
              className="rounded px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"
              title="Open preview in new tab"
            >
              Popout
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="rounded px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"
              title="Download file"
            >
              Export
            </button>

            <CopyButton label="Copy artifact source" text={content} />
          </div>
        </div>

        {/* Viewport Frame */}
        <div className="flex flex-1 items-center justify-center overflow-auto bg-gray-100 p-4 dark:bg-gray-950">
          <div
            className={`h-full transition-all duration-200 ${VIEWPORTS[viewport].width} overflow-hidden rounded-md border border-gray-300 bg-white shadow-md dark:border-gray-800 dark:bg-gray-900`}
          >
            <iframe
              srcDoc={sandboxedHtml}
              title={title}
              sandbox="allow-scripts"
              className="h-full w-full border-0"
            />
          </div>
        </div>
      </div>
    </Drawer>
  );
}
