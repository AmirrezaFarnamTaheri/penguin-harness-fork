/**
 * Incremental JSON frames separated by newline-delimited decimal markers.
 * Markers identify boundaries; their value need not equal the UTF-8 payload length.
 */
export class LengthPrefixedFrameParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private parserState: "open" | "finished" | "failed" = "open";
  private readonly encoder = new TextEncoder();

  get state(): "open" | "finished" | "failed" {
    return this.parserState;
  }

  constructor(private readonly maxBufferedBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1)
      throw new RangeError("maxBufferedBytes must be a positive safe integer");
  }

  /** Bytes may split a UTF-8 code point or a marker across calls. */
  write(chunk: Uint8Array): string[] {
    if (this.parserState !== "open") throw new Error("Frame parser is closed");
    const frames: string[] = [];
    // Decode in bounded pieces so a large network chunk can contain many small frames.
    try {
      const sliceSize = Math.min(4096, this.maxBufferedBytes);
      for (let offset = 0; offset < chunk.length; offset += sliceSize) {
        this.buffer += this.decoder.decode(chunk.subarray(offset, offset + sliceSize), {
          stream: true,
        });
        frames.push(...this.drain(false));
        this.checkSize(this.buffer);
      }
    } catch (error) {
      this.parserState = "failed";
      this.buffer = "";
      throw error;
    }
    return frames;
  }

  /** Emit a complete final JSON payload without requiring another marker. */
  finish(): string[] {
    if (this.parserState !== "open") throw new Error("Frame parser is closed");
    try {
      this.buffer += this.decoder.decode();
      const frames = this.drain(true);
      this.parserState = "finished";
      return frames;
    } catch (error) {
      this.parserState = "failed";
      throw error;
    } finally {
      this.buffer = "";
    }
  }

  private checkSize(text: string): void {
    if (this.encoder.encode(text).length > this.maxBufferedBytes)
      throw new RangeError("Frame exceeds the configured buffer limit");
  }

  private drain(eof: boolean): string[] {
    const frames: string[] = [];
    for (;;) {
      // Keep a partial marker at the end until more bytes arrive.
      const start = /(?:^|\n)\d{1,12}\r?\n/.exec(this.buffer);
      if (!start) {
        if (eof) this.buffer = "";
        else {
          const partial = /(?:^|\n)\d{0,12}\r?$/.exec(this.buffer);
          this.buffer = partial ? partial[0] : "";
        }
        break;
      }
      if (start.index > 0) this.buffer = this.buffer.slice(start.index);
      const header = /^(?:\n)?\d{1,12}\r?\n/.exec(this.buffer)!;
      const bodyStart = header[0].length;
      const boundaries = /\n\d{1,12}\r?\n/g;
      boundaries.lastIndex = bodyStart;
      let boundary;
      let next = -1;
      let recoveryStart = -1;
      while ((boundary = boundaries.exec(this.buffer))) {
        const body = this.buffer.slice(bodyStart, boundary.index).trim();
        if (this.isJson(body)) {
          this.checkSize(body);
          frames.push(body);
          next = boundary.index;
          break;
        }
        if (recoveryStart >= 0) {
          const recovered = this.buffer.slice(recoveryStart, boundary.index).trim();
          if (this.isJson(recovered)) {
            this.checkSize(recovered);
            frames.push(recovered);
            next = boundary.index;
            break;
          }
        }
        recoveryStart = boundary.index + boundary[0].length;
        // A malformed frame can resync at a later marker. A numeric line inside valid
        // pretty JSON must not be treated as a boundary, so keep looking first.
      }
      if (next >= 0) {
        this.buffer = this.buffer.slice(next);
        continue;
      }
      const body = this.buffer.slice(bodyStart).trim();
      if (eof) {
        if (this.isJson(body)) {
          this.checkSize(body);
          frames.push(body);
        } else {
          const later = /\n\d{1,12}\r?\n/.exec(this.buffer.slice(bodyStart));
          if (later) {
            this.buffer = this.buffer.slice(bodyStart + later.index);
            continue;
          }
        }
        this.buffer = "";
      }
      break;
    }
    return frames;
  }

  private isJson(text: string): boolean {
    if (!text) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
}
