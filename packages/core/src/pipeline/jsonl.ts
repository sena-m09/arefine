import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type ReadResult = {
  lines: string[];
  nextOffset: number;
};

export function readNewLines(file: string, offset: number): ReadResult {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);

    // 書き込み途中の最後の行は読まず、次回に回す
    const end = buffer.lastIndexOf(0x0a) + 1;
    const lines = buffer
      .subarray(0, end)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    return { lines, nextOffset: start + end };
  } finally {
    closeSync(fd);
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
