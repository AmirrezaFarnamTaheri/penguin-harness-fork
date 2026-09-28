/**
 * Attachment notice for a message's uploaded files: the `[attached file: <path>]` lines the
 * server appends aren't shown verbatim, they collapse into a single line reading
 * "Attached files: a.pdf, b.csv" (paperclip icon + static text, no navigation — the files live
 * in the session scratchpad and the model opens them by path); the body text around them is
 * rendered as usual by the caller. It keeps the same visual language as message-level notices;
 * the caller owns its user-side alignment and timestamp footer.
 */
import { S } from "../../lib/strings";
import { attachmentFileName } from "../../lib/attachments";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { STREAM_BANNER_FRAME } from "./disclosure-row";

/** Paperclip glyph (24×24 line path), shared with the composer's file-attachment entry. */
export const PAPERCLIP_ICON =
  "M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.19 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48";

export function AttachedFilesBanner({ files }: { files: string[] }) {
  const label = S.chat.attachedFilesBanner(files.map(attachmentFileName));
  return (
    // max-w-full + truncate, the composer chip's rule (truncate max-w-56) applied to a notice
    // that has no fixed width of its own: several long names would otherwise wrap the banner
    // into a paragraph-tall block above the message. The full list stays reachable as a title.
    // No `anim-msg my-2`, unlike its in-transcript siblings: this one hangs off the message
    // it belongs to, which owns the vertical spacing and the entrance, so adding either
    // would double the gap and re-animate a notice that just arrived with its message.
    <p title={label} className={`flex w-fit max-w-full ${STREAM_BANNER_FRAME}`}>
      <GlyphIcon d={PAPERCLIP_ICON} className="shrink-0 text-gray-400 dark:text-gray-500" />
      <span className="min-w-0 truncate">{label}</span>
    </p>
  );
}
