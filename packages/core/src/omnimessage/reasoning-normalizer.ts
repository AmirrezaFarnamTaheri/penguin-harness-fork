/**
 * Reasoning Stream Normalizer & Thinking Tag Parser.
 * Absorbed and unified from deepseek-harness, DeepSeek-Reasonix, and Qwen-Agent.
 *
 * Normalizes embedded `<think> ... </think>` tags from models that stream reasoning inline
 * into structured reasoning events, isolating internal chain-of-thought from final responses.
 */

export interface ParsedReasoningTurn {
  reasoning: string;
  answer: string;
  hasReasoning: boolean;
}

const THINK_START_TAG = "<think>";
const THINK_END_TAG = "</think>";

/**
 * Extracts thinking blocks from completed text response.
 */
export function extractReasoningBlocks(rawText: string): ParsedReasoningTurn {
  const startIdx = rawText.indexOf(THINK_START_TAG);
  if (startIdx === -1) {
    return {
      reasoning: "",
      answer: rawText.trim(),
      hasReasoning: false,
    };
  }

  const endIdx = rawText.indexOf(THINK_END_TAG, startIdx + THINK_START_TAG.length);
  if (endIdx === -1) {
    // Unclosed think tag (streaming or truncated)
    const reasoning = rawText.slice(startIdx + THINK_START_TAG.length).trim();
    const before = rawText.slice(0, startIdx).trim();
    return {
      reasoning,
      answer: before,
      hasReasoning: true,
    };
  }

  const before = rawText.slice(0, startIdx);
  const reasoning = rawText.slice(startIdx + THINK_START_TAG.length, endIdx).trim();
  const after = rawText.slice(endIdx + THINK_END_TAG.length);
  const answer = (before + after).trim();

  return {
    reasoning,
    answer,
    hasReasoning: true,
  };
}

/**
 * Streaming state machine that parses incoming text deltas, emitting whether chunks belong
 * to reasoning or the visible answer.
 */
export class StreamingReasoningParser {
  private inThinkBlock = false;
  private buffer = "";

  /**
   * Ingests a new text delta and yields classified tokens.
   */
  feed(delta: string): Array<{ kind: "reasoning" | "answer"; text: string }> {
    this.buffer += delta;
    const output: Array<{ kind: "reasoning" | "answer"; text: string }> = [];

    while (this.buffer.length > 0) {
      if (!this.inThinkBlock) {
        const startIdx = this.buffer.indexOf(THINK_START_TAG);
        if (startIdx === -1) {
          // Check if buffer ends with a partial prefix of <think>
          if (THINK_START_TAG.startsWith(this.buffer)) {
            // Wait for next delta to resolve tag
            break;
          }
          output.push({ kind: "answer", text: this.buffer });
          this.buffer = "";
        } else {
          // Text before <think> is answer
          if (startIdx > 0) {
            output.push({ kind: "answer", text: this.buffer.slice(0, startIdx) });
          }
          this.buffer = this.buffer.slice(startIdx + THINK_START_TAG.length);
          this.inThinkBlock = true;
        }
      } else {
        const endIdx = this.buffer.indexOf(THINK_END_TAG);
        if (endIdx === -1) {
          if (THINK_END_TAG.startsWith(this.buffer)) {
            break;
          }
          output.push({ kind: "reasoning", text: this.buffer });
          this.buffer = "";
        } else {
          // Text before </think> is reasoning
          if (endIdx > 0) {
            output.push({ kind: "reasoning", text: this.buffer.slice(0, endIdx) });
          }
          this.buffer = this.buffer.slice(endIdx + THINK_END_TAG.length);
          this.inThinkBlock = false;
        }
      }
    }

    return output;
  }

  flush(): Array<{ kind: "reasoning" | "answer"; text: string }> {
    const output: Array<{ kind: "reasoning" | "answer"; text: string }> = [];
    if (this.buffer.length > 0) {
      output.push({
        kind: this.inThinkBlock ? "reasoning" : "answer",
        text: this.buffer,
      });
      this.buffer = "";
    }
    this.inThinkBlock = false;
    return output;
  }
}
