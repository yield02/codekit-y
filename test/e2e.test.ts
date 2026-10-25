import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, listPlans, lookup, savePlan, writeMap } from "../src/core/codemap.js";
import { buildContextText } from "../src/core/context.js";
import { handlePostToolUse, handleSessionStart, handleStop } from "../src/core/hooks.js";
import { formatLineageTree, readLineage } from "../src/core/lineage.js";
import { parseMapFile } from "../src/core/mapfile.js";
import { mapPathFor } from "../src/core/paths.js";
import { manualMerge, sync } from "../src/core/sync.js";
import { createFixture, MAP_BODY, sh, writeSource, type Fixture } from "./helpers.js";

for (const backend of ["git", "folder"] as const) {
  describe(`end to end (${backend} backend)`, () => {
    let fx: Fixture;
    afterEach(() => fx?.cleanup());

    it("leaves the source repo clean after init", () => {
      fx = createFixture(backend);
      expect(sh(fx.source, "status", "--porcelain")).toBe("");
      const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: fx.source, encoding: "utf8" }).trim();
      expect(exclude).toBeTruthy();
    });

    it("writes maps lazily and reports missing/stale", () => {
      fx = createFixture(backend);
      const ws = fx.ws();
      sync(ws);
      expect(lookup(ws, ["src/auth/login.ts"])[0]!.status).toBe("missing");

      writeMap(ws, { path: "src/auth/login.ts", body: MAP_BODY, dependsOn: ["src/auth/token.ts"], tags: ["auth"] });
      const [entry] = lookup(ws, ["src/auth/login.ts"]);
      expect(entry!.status).toBe("ok");
      expect(entry!.map!.meta.dependsOn).toEqual(["src/auth/token.ts"]);
      expect(entry!.map!.meta.updatedBy).toBe("Test Dev (test)");

      writeSource(fx.source, "src/auth/login.ts", "export function login() { return false; }\n");
      expect(lookup(ws, ["src/auth/login.ts"])[0]!.status).toBe("stale");

      const index = buildIndex(ws);
      expect(index.coverage).toEqual({ mapped: 1, total: 3, percent: 33 });
      expect(sh(fx.source, "status", "--porcelain")).toBe("M src/auth/login.ts"); // only the user's own edit
    });

    it("creates a branch map from its parent, records lineage, and merges back", () => {
      fx = createFixture(backend);
      const main = fx.ws();
      sync(main);
      writeMap(main, { path: "src/auth/login.ts", body: MAP_BODY, tags: ["auth"] });

      // Developer checks out a feature branch from main.
      sh(fx.source, "checkout", "-q", "-b", "feature/login-otp");
      const feature = fx.ws();
      const report = sync(feature);
      expect(report.created).toEqual({ branch: "feature/login-otp", parent: "main" });
      expect(lookup(feature, ["src/auth/login.ts"])[0]!.status).toBe("ok"); // copied from main
      const lineage = readLineage(feature.store, "feature/login-otp")!;
      expect(lineage.parent).toBe("main");
      expect(lineage.baseCommit).toBe(sh(fx.source, "rev-parse", "main"));

      // Work on the branch: new file + map.
      writeSource(fx.source, "src/auth/otp.ts", "export function sendOtp() {}\n");
      writeMap(feature, { path: "src/auth/otp.ts", body: MAP_BODY, tags: ["auth"] });
      savePlan(feature, "Login with OTP", "# Plan\n- step 1\n");
      sh(fx.source, "add", "-A");
      sh(fx.source, "commit", "-q", "-m", "otp");
      expect(lookup(main, ["src/auth/otp.ts"])[0]!.status).toBe("missing"); // main's map untouched

      // Merge the feature into main in the source repo.
      sh(fx.source, "checkout", "-q", "main");
      sh(fx.source, "merge", "-q", "--no-ff", "feature/login-otp", "-m", "merge otp");
      const mainAfter = fx.ws();
      const r = sync(mainAfter);
      expect(r.merged.map((m) => [m.branch, m.into])).toEqual([["feature/login-otp", "main"]]);
      expect(lookup(mainAfter, ["src/auth/otp.ts"])[0]!.status).toBe("ok");
      expect(listPlans(mainAfter).some((p) => p.endsWith("login-with-otp.md"))).toBe(true);

      const tree = formatLineageTree(mainAfter.store, "feature/login-otp");
      expect(tree).toContain("feature/login-otp");
      expect(tree).toContain("merged into main");

      // Running sync again is a no-op.
      const again = sync(fx.ws());
      expect(again.merged).toEqual([]);
    });

    it("resolves map conflicts against the merged source", () => {
      fx = createFixture(backend);
      const main = fx.ws();
      sync(main);
      writeMap(main, { path: "src/auth/login.ts", body: MAP_BODY });

      sh(fx.source, "checkout", "-q", "-b", "feature/a");
      const fa = fx.ws();
      sync(fa);
      // Feature rewrites login.ts and its map.
      writeSource(fx.source, "src/auth/login.ts", "export function login() { return 'feature'; }\n");
      writeMap(fa, { path: "src/auth/login.ts", body: MAP_BODY.replace("Login.", "Feature login.") });
      // And edits token.ts map without matching source on main later.
      writeMap(fa, { path: "src/auth/token.ts", body: MAP_BODY.replace("Login.", "Token (feature).") });
      sh(fx.source, "commit", "-qam", "feature login");

      // Meanwhile main documents token.ts differently and changes its source.
      sh(fx.source, "checkout", "-q", "main");
      writeSource(fx.source, "src/auth/token.ts", "export const TOKEN_TTL = 120;\n");
      sh(fx.source, "commit", "-qam", "ttl");
      const m2 = fx.ws();
      writeMap(m2, { path: "src/auth/token.ts", body: MAP_BODY.replace("Login.", "Token (main).") });

      sh(fx.source, "merge", "-q", "--no-ff", "feature/a", "-m", "merge a");
      sync(fx.ws());
      const after = fx.ws();
      const login = parseMapFile(after.store.read("main", mapPathFor("src/auth/login.ts"))!)!;
      expect(login.body).toContain("Feature login."); // only the feature changed it
      const token = parseMapFile(after.store.read("main", mapPathFor("src/auth/token.ts"))!)!;
      expect(token.body).toContain("Token (main)."); // main's map matches the merged source (ttl 120)
      expect(token.meta.stale).toBe(false);
    });

    it("syncs the parent's map into a branch after main is merged into it", () => {
      fx = createFixture(backend);
      sync(fx.ws());
      sh(fx.source, "checkout", "-q", "-b", "feature/b");
      sync(fx.ws());

      sh(fx.source, "checkout", "-q", "main");
      writeSource(fx.source, "src/db/order.repo.ts", "export function findOrder() {}\n");
      sh(fx.source, "add", "-A");
      sh(fx.source, "commit", "-qm", "orders");
      const m = fx.ws();
      writeMap(m, { path: "src/db/order.repo.ts", body: MAP_BODY });

      sh(fx.source, "checkout", "-q", "feature/b");
      sh(fx.source, "merge", "-q", "--no-ff", "main", "-m", "sync main");
      const fb = fx.ws();
      const r = sync(fb);
      expect(r.synced.map((s) => s.from)).toEqual(["main"]);
      expect(lookup(fb, ["src/db/order.repo.ts"])[0]!.status).toBe("ok");
      expect(readLineage(fb.store, "feature/b")!.events.some((e) => e.event === "sync")).toBe(true);
    });

    it("supports manual merges for squash merges", () => {
      fx = createFixture(backend);
      sync(fx.ws());
      sh(fx.source, "checkout", "-q", "-b", "feature/squash");
      const f = fx.ws();
      sync(f);
      writeSource(fx.source, "src/pay.ts", "export const pay = 1;\n");
      writeMap(f, { path: "src/pay.ts", body: MAP_BODY });
      sh(fx.source, "add", "-A");
      sh(fx.source, "commit", "-qm", "pay");
      sh(fx.source, "checkout", "-q", "main");
      sh(fx.source, "merge", "-q", "--squash", "feature/squash");
      sh(fx.source, "commit", "-qm", "squashed");
      const m = fx.ws();
      expect(sync(m).merged).toEqual([]); // squash is invisible to ancestry
      manualMerge(m, "feature/squash", "main", 42);
      expect(lookup(fx.ws(), ["src/pay.ts"])[0]!.status).toBe("ok");
      expect(readLineage(m.store, "feature/squash", "main")!.events.at(-1)!.pr).toBe(42);
    });

    it("hooks: session start injects context, stop blocks until maps are written", async () => {
      fx = createFixture(backend);
      const session = { session_id: "s-1", cwd: fx.source };
      const start = (await handleSessionStart(session)) as { hookSpecificOutput: { additionalContext: string } };
      expect(start.hookSpecificOutput.additionalContext).toContain('project "shop"');
      expect(start.hookSpecificOutput.additionalContext).toContain("Naming convention");

      handlePostToolUse({ ...session, tool_name: "Read", tool_input: { file_path: `${fx.source}/src/auth/login.ts` } });
      handlePostToolUse({ ...session, tool_name: "Read", tool_input: { file_path: `${fx.source}/package-lock.json` } }); // excluded
      const blocked = handleStop(session) as { decision: string; reason: string };
      expect(blocked.decision).toBe("block");
      expect(blocked.reason).toContain("src/auth/login.ts (missing)");
      expect(blocked.reason).not.toContain("package-lock.json");
      expect(handleStop({ ...session, stop_hook_active: true })).toBeNull();

      writeMap(fx.ws(), { path: "src/auth/login.ts", body: MAP_BODY });
      expect(handleStop(session)).toBeNull();
    });

    it("hooks are no-ops for unregistered repos", async () => {
      fx = createFixture(backend);
      sh(fx.source, "remote", "set-url", "origin", "https://github.com/someone/else.git");
      expect(await handleSessionStart({ session_id: "x", cwd: fx.source })).toBeNull();
      expect(handleStop({ session_id: "x", cwd: fx.source })).toBeNull();
    });

    it("context text summarizes coverage and rules", () => {
      fx = createFixture(backend);
      const ws = fx.ws();
      sync(ws);
      const text = buildContextText(ws);
      expect(text).toContain("Coverage: 0/3");
      expect(text).toContain("Never add AI files to the source repo");
    });
  });
}
