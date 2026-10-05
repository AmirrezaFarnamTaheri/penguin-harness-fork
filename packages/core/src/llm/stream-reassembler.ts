export type StreamDelta = { type: "append"; text: string } | { type: "reset"; text: string };
export type ChannelDelta = StreamDelta & { channel: "reasoning" | "content" };

function wellFormed(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

function high(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function low(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Provider edit offsets are UTF-16 units; a split surrogate clamps to the rune's start. */
export function utf16IndexToByteIndex(text: string, offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) throw new RangeError("Invalid UTF-16 offset");
  let end = Math.min(Math.floor(offset), text.length);
  if (end > 0 && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  return new TextEncoder().encode(text.slice(0, end)).length;
}

function commonPrefix(a: string, b: string): number {
  let end = 0;
  while (end < a.length && end < b.length && a[end] === b[end]) end++;
  if (end > 0 && high(a.charCodeAt(end - 1))) end--;
  return end;
}

function heldBoundary(text: string, runes: number): number {
  let end = text.length;
  for (let count = 0; count < runes && end > 0; count++) {
    end--;
    if (end > 0 && low(text.charCodeAt(end)) && high(text.charCodeAt(end - 1))) end--;
  }
  const tagStart = text.lastIndexOf("<");
  if (tagStart >= 0) {
    const suffix = text.slice(tagStart).toLowerCase();
    if (
      ["<details", "</details"].some(
        (tag) => tag.startsWith(suffix) || (suffix.startsWith(tag) && !suffix.includes(">")),
      )
    )
      end = Math.min(end, tagStart);
  }
  if (text.endsWith(">") && (text.length === 1 || text.at(-2) === "\n"))
    end = Math.min(end, text.length - 1);
  return end;
}

/** Snapshot rewrites carry explicit resets; consumers must apply both delta variants. */
export class StreamReassembler {
  private latest = "";
  private visible = "";
  private closed = false;

  constructor(private readonly holdBackRunes = 24) {
    if (!Number.isSafeInteger(holdBackRunes) || holdBackRunes < 0)
      throw new RangeError("holdBackRunes must be a non-negative safe integer");
  }

  get view(): string {
    return this.visible;
  }

  apply(target: string): StreamDelta[] {
    if (this.closed) throw new Error("Stream reassembler is finalized");
    this.latest = wellFormed(target);
    // A prefix rollback can still be transient. Keep the visible text until final flush,
    // or a subsequent rewrite makes an explicit reset necessary.
    if (this.visible.startsWith(this.latest) && this.latest.length < this.visible.length) return [];
    return this.sync(this.latest.slice(0, heldBoundary(this.latest, this.holdBackRunes)));
  }

  /** Release pending text without closing, used when reasoning must precede content. */
  flush(): StreamDelta[] {
    if (this.closed) throw new Error("Stream reassembler is finalized");
    return this.sync(this.latest);
  }

  finalize(): StreamDelta[] {
    const deltas = this.flush();
    this.closed = true;
    return deltas;
  }

  private sync(target: string): StreamDelta[] {
    const common = commonPrefix(this.visible, target);
    const deltas: StreamDelta[] = [];
    if (common !== this.visible.length)
      deltas.push({ type: "reset", text: target.slice(0, common) });
    const suffix = target.slice(common);
    if (suffix) deltas.push({ type: "append", text: suffix });
    this.visible = target;
    return deltas;
  }
}

export class ReasoningContentReassembler {
  private readonly reasoning: StreamReassembler;
  private readonly content: StreamReassembler;

  constructor(holdBackRunes = 24) {
    this.reasoning = new StreamReassembler(holdBackRunes);
    this.content = new StreamReassembler(holdBackRunes);
  }

  apply(snapshot: {
    reasoning: string;
    content: string;
    reasoningComplete?: boolean;
  }): ChannelDelta[] {
    const reasoning = this.reasoning.apply(snapshot.reasoning);
    if (snapshot.reasoningComplete || snapshot.content) reasoning.push(...this.reasoning.flush());
    return [
      ...reasoning.map((delta) => ({ ...delta, channel: "reasoning" as const })),
      ...this.content
        .apply(snapshot.content)
        .map((delta) => ({ ...delta, channel: "content" as const })),
    ];
  }

  finalize(): ChannelDelta[] {
    return [
      ...this.reasoning.finalize().map((delta) => ({ ...delta, channel: "reasoning" as const })),
      ...this.content.finalize().map((delta) => ({ ...delta, channel: "content" as const })),
    ];
  }
}
