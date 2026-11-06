import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type ReadResult = {
  records: unknown[];
  nextOffset: number;
};

export function readNewRecords(file: string, offset: number): ReadResult {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);

    // 書き込み途中の最後の行は読まず、次回に回す
    const end = buffer.lastIndexOf(0x0a) + 1;
    const records: unknown[] = [];
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return { records, nextOffset: start + end };
  } finally {
    closeSync(fd);
  }
}
