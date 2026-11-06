import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type ReadResult = {
  lines: string[];
  nextOffset: number;
};

export type LineEntry = {
  text: string;
  end: number;
};

export function readNewLines(file: string, offset: number): ReadResult {
  const entries = readNewLineEntries(file, offset);
  return {
    lines: entries.entries.filter((entry) => entry.text.trim() !== "").map((entry) => entry.text),
    nextOffset: entries.nextOffset,
  };
}

export function readNewLineEntries(file: string, offset: number): { entries: LineEntry[]; nextOffset: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);

    // 書き込み途中の最後の行は読まず、次回に回す
    const end = buffer.lastIndexOf(0x0a) + 1;
    const texts = buffer.subarray(0, end).toString("utf8").split("\n").slice(0, -1);
    const ends = texts.reduce<number[]>((acc, text) => {
      acc.push((acc.at(-1) ?? start) + Buffer.byteLength(text, "utf8") + 1);
      return acc;
    }, []);
    return {
      entries: texts.map((text, i) => ({ text, end: ends[i] ?? start + end })),
      nextOffset: start + end,
    };
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
