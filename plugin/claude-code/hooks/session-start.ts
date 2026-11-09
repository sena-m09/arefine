import { readFileSync } from "node:fs";
import { sessionStartOutput } from "./unread.ts";

try {
  const output = sessionStartOutput(readFileSync(0, "utf8"), process.env, process.cwd());
  if (output !== null) {
    process.stdout.write(output);
  }
} catch {
  // 知らせるだけの hook なので、失敗しても何も出さずに正常終了する
}
