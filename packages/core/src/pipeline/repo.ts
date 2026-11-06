import { execFileSync } from "node:child_process";

export function resolveRepo(cwd: string): string | null {
  const url = originUrl(cwd);
  return url === null ? null : repoFromRemoteUrl(url);
}

export function repoFromRemoteUrl(url: string): string | null {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

function originUrl(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
