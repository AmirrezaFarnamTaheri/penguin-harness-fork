/**
 * Source notice for a skill invocation: the `[use_skills]` block at the start of a message isn't
 * shown verbatim, it's collapsed into a single line reading "Using skills: <names>" (book icon +
 * static text, no navigation — skill management lives on the skill library page); the body text
 * after the block is rendered as usual by the caller.
 */
import { S } from "../../lib/strings";
import { GlyphIcon } from "../../components/ui/glyph-icon";
import { STREAM_BANNER_FRAME } from "./disclosure-row";
import { BOOK_ICON } from "./skill-use";

export function SkillsBanner({ names }: { names: string[] }) {
  return (
    <p className={`anim-msg my-2 flex w-fit ${STREAM_BANNER_FRAME}`}>
      <GlyphIcon d={BOOK_ICON} className="text-gray-400 dark:text-gray-500" />
      {S.chat.skillsBanner(names)}
    </p>
  );
}
