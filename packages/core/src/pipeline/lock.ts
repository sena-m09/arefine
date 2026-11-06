import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Locked<T> = { ok: true; value: T } | { ok: false; holder: number | null; file: string };

export function lockFile(home: string): string {
  return join(home, "run.lock");
}

export function withLock<T>(home: string, action: () => T): Locked<T> {
  const file = lockFile(home);
  mkdirSync(home, { recursive: true });
  if (!acquire(file)) {
    return { ok: false, holder: holderOf(file), file };
  }
  try {
    return { ok: true, value: action() };
  } finally {
    rmSync(file, { force: true });
  }
}

function acquire(file: string): boolean {
  if (tryCreate(file)) {
    return true;
  }
  const holder = holderOf(file);
  if (holder !== null && isAlive(holder)) {
    return false;
  }
  rmSync(file, { force: true });
  return tryCreate(file);
}

// 中身を書き終えたファイルを link で置くので、pid の入っていないロックを他から読まれることがない
function tryCreate(file: string): boolean {
  const draft = `${file}.${process.pid}`;
  writeFileSync(draft, `${process.pid}\n`);
  try {
    linkSync(draft, file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    rmSync(draft, { force: true });
  }
}

function holderOf(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
