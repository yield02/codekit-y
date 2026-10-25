import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "./codemap.js";
import { formatLineageTree } from "./lineage.js";
import { normalizeBranch } from "./paths.js";
import { readBranchMaps } from "./report.js";
import type { Workspace } from "./workspace.js";

// Self-contained static HTML viewer for one branch's map: search, detail pane and
// a dependency graph. Written to the user cache, never into the source repo.

export interface ViewData {
  project: string;
  branch: string;
  generatedAt: string;
  coverage: { mapped: number; total: number; percent: number };
  lineage: string;
  maps: { path: string; tags: string[]; dependsOn: string[]; body: string; stale: boolean; updatedAt: string; updatedBy: string }[];
}

export function collectViewData(ws: Workspace): ViewData {
  const index = buildIndex(ws);
  const maps = [...readBranchMaps(ws, ws.branch).values()].map((m) => ({
    path: m.meta.path,
    tags: m.meta.tags,
    dependsOn: m.meta.dependsOn,
    body: m.body,
    stale: m.meta.stale,
    updatedAt: m.meta.updatedAt,
    updatedBy: m.meta.updatedBy,
  }));
  return {
    project: ws.project.name,
    branch: ws.branch,
    generatedAt: new Date().toISOString(),
    coverage: index.coverage,
    lineage: formatLineageTree(ws.store, ws.branch),
    maps: maps.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function writeView(ws: Workspace): string {
  const dir = join(ws.cacheDir, normalizeBranch(ws.branch));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "view.html");
  writeFileSync(file, renderViewHtml(collectViewData(ws)));
  return file;
}

export function renderViewHtml(data: ViewData): string {
  // `</script>` inside map text must not end the data block.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codemap — ${escapeHtml(data.project)}</title>
<style>
:root { --bg:#fbfbfa; --panel:#ffffff; --text:#1d1f23; --muted:#62666d; --border:#e3e4e6; --accent:#2f6fde; --warn:#b4540a; --node:#9aa3b2; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171a; --panel:#1d2024; --text:#e7e8ea; --muted:#9a9fa7; --border:#30343a; --accent:#6ea0ff; --warn:#f0a35c; --node:#5d6573; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; gap:8px 24px; align-items:baseline; }
header h1 { font-size:18px; margin:0; }
header .meta { color:var(--muted); }
main { display:grid; grid-template-columns: minmax(240px, 340px) 1fr; min-height: calc(100vh - 60px); }
aside { border-right:1px solid var(--border); padding:12px; overflow:auto; max-height: calc(100vh - 60px); }
input[type=search] { width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); font:inherit; }
ul.files { list-style:none; margin:10px 0 0; padding:0; }
ul.files li { padding:6px 8px; border-radius:6px; cursor:pointer; word-break:break-all; }
ul.files li:hover, ul.files li.active { background:var(--panel); outline:1px solid var(--border); }
.tag { display:inline-block; font-size:12px; padding:0 6px; margin:2px 4px 0 0; border-radius:10px; border:1px solid var(--border); color:var(--muted); }
.stale { color:var(--warn); font-size:12px; }
section { padding:16px 20px; overflow:auto; }
.detail { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px; }
.detail h2 { font-size:16px; margin:0 0 4px; word-break:break-all; }
.detail h3 { font-size:14px; margin:14px 0 4px; }
.detail code { font-family: ui-monospace, Consolas, monospace; font-size:13px; }
a.dep { color:var(--accent); cursor:pointer; text-decoration:none; }
svg { width:100%; height:420px; background:var(--panel); border:1px solid var(--border); border-radius:8px; }
svg line { stroke:var(--border); }
svg circle { fill:var(--node); cursor:pointer; }
svg circle.on { fill:var(--accent); }
svg text { fill:var(--muted); font-size:10px; pointer-events:none; }
pre.lineage { white-space:pre-wrap; color:var(--muted); font-size:12px; }
@media (max-width: 720px) { main { grid-template-columns: 1fr; } aside { border-right:0; border-bottom:1px solid var(--border); max-height:40vh; } }
</style>
</head>
<body>
<header>
  <h1>codemap · ${escapeHtml(data.project)}</h1>
  <span class="meta">branch <b>${escapeHtml(data.branch)}</b> · ${data.coverage.mapped}/${data.coverage.total} files mapped (${data.coverage.percent}%) · generated ${escapeHtml(data.generatedAt.slice(0, 16).replace("T", " "))} UTC</span>
</header>
<main>
  <aside>
    <input type="search" id="q" placeholder="Search path, tag or text…" autofocus>
    <ul class="files" id="list"></ul>
  </aside>
  <section>
    <div class="detail" id="detail"><p class="meta">Select a file to see its map.</p></div>
    <svg id="graph" role="img" aria-label="Dependency graph"></svg>
    <pre class="lineage">${escapeHtml(data.lineage)}</pre>
  </section>
</main>
<script id="data" type="application/json">${json}</script>
<script>
const data = JSON.parse(document.getElementById("data").textContent);
const byPath = new Map(data.maps.map(m => [m.path, m]));
const usedBy = new Map();
for (const m of data.maps) for (const d of m.dependsOn) { if (!usedBy.has(d)) usedBy.set(d, []); usedBy.get(d).push(m.path); }
const esc = s => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function md(text) {
  const out = []; let list = null;
  for (const raw of text.split("\\n")) {
    const line = esc(raw).replace(/\`([^\`]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
    const li = /^\\s*(?:[-*]|\\d+\\.)\\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = /^\\s*\\d/.test(raw) ? "ol" : "ul"; out.push("<" + list + ">"); } out.push("<li>" + li[1] + "</li>"); continue; }
    if (list) { out.push("</" + list + ">"); list = null; }
    if (/^#{1,6}\\s/.test(raw)) out.push("<h3>" + line.replace(/^#+\\s*/, "") + "</h3>");
    else if (line.trim()) out.push("<p>" + line + "</p>");
  }
  if (list) out.push("</" + list + ">");
  return out.join("");
}
let selected = null;
function renderList() {
  const q = document.getElementById("q").value.toLowerCase().trim();
  const list = document.getElementById("list");
  list.innerHTML = "";
  for (const m of data.maps) {
    if (q && !(m.path.toLowerCase().includes(q) || m.tags.some(t => t.toLowerCase().includes(q)) || m.body.toLowerCase().includes(q))) continue;
    const li = document.createElement("li");
    li.innerHTML = esc(m.path) + (m.stale ? ' <span class="stale">stale</span>' : "") + "<br>" + m.tags.map(t => '<span class="tag">' + esc(t) + "</span>").join("");
    if (m.path === selected) li.className = "active";
    li.onclick = () => select(m.path);
    list.appendChild(li);
  }
}
function link(p) { return byPath.has(p) ? '<a class="dep" data-p="' + esc(p) + '">' + esc(p) + "</a>" : "<code>" + esc(p) + "</code>"; }
function select(path) {
  selected = path;
  const m = byPath.get(path);
  const el = document.getElementById("detail");
  if (!m) { el.innerHTML = "<h2>" + esc(path) + "</h2><p>No map yet.</p>"; return; }
  el.innerHTML = "<h2>" + esc(m.path) + "</h2>" +
    '<div class="meta">updated ' + esc(m.updatedAt) + " by " + esc(m.updatedBy) + (m.stale ? ' · <span class="stale">stale</span>' : "") + "</div>" +
    md(m.body) +
    "<h3>Depends on</h3>" + (m.dependsOn.map(link).join(", ") || "—") +
    "<h3>Used by</h3>" + ((usedBy.get(m.path) || []).map(link).join(", ") || "—");
  el.querySelectorAll("a.dep").forEach(a => a.onclick = () => select(a.dataset.p));
  renderList(); highlight();
}
document.getElementById("q").addEventListener("input", renderList);

// Small force-directed layout of the dependsOn graph.
const svg = document.getElementById("graph");
const W = () => svg.clientWidth || 800, H = 420;
const names = new Set(data.maps.map(m => m.path));
for (const m of data.maps) m.dependsOn.forEach(d => names.add(d));
const nodes = [...names].map((p, i) => ({ p, x: Math.cos(i) * 150 + 400, y: Math.sin(i) * 150 + 210, vx: 0, vy: 0 }));
const idx = new Map(nodes.map((n, i) => [n.p, i]));
const edges = data.maps.flatMap(m => m.dependsOn.map(d => [idx.get(m.path), idx.get(d)]));
for (let step = 0; step < 300; step++) {
  for (const a of nodes) for (const b of nodes) { if (a === b) continue; const dx = a.x - b.x, dy = a.y - b.y, d2 = dx*dx + dy*dy + 0.01, f = 900 / d2; a.vx += dx * f; a.vy += dy * f; }
  for (const [i, j] of edges) { const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y; a.vx += dx * 0.01; a.vy += dy * 0.01; b.vx -= dx * 0.01; b.vy -= dy * 0.01; }
  for (const n of nodes) { n.vx += (W() / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002; n.x += n.vx * 0.5; n.y += n.vy * 0.5; n.vx *= 0.6; n.vy *= 0.6; n.x = Math.max(20, Math.min(W() - 20, n.x)); n.y = Math.max(20, Math.min(H - 20, n.y)); }
}
const NS = "http://www.w3.org/2000/svg";
for (const [i, j] of edges) { const l = document.createElementNS(NS, "line"); l.setAttribute("x1", nodes[i].x); l.setAttribute("y1", nodes[i].y); l.setAttribute("x2", nodes[j].x); l.setAttribute("y2", nodes[j].y); svg.appendChild(l); }
const circles = nodes.map(n => {
  const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", n.x); c.setAttribute("cy", n.y); c.setAttribute("r", byPath.has(n.p) ? 6 : 4);
  const t = document.createElementNS(NS, "title"); t.textContent = n.p; c.appendChild(t); c.onclick = () => select(n.p); svg.appendChild(c);
  const label = document.createElementNS(NS, "text"); label.setAttribute("x", n.x + 8); label.setAttribute("y", n.y + 3); label.textContent = n.p.split("/").pop(); svg.appendChild(label);
  return [n.p, c];
});
function highlight() { for (const [p, c] of circles) c.setAttribute("class", p === selected ? "on" : ""); }
renderList();
if (data.maps[0]) select(data.maps[0].path);
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
