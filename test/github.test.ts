import { afterEach, describe, expect, it } from "vitest";
import { lookup, writeMap } from "../src/core/codemap.js";
import { detectPrMerges, githubTarget, type FetchLike } from "../src/core/github.js";
import { readLineage } from "../src/core/lineage.js";
import { sync } from "../src/core/sync.js";
import type { Workspace } from "../src/core/workspace.js";
import { createFixture, MAP_BODY, sh, writeSource, type Fixture } from "./helpers.js";

function fakeGitHub(pulls: unknown[]): { fetchImpl: FetchLike; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => pulls };
  };
  return { fetchImpl, calls };
}

/** Point the workspace at a GitHub Enterprise-style API so the local test remote qualifies. */
function withApi(ws: Workspace): Workspace {
  return { ...ws, config: { ...ws.config, github: { ...ws.config.github, apiUrl: "https://ghe.example/api/v3" } } };
}

describe("github target", () => {
  it("derives the API from the remote", () => {
    expect(githubTarget("git@github.com:Acme/Shop.git")).toEqual({ apiUrl: "https://api.github.com", owner: "acme", repo: "shop" });
    expect(githubTarget("https://gitlab.com/a/b.git")).toBeNull();
    expect(githubTarget("https://ghe.corp/a/b.git", "https://ghe.corp/api/v3/")).toEqual({ apiUrl: "https://ghe.corp/api/v3", owner: "a", repo: "b" });
  });
});

describe("squash-merged PRs (GitHub API, read-only)", () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it("merges the map of a squash-merged PR exactly once, using GET only", async () => {
    fx = createFixture("folder");
    sync(fx.ws());
    sh(fx.source, "checkout", "-q", "-b", "feature/sq");
    const f = fx.ws();
    sync(f);
    writeSource(fx.source, "src/pay.ts", "export const pay = 1;\n");
    writeMap(f, { path: "src/pay.ts", body: MAP_BODY });
    sh(fx.source, "add", "-A");
    sh(fx.source, "commit", "-qm", "pay");
    const headSha = sh(fx.source, "rev-parse", "HEAD");
    sh(fx.source, "checkout", "-q", "main");
    sh(fx.source, "merge", "-q", "--squash", "feature/sq");
    sh(fx.source, "commit", "-qm", "squash");

    const main = withApi(fx.ws());
    expect(sync(main).merged).toEqual([]);
    const gh = fakeGitHub([
      { number: 7, merged_at: "2026-10-25T10:00:00Z", head: { ref: "feature/sq", sha: headSha }, base: { ref: "main" } },
      { number: 6, merged_at: null, head: { ref: "feature/sq", sha: "old" }, base: { ref: "main" } },
    ]);
    const report = await detectPrMerges(main, { fetchImpl: gh.fetchImpl, token: "t0ken", force: true });
    expect(report.merged.map((m) => [m.branch, m.into, m.pr])).toEqual([["feature/sq", "main", 7]]);
    expect(lookup(fx.ws(), ["src/pay.ts"])[0]!.status).toBe("ok");
    expect(readLineage(main.store, "feature/sq")!.lastMergedCommit).toBe(headSha);

    expect(gh.calls[0]!.url).toContain("/repos/");
    expect(gh.calls[0]!.url).toContain("state=closed");
    expect(gh.calls[0]!.headers.Authorization).toBe("Bearer t0ken");
    expect(Object.keys(gh.calls[0]!).includes("method")).toBe(false);

    const again = await detectPrMerges(main, { fetchImpl: gh.fetchImpl, force: true });
    expect(again.merged).toEqual([]);
  });

  it("respects the check interval and the enabled flag", async () => {
    fx = createFixture("folder");
    sync(fx.ws());
    sh(fx.source, "checkout", "-q", "-b", "feature/t");
    sync(fx.ws());
    const ws = withApi(fx.ws());
    const gh = fakeGitHub([]);
    await detectPrMerges(ws, { fetchImpl: gh.fetchImpl, force: true });
    const second = await detectPrMerges(ws, { fetchImpl: gh.fetchImpl });
    expect(second.skipped).toBe("checked recently");
    const disabled = { ...ws, config: { ...ws.config, github: { ...ws.config.github, enabled: false } } };
    expect((await detectPrMerges(disabled, { fetchImpl: gh.fetchImpl, force: true })).skipped).toContain("disabled");
  });
});
