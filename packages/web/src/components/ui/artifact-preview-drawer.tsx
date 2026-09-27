/**
 * Artifact Live Preview Drawer.
 *
 * Provides a sandboxed iframe viewer with responsive viewport switching (Desktop,
 * Tablet, Mobile), theme toggle, popout window, and file download.
 *
 * Synthesized from archify showcase and effective-html preview runners.
 *
 * It lives here, not in features/chat, because nothing about it is chat: it takes a
 * document and a title and previews it. Its first caller is the code block, but the
 * drawer's own copy is the same as anyone else's, and every string on it comes from
 * the dictionary (S.artifactPreview) so it is translatable wherever it is mounted.
 */
import { useState, useMemo } from "react";
import { S } from "../../lib/strings";
import { Drawer } from "./drawer";
import { CopyButton } from "./copy-button";
import { GlyphIcon } from "./glyph-icon";
import { ICON_SIZE } from "../../lib/icon-scale";

/** Moon and sun, as paths in the same thin-line family as the drawer's other glyphs. The
 *  theme toggle used emoji here, which was the only *control* emoji in the whole chat
 *  feature; `GlyphIcon` is the convention 64 files in `components/ui` already follow. */
const MOON_ICON = "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z";
const SUN_ICON =
  "M12 6.5v-2M12 19.5v-2M6.5 12h-2M19.5 12h-2M8 8 6.6 6.6M17.4 17.4 16 16M8 16l-1.4 1.4M17.4 6.6 16 8M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z";

export interface ArtifactPreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: "html" | "svg" | "mermaid" | "code";
  content: string;
}

type ViewportSize = "desktop" | "tablet" | "mobile";

/** Labels are thunks, not values: the dictionary is bound at boot and re-bound on every
 *  language switch, so a module-scope `S.x` here would freeze the English string. */
const VIEWPORTS: Record<ViewportSize, { label: () => string; width: string }> = {
  desktop: { label: () => S.artifactPreview.viewportDesktop, width: "w-full" },
  tablet: { label: () => S.artifactPreview.viewportTablet, width: "w-[768px]" },
  mobile: { label: () => S.artifactPreview.viewportMobile, width: "w-[375px]" },
};

/**
 * How long a blob URL opened in a new tab is kept alive before it is revoked.
 *
 * The navigation that consumes the URL is not synchronous, so revoking on the next line
 * races it and can leave the new tab showing nothing. A minute is far longer than any
 * navigation needs and still bounds the cost of a blocked one, which is the case that
 * matters: a user stepping through twenty artifacts holds at most twenty blobs rather than
 * all of them for the life of the page.
 */
const OBJECT_URL_TTL_MS = 60_000;

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
    // `noopener` so the opened document cannot reach back through `window.opener`. The
    // wrapper already sandboxes its iframe, but the outer document is same-origin with us
    // and this is the one reference between the two, so it is worth severing.
    const opened = window.open(url, "_blank", "noopener");
    // The blob must outlive the navigation that consumes it, so it cannot be revoked on the
    // next line. Releasing it on a timer bounds the cost to one blob per press; the previous
    // code never released it at all, so every preview opened in a new tab pinned its Blob for
    // the life of the page and a user stepping through artifacts grew the tab without limit.
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
    // A blocked popup returns null, and the user asked to see the preview: silently doing
    // nothing is the one outcome they cannot act on. The download carries the same bytes and
    // is never blocked, so it is the honest fallback rather than a dead button.
    if (opened === null) handleDownload();
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
                {VIEWPORTS[vp].label()}
              </button>
            ))}
          </div>

          {/* Actions: Theme Toggle, Popout, Download, Copy */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewTheme((t) => (t === "light" ? "dark" : "light"))}
              className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              title={
                previewTheme === "light"
                  ? S.artifactPreview.switchToDark
                  : S.artifactPreview.switchToLight
              }
            >
              <GlyphIcon
                d={previewTheme === "light" ? MOON_ICON : SUN_ICON}
                size={ICON_SIZE.inlineGlyph}
              />
            </button>

            <button
              type="button"
              onClick={handleOpenInNewTab}
              className="rounded px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"
              title={S.artifactPreview.openInNewTab}
            >
              {S.artifactPreview.popout}
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="rounded px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"
              title={S.artifactPreview.download}
            >
              {S.artifactPreview.export}
            </button>

            <CopyButton label={S.artifactPreview.copySource} text={content} />
          </div>
        </div>

        {/* Viewport Frame */}
        <div className="flex flex-1 items-center justify-center overflow-auto bg-gray-100 p-4 dark:bg-gray-950">
          <div
            className={`h-full transition-[width] duration-200 ${VIEWPORTS[viewport].width} overflow-hidden rounded-md border border-gray-300 bg-white shadow-md dark:border-gray-800 dark:bg-gray-900`}
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
