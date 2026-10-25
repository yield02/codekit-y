import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRemote } from "./git.js";
import { readLineage } from "./lineage.js";
import { createLogger } from "./logger.js";
import { manualMerge, type MergeSummary } from "./sync.js";
import type { Workspace } from "./workspace.js";

// Squash and rebase merges leave no ancestry link between the branch and its
// target, so `sync` cannot see them. GitHub can: read-only GET requests only.

const log = createLogger("codemap-github");
const MAX_BRANCHES_PER_RUN = 30;

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface MergedPr {
  number: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergedAt: string;
}

export interface GitHubTarget {
  apiUrl: string;
  owner: string;
  repo: string;
}

/** `github.com/acme/shop` -> api.github.com; other hosts need `github.apiUrl` (GitHub Enterprise). */
export function githubTarget(remoteUrl: string, apiUrl?: string): GitHubTarget | null {
  const parts = normalizeRemote(remoteUrl).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const [host, owner, repo] = [parts[0]!, parts.at(-2)!, parts.at(-1)!];
  if (apiUrl) return { apiUrl: apiUrl.replace(/\/+$/, ""), owner, repo };
  if (host === "github.com") return { apiUrl: "https://api.github.com", owner, repo };
  return null;
}

export async function findMergedPr(target: GitHubTarget, branch: string, base: string, fetchImpl: FetchLike, token?: string): Promise<MergedPr | null> {
  const url = `${target.apiUrl}/repos/${target.owner}/${target.repo}/pulls?state=closed&per_page=20` +
    `&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${target.owner}:${branch}`)}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "codekit", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers }); // GET only — the kit never writes to the code host
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  const pulls = (await res.json()) as Array<{ number: number; merged_at: string | null; head: { ref: string; sha: string }; base: { ref: string } }>;
  const merged = pulls
    .filter((p) => p.merged_at && p.head?.ref === branch && p.base?.ref === base)
    .sort((a, b) => (b.merged_at ?? "").localeCompare(a.merged_at ?? ""))[0];
  return merged ? { number: merged.number, headRef: merged.head.ref, baseRef: merged.base.ref, headSha: merged.head.sha, mergedAt: merged.merged_at! } : null;
}

export interface PrMergeReport {
  checked: number;
  merged: { branch: string; into: string; pr: number; result: MergeSummary }[];
  skipped?: string;
}

export interface DetectOptions {
  fetchImpl?: FetchLike;
  token?: string;
  /** Ignore the check interval. */
  force?: boolean;
}

/** Merge maps of branches whose PRs were merged on GitHub (squash/rebase included). */
export async function detectPrMerges(ws: Workspace, opts: DetectOptions = {}): Promise<PrMergeReport> {
  const report: PrMergeReport = { checked: 0, merged: [] };
  if (!ws.config.github.enabled) return { ...report, skipped: "disabled in codekit.yaml" };
  const remote = ws.source.remoteUrl();
  const target = remote ? githubTarget(remote, ws.config.github.apiUrl) : null;
  if (!target) return { ...report, skipped: "remote is not on GitHub (set github.apiUrl for GitHub Enterprise)" };

  const stamp = join(ws.cacheDir, "github-check.json");
  if (!opts.force && existsSync(stamp)) {
    const last = Number((JSON.parse(readFileSync(stamp, "utf8")) as { at?: number }).at ?? 0);
    if (Date.now() - last < ws.config.github.checkIntervalMinutes * 60_000) return { ...report, skipped: "checked recently" };
  }
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  const candidates = ws.store.listBranches()
    .filter((b) => b !== ws.config.defaultBranch)
    .map((b) => readLineage(ws.store, b))
    .filter((l): l is NonNullable<typeof l> => !!l && l.status === "active" && !!l.parent)
    .slice(0, MAX_BRANCHES_PER_RUN);

  for (const lineage of candidates) {
    report.checked++;
    let pr: MergedPr | null;
    try {
      pr = await findMergedPr(target, lineage.branch, lineage.parent!, fetchImpl, token);
    } catch (err) {
      log.warn(["github", "sync"], "PR lookup failed", { branch: lineage.branch, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!pr) continue;
    const already = lineage.lastMergedCommit === pr.headSha || lineage.events.some((e) => e.event === "merge" && e.pr === pr!.number);
    if (already || !ws.store.hasBranch(lineage.parent!)) continue;
    const result = manualMerge(ws, lineage.branch, lineage.parent!, pr.number, pr.headSha);
    report.merged.push({ branch: lineage.branch, into: lineage.parent!, pr: pr.number, result });
    log.info(["github", "merge"], "Merged map for merged PR", { branch: lineage.branch, into: lineage.parent, pr: pr.number });
  }

  mkdirSync(ws.cacheDir, { recursive: true });
  writeFileSync(stamp, JSON.stringify({ at: Date.now() }));
  return report;
}
