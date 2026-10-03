const DEFAULT_HEAD_BYTES = 262_144;
const DEFAULT_TAIL_BYTES = 262_144;

/** Keeps a stream's first and last bytes while accounting for everything omitted between them. */
export class BoundedStreamCapture {
  private readonly head: Buffer;
  private headLength = 0;
  private readonly tail: Buffer;
  private tailStart = 0;
  private tailLength = 0;
  private totalBytes = 0n;

  constructor(headBytes = DEFAULT_HEAD_BYTES, tailBytes = DEFAULT_TAIL_BYTES) {
    if (!Number.isSafeInteger(headBytes) || headBytes < 0) {
      throw new RangeError("headBytes must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(tailBytes) || tailBytes < 0) {
      throw new RangeError("tailBytes must be a non-negative safe integer");
    }
    this.head = Buffer.alloc(headBytes);
    this.tail = Buffer.alloc(tailBytes);
  }

  /** Add a chunk, retaining the head first and then the most recent tail bytes. */
  write(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("chunk must be a Buffer");
    this.totalBytes += BigInt(chunk.length);

    let offset = 0;
    if (this.headLength < this.head.length) {
      const count = Math.min(this.head.length - this.headLength, chunk.length);
      chunk.copy(this.head, this.headLength, 0, count);
      this.headLength += count;
      offset = count;
    }

    this.appendTail(chunk.subarray(offset));
  }

  /** Render the captured text, inserting a byte-count marker only when content was omitted. */
  render(): string {
    const head = this.head.subarray(0, this.headLength);
    const tail = this.tailSnapshot();
    const retainedBytes = BigInt(this.headLength + this.tailLength);
    if (this.totalBytes <= retainedBytes) return Buffer.concat([head, tail]).toString("utf8");

    const omittedBytes = this.totalBytes - retainedBytes;
    return `${head.toString("utf8")}\n…[omitted ${omittedBytes} bytes]…\n${tail.toString("utf8")}`;
  }

  private appendTail(chunk: Buffer): void {
    const capacity = this.tail.length;
    if (capacity === 0 || chunk.length === 0) return;

    if (chunk.length >= capacity) {
      chunk.copy(this.tail, 0, chunk.length - capacity);
      this.tailStart = 0;
      this.tailLength = capacity;
      return;
    }

    const initialCount = Math.min(chunk.length, capacity - this.tailLength);
    const writePosition = (this.tailStart + this.tailLength) % capacity;
    this.copyIntoTail(chunk, 0, initialCount, writePosition);
    this.tailLength += initialCount;

    const overflow = chunk.length - initialCount;
    if (overflow > 0) {
      this.copyIntoTail(chunk, initialCount, chunk.length, this.tailStart);
      this.tailStart = (this.tailStart + overflow) % capacity;
    }
  }

  private copyIntoTail(
    source: Buffer,
    sourceStart: number,
    sourceEnd: number,
    tailStart: number,
  ): void {
    let sourceOffset = sourceStart;
    let tailOffset = tailStart;
    while (sourceOffset < sourceEnd) {
      const count = Math.min(sourceEnd - sourceOffset, this.tail.length - tailOffset);
      source.copy(this.tail, tailOffset, sourceOffset, sourceOffset + count);
      sourceOffset += count;
      tailOffset = (tailOffset + count) % this.tail.length;
    }
  }

  private tailSnapshot(): Buffer {
    const result = Buffer.alloc(this.tailLength);
    if (this.tailLength === 0) return result;

    const firstCount = Math.min(this.tailLength, this.tail.length - this.tailStart);
    this.tail.copy(result, 0, this.tailStart, this.tailStart + firstCount);
    const secondCount = this.tailLength - firstCount;
    if (secondCount > 0) this.tail.copy(result, firstCount, 0, secondCount);
    return result;
  }
}
