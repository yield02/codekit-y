import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { writeMap } from "../src/core/codemap.js";
import { formatReportMarkdown, projectReport } from "../src/core/report.js";
import { sync } from "../src/core/sync.js";
import { collectViewData, renderViewHtml, writeView } from "../src/core/view.js";
import { createFixture, MAP_BODY, sh, writeSource, type Fixture } from "./helpers.js";

describe("report and view", () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it("reports coverage per branch from committed source", () => {
    fx = createFixture("git");
    const main = fx.ws();
    sync(main);
    writeMap(main, { path: "src/auth/login.ts", body: MAP_BODY, tags: ["auth"] });
    writeMap(main, { path: "src/auth/token.ts", body: MAP_BODY });

    sh(fx.source, "checkout", "-q", "-b", "feature/r");
    sync(fx.ws());
    // Committed change on the feature makes token.ts stale there; uncommitted edits do not count.
    writeSource(fx.source, "src/auth/token.ts", "export const TOKEN_TTL = 5;\n");
    sh(fx.source, "commit", "-qam", "ttl");
    writeSource(fx.source, "src/auth/login.ts", "// uncommitted\n");

    const report = projectReport(fx.ws());
    const [mainReport, featureReport] = report.branches;
    expect(mainReport!.branch).toBe("main");
    expect([mainReport!.mapped, mainReport!.total, mainReport!.percent]).toEqual([2, 3, 67]);
    expect(mainReport!.missing).toEqual(["src/db/user.repo.ts"]);
    expect(featureReport!.branch).toBe("feature/r");
    expect(featureReport!.parent).toBe("main");
    expect(featureReport!.stale).toEqual([{ path: "src/auth/token.ts", reason: "source changed" }]);

    const md = formatReportMarkdown(report);
    expect(md).toContain("| `main` | — | 2/3 (67%) | 1 | 0 |");
    expect(md).toContain("- `src/auth/token.ts` (source changed)");
  });

  it("renders a self-contained viewer that cannot be broken by map text", () => {
    fx = createFixture("folder");
    const ws = fx.ws();
    sync(ws);
    writeMap(ws, { path: "src/auth/login.ts", body: MAP_BODY + "\n</script><script>alert(1)</script>", dependsOn: ["src/auth/token.ts"], tags: ["auth"] });
    const data = collectViewData(ws);
    expect(data.maps).toHaveLength(1);
    expect(data.coverage.mapped).toBe(1);
    const html = renderViewHtml(data);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
    const file = writeView(ws);
    expect(file).toContain(fx.home);
    expect(readFileSync(file, "utf8")).toContain("codemap · shop");
    expect(sh(fx.source, "status", "--porcelain")).toBe("");
  });
});
