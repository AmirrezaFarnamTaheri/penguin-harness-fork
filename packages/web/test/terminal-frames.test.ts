import { describe, expect, it } from "vitest";
import {
  TerminalOpcode,
  decodeExitFrame,
  decodeFrame,
  encodeFrame,
  encodeResize,
} from "../src/features/terminal/terminal-frames";

describe("encodeFrame / decodeFrame", () => {
  // Uint8Array.buffer is typed ArrayBufferLike; decodeFrame takes an ArrayBuffer, so the
  // bytes are copied into a plain one.
  const decodeBytes = (bytes: Uint8Array) => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return decodeFrame(buffer);
  };

  it("round-trips an output payload through the wire format", () => {
    expect(decodeBytes(encodeFrame(TerminalOpcode.Output, "hello\x1b[2Jworld"))).toEqual({
      opcode: TerminalOpcode.Output,
      slot: 0,
      text: "hello\x1b[2Jworld",
    });
  });

  it("treats an empty payload as empty text", () => {
    expect(decodeBytes(encodeFrame(TerminalOpcode.Exit, ""))).toEqual({
      opcode: TerminalOpcode.Exit,
      slot: 0,
      text: "",
    });
  });

  it("rejects a frame shorter than the two-byte header", () => {
    expect(decodeFrame(new ArrayBuffer(1))).toBeNull();
  });

  it("encodes a resize with its intent", () => {
    const frame = decodeBytes(encodeResize(80, 24, "claim"));
    expect(frame?.opcode).toBe(TerminalOpcode.Resize);
    expect(JSON.parse(frame!.text)).toEqual({ cols: 80, rows: 24, intent: "claim" });
  });
});

describe("decodeExitFrame", () => {
  it("reads the pty exit status", () => {
    expect(decodeExitFrame(JSON.stringify({ exitCode: 0 }))).toEqual({ ok: true, exitCode: 0 });
    expect(decodeExitFrame(JSON.stringify({ exitCode: 127 }))).toEqual({ ok: true, exitCode: 127 });
  });

  it("reports a non-JSON body instead of throwing", () => {
    const res = decodeExitFrame("not json at all");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/JSON|unexpected/i);
  });

  it("reports an empty body", () => {
    expect(decodeExitFrame("")).toEqual({ ok: false, reason: expect.stringContaining("JSON") });
  });

  it("reports a body whose exitCode is missing or not an integer", () => {
    expect(decodeExitFrame(JSON.stringify({ status: "done" }))).toEqual({
      ok: false,
      reason: "exitCode is missing or not an integer",
    });
    expect(decodeExitFrame(JSON.stringify({ exitCode: "3" }))).toEqual({
      ok: false,
      reason: "exitCode is missing or not an integer",
    });
    expect(decodeExitFrame(JSON.stringify({ exitCode: 1.5 }))).toEqual({
      ok: false,
      reason: "exitCode is missing or not an integer",
    });
  });
});
