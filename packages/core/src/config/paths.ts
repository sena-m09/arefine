import { homedir } from "node:os";
import { join } from "node:path";

export const UNKNOWN_REPO_DIR = "_unknown";

export function arefineHome(env: NodeJS.ProcessEnv): string {
  return env["AREFINE_HOME"] ?? join(homedir(), ".arefine");
}

export function repoDir(home: string, repo: string | null): string {
  return join(home, repo === null ? UNKNOWN_REPO_DIR : repo.replace("/", "__"));
}
