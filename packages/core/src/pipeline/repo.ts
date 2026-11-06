import { execFileSync } from "node:child_process";

export function resolveRepo(cwd: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  return repoFromRemoteUrl(url);
}

export function repoFromRemoteUrl(url: string): string | null {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}
