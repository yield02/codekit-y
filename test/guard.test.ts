import { describe, expect, it } from "vitest";
import { checkMcpTool, checkShellCommand, commandTargetDirs } from "../src/core/guard.js";

const blocked = (cmd: string, aliases?: Record<string, string>) => checkShellCommand(cmd, { gitAliases: aliases }).blocked;

describe("shell guard: blocks every way of publishing to the remote", () => {
  it.each([
    "git push",
    "git push origin main",
    "git push --force-with-lease",
    "git push --no-verify",
    "  git   push",
    "git -C ../shop push",
    "git -c user.name=x push origin",
    "git --no-pager push",
    "/usr/bin/git push",
    "C:\\Program Files\\Git\\cmd\\git.exe push",
    '"git" push',
    "git.exe push",
    "FOO=1 git push",
    "sudo git push",
    "env -i git push",
    "git add -A && git commit -m x && git push",
    "git commit -m x; git push",
    "git status || git push",
    "echo x | git push",
    "git status & git push",
    "& git push origin main",
    "git subtree push --prefix dist origin gh-pages",
    "git lfs push origin main",
    "git send-pack ../remote main",
    "bash -c 'git push'",
    'powershell -Command "git push"',
    'pwsh -c "cd x; git push"',
    "cmd /c git push",
    "eval 'git push'",
    "Invoke-Expression 'git push'",
    "echo $(git push)",
    "(git push)",
    "git config alias.p push",
    "git config --global alias.up '!git push'",
    "git -c alias.p=push p",
    "gh pr create --fill",
    "gh pr merge 12 --squash",
    "gh pr comment 3 -b hi",
    "gh repo fork",
    "gh release create v1",
    "gh workflow run deploy.yml",
    "gh api repos/a/b/pulls -f title=x",
    "gh api -X DELETE repos/a/b/git/refs/heads/x",
    "gh api --method=PUT repos/a/b/pulls/1/merge",
    "curl -X POST https://api.github.com/repos/a/b/pulls -d '{}'",
    "curl --data '{}' https://api.github.com/repos/a/b/git/refs",
    "Invoke-RestMethod -Method Post -Uri https://api.github.com/repos/a/b/pulls",
    "hub push",
    "powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==",
  ])("blocks: %s", (cmd) => {
    expect(blocked(cmd)).toBe(true);
  });

  it("blocks existing aliases that push", () => {
    expect(blocked("git p", { p: "push" })).toBe(true);
    expect(blocked("git ship", { ship: "!git add -A && git push" })).toBe(true);
    expect(blocked("git co main", { co: "checkout" })).toBe(false);
  });
});

describe("shell guard: allows reading and local commits", () => {
  it.each([
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git add -A && git commit -m 'feat: push notifications'",
    "git commit -m \"push later\"",
    "git checkout -b feature/x",
    "git merge main",
    "git rebase main",
    "git fetch origin",
    "git pull --rebase",
    "git stash push -m wip",
    "git remote -v",
    "git log --grep push",
    "gh pr list",
    "gh pr view 12",
    "gh pr diff 12",
    "gh api repos/a/b/pulls",
    "curl https://api.github.com/repos/a/b",
    "curl -X POST http://localhost:3000/push",
    "npm test",
    "echo 'remember to git push'",
    "Get-ChildItem | Select-Object -First 3",
    "node dist/cli/codemap.js sync",
  ])("allows: %s", (cmd) => {
    expect(blocked(cmd)).toBe(false);
  });
});

describe("shell guard: scripts", () => {
  const scripts: Record<string, string> = { "deploy.sh": "npm run build\ngit push origin main\n", "ok.sh": "npm test\n", "x.ps1": "git commit -am x; git push" };
  const readScript = (p: string) => scripts[p.replace(/^\.\//, "")] ?? null;
  it("checks the content of scripts run through a shell", () => {
    expect(checkShellCommand("bash deploy.sh", { readScript }).blocked).toBe(true);
    expect(checkShellCommand("sh ./deploy.sh", { readScript }).blocked).toBe(true);
    expect(checkShellCommand("./deploy.sh", { readScript }).blocked).toBe(true);
    expect(checkShellCommand("pwsh -File x.ps1", { readScript }).blocked).toBe(true);
    expect(checkShellCommand("bash ok.sh", { readScript }).blocked).toBe(false);
  });
});

describe("MCP guard", () => {
  it("blocks code-host write tools", () => {
    for (const t of [
      "mcp__github__push_files",
      "mcp__github__create_pull_request",
      "mcp__github__merge_pull_request",
      "mcp__github__create_or_update_file",
      "mcp__github__delete_file",
      "mcp__github__create_branch",
      "mcp__plugin_github_github__create_pull_request",
      "mcp__gitlab__create_merge_request",
    ]) expect(checkMcpTool(t).blocked, t).toBe(true);
  });
  it("allows reads, other servers and explicit allow-list entries", () => {
    expect(checkMcpTool("mcp__github__get_file_contents").blocked).toBe(false);
    expect(checkMcpTool("mcp__github__list_pull_requests").blocked).toBe(false);
    expect(checkMcpTool("mcp__serena__replace_symbol_body").blocked).toBe(false);
    expect(checkMcpTool("mcp__plugin_codekit_codemap__codemap_write").blocked).toBe(false);
    expect(checkMcpTool("mcp__github__add_issue_comment", ["mcp__github__add_issue_comment"]).blocked).toBe(false);
  });
});

describe("command target dirs", () => {
  it("finds cd / git -C targets", () => {
    expect(commandTargetDirs("cd ../shop && git push")).toEqual(["../shop"]);
    expect(commandTargetDirs("git -C D:/src/shop push")).toEqual(["D:/src/shop"]);
    expect(commandTargetDirs("Set-Location D:\\src\\shop; git push")).toEqual(["D:\\src\\shop"]);
  });
});
