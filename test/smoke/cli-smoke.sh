#!/usr/bin/env bash
# End-to-end smoke test of the built CLI on a real POSIX system (used by CI on stock Ubuntu).
# Git backend store, branch detection, push guard, artifact guard, pre-push/pre-commit hooks.
set -euo pipefail

K="$(cd "$(dirname "$0")/../.." && pwd)/dist/cli"
T="$(mktemp -d)"
# Git Bash on Windows: JSON payloads are not path-converted, so use a native path there.
if command -v cygpath >/dev/null 2>&1; then T="$(cygpath -m "$T")"; fi
export CODEKIT_HOME="$T/home"
export GIT_AUTHOR_NAME=CI GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=CI GIT_COMMITTER_EMAIL=ci@example.com
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT AI_AGENT CURSOR_AGENT CODEKIT_AGENT || true

step() { printf '\n== %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

git --version
node --version

step "source repo + bare remotes"
git init -q --bare "$T/store.git"
git init -q --bare "$T/src.git"
git clone -q "$T/src.git" "$T/src" 2>/dev/null
cd "$T/src"
git checkout -q -b main
mkdir -p src && printf 'export const a = 1;\n' > src/a.ts
git add -A && git commit -qm init && git push -q -u origin main

step "project create + init (git backend)"
node "$K/codekit.js" project create demo --backend git --url "$T/store.git"
node "$K/codekit.js" init --project demo --backend git --url "$T/store.git" -C "$T/src"
[ -x "$T/src/.git/hooks/pre-push" ] || fail "pre-push hook missing or not executable"
[ -x "$T/src/.git/hooks/pre-commit" ] || fail "pre-commit hook missing or not executable"
[ -z "$(git -C "$T/src" status --porcelain)" ] || fail "source repo not clean after init"

step "sync: root map, then a feature branch from main"
node "$K/codemap.js" -C "$T/src" sync
git -C "$T/src" checkout -q -b feature/x
node "$K/codemap.js" -C "$T/src" sync | tee "$T/sync.txt"
grep -q "created map from main" "$T/sync.txt" || fail "feature map not created from main"
git -C "$T/store.git" for-each-ref --format='%(refname:short)' | grep -q "maps/src/feature__x" || fail "map branch not pushed to the store"

step "PreToolUse: push and AI files are denied, normal work allowed"
hook() { printf '%s' "$1" | node "$K/codemap.js" hook pre-tool-use; }
hook "{\"cwd\":\"$T/src\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin feature/x\"}}" | grep -q '"permissionDecision":"deny"' || fail "git push not denied"
hook "{\"cwd\":\"$T/src\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$T/src/CLAUDE.md\"}}" | grep -q '"permissionDecision":"deny"' || fail "CLAUDE.md write not denied"
hook "{\"cwd\":\"$T/src\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"mkdir -p docs/plans && echo x > docs/plans/p.md\"}}" | grep -q deny || fail "docs/plans write not denied"
# (output captured first: macOS ships bash 3.2, which mis-parses nested quotes inside "$( )")
normal=$(hook "{\"cwd\":\"$T/src\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$T/src/src/b.ts\"}}")
[ -z "$normal" ] || fail "normal write denied: $normal"

step "pre-push hook: agent push rejected, developer push accepted"
if CLAUDECODE=1 git -C "$T/src" push -q origin feature/x 2>"$T/push.err"; then fail "agent push went through"; fi
grep -q "codekit: push blocked" "$T/push.err" || fail "unexpected pre-push output"
git -C "$T/src" push -q origin feature/x

step "pre-commit hook: agent commit of an AI file rejected"
printf '# rules\n' > "$T/src/CLAUDE.md"
git -C "$T/src" add CLAUDE.md
if CLAUDECODE=1 git -C "$T/src" commit -qm "agent rules" 2>"$T/commit.err"; then fail "agent commit of CLAUDE.md went through"; fi
grep -q "commit blocked" "$T/commit.err" || fail "unexpected pre-commit output"
git -C "$T/src" restore --staged CLAUDE.md && rm "$T/src/CLAUDE.md"

step "doctor"
node "$K/codekit.js" doctor -C "$T/src" || true

echo
echo "CLI smoke OK"
