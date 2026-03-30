#!/usr/bin/env node
// Generates a self-contained HTML cost dashboard from token-usage.ndjson files.
//
// Usage:
//   node dashboard-html.js                        → writes dashboard.html
//   node dashboard-html.js --out=report.html
//   node dashboard-html.js --log=apps/.../token-usage.ndjson
//   node dashboard-html.js --since=2026-03-01
"use strict";

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Pricing (approx) — verify at https://ai.google.dev/pricing
// ---------------------------------------------------------------------------
const PRICING = {
  "gemini-2.0-flash":         { inputPer1M: 0.075, outputPer1M: 0.30 },
  "gemini-2.0-flash-lite":    { inputPer1M: 0.018, outputPer1M: 0.075 },
  "gemini-1.5-flash":         { inputPer1M: 0.075, outputPer1M: 0.30 },
  "gemini-1.5-pro":           { inputPer1M: 1.25,  outputPer1M: 5.00 },
};
const DEFAULT_PRICING = { inputPer1M: 0.075, outputPer1M: 0.30 };

function getPricing(model) {
  const key = Object.keys(PRICING).find(k => model && model.startsWith(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

function calcCost(e) {
  const p = getPricing(e.model);
  return (e.prompt / 1_000_000) * p.inputPer1M + (e.output / 1_000_000) * p.outputPer1M;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function findLogFiles(baseDir) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (["node_modules", ".git", "dist"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name === "token-usage.ndjson") results.push(full);
    }
  }
  walk(baseDir, 0);
  return results;
}

function readEntries(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8")
      .split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argMap = {};
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq === -1) argMap[a.slice(2)] = true;
    else argMap[a.slice(2, eq)] = a.slice(eq + 1);
  }
}

const filterSince = argMap.since ? new Date(argMap.since) : undefined;
const outFile     = argMap.out   || "dashboard.html";

let logFiles = argMap.log ? [argMap.log] : findLogFiles(process.cwd());
if (logFiles.length === 0) { console.error("No token-usage.ndjson found."); process.exit(1); }

let entries = logFiles.flatMap(readEntries);
if (filterSince) entries = entries.filter(e => new Date(e.ts) >= filterSince);
if (entries.length === 0) { console.log("No entries match filters."); process.exit(0); }

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
const byRun = new Map();
for (const e of entries) {
  if (!byRun.has(e.runId)) {
    byRun.set(e.runId, {
      runId: e.runId, app: e.app || null, profile: e.profile || null,
      url: e.url, model: e.model, firstTs: e.ts,
      interrupted: e.runId.endsWith("-interrupted"),
      roles: [], totalPrompt: 0, totalOutput: 0, totalCached: 0, totalTokens: 0, totalCost: 0,
    });
  }
  const run  = byRun.get(e.runId);
  const cost = calcCost(e);
  run.roles.push({ role: e.role, prompt: e.prompt, output: e.output, cached: e.cached, total: e.total, cost });
  run.totalPrompt  += e.prompt;
  run.totalOutput  += e.output;
  run.totalCached  += e.cached;
  run.totalTokens  += e.total;
  run.totalCost    += cost;
}

const byApp = new Map();
for (const e of entries) {
  const appKey = e.app || (() => { try { return new URL(e.url).host; } catch { return e.url; } })();
  if (!byApp.has(appKey)) {
    byApp.set(appKey, { app: appKey, prompt: 0, output: 0, cached: 0, total: 0, cost: 0, runIds: new Set(), roleExecs: 0, envs: new Set() });
  }
  const a = byApp.get(appKey);
  a.prompt    += e.prompt;  a.output  += e.output;
  a.cached    += e.cached;  a.total   += e.total;
  a.cost      += calcCost(e);
  a.runIds.add(e.runId);    a.roleExecs++;
  if (e.url) { try { a.envs.add(new URL(e.url).host); } catch { a.envs.add(e.url); } }
}

const lifetime = entries.reduce((acc, e) => {
  acc.prompt += e.prompt; acc.output += e.output;
  acc.cached += e.cached; acc.total  += e.total;
  acc.cost   += calcCost(e);
  return acc;
}, { prompt: 0, output: 0, cached: 0, total: 0, cost: 0 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmt  = n   => Number(n).toLocaleString("en-GB");
const fmtC = usd => `$${usd.toFixed(4)}`;
const esc  = s   => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const runs    = Array.from(byRun.values()).sort((a, b) => b.firstTs.localeCompare(a.firstTs));
const appList = Array.from(byApp.values()).sort((a, b) => b.cost - a.cost);
const maxCost = Math.max(...appList.map(a => a.cost), 0.0001);

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------
function barSvg(value, max, width = 120, height = 16) {
  const w = Math.round((value / max) * width);
  return `<svg width="${width}" height="${height}" style="vertical-align:middle">` +
    `<rect width="${width}" height="${height}" rx="3" fill="#e5e7eb"/>` +
    `<rect width="${w}" height="${height}" rx="3" fill="#6366f1"/>` +
    `</svg>`;
}

function appRows() {
  return appList.map(a => {
    const envs = Array.from(a.envs).join(", ");
    return `
    <tr>
      <td class="bold">${esc(a.app)}</td>
      <td class="num">${a.runIds.size}</td>
      <td class="num">${a.roleExecs}</td>
      <td class="num">${fmt(a.prompt)}</td>
      <td class="num">${fmt(a.output)}</td>
      <td class="num bold">${fmt(a.total)}</td>
      <td class="num cost-cell">${fmtC(a.cost)}</td>
      <td>${barSvg(a.cost, maxCost)} <span class="dim">${esc(envs)}</span></td>
    </tr>`;
  }).join("");
}

function runRows() {
  return runs.map((run, i) => {
    const host = (() => { try { return new URL(run.url).host; } catch { return run.url; } })();
    const ts   = run.runId.replace("T", " ").replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ".$3Z").replace(/-/g,":");
    const appLabel = run.app ? `<span class="tag">${esc(run.app)}</span>` : "";
    const intTag   = run.interrupted ? `<span class="tag tag-warn">interrupted</span>` : "";
    const detailId = `run-detail-${i}`;
    const roleRowsHtml = run.roles.map(r => `
      <tr class="role-row">
        <td class="pl-8 dim">↳ ${esc(r.role)}</td>
        <td class="num dim">${fmt(r.prompt)}</td>
        <td class="num dim">${fmt(r.output)}</td>
        <td class="num dim">${fmt(r.total)}</td>
        <td class="num dim">${fmtC(r.cost)}</td>
      </tr>`).join("");
    return `
    <tr class="run-header" onclick="toggle('${detailId}')">
      <td><span class="chevron" id="chev-${detailId}">▶</span> <code class="ts">${esc(run.runId)}</code> ${appLabel} ${intTag}</td>
      <td class="dim">${esc(host)}</td>
      <td class="num">${run.roles.length}</td>
      <td class="num">${fmt(run.totalPrompt)}</td>
      <td class="num">${fmt(run.totalOutput)}</td>
      <td class="num bold">${fmt(run.totalTokens)}</td>
      <td class="num cost-cell">${fmtC(run.totalCost)}</td>
    </tr>
    <tr id="${detailId}" class="detail-rows" style="display:none">
      <td colspan="7" style="padding:0">
        <table class="inner-table">
          <thead><tr><th>Role</th><th>Prompt</th><th>Output</th><th>Total</th><th>Cost</th></tr></thead>
          <tbody>${roleRowsHtml}</tbody>
        </table>
      </td>
    </tr>`;
  }).join("");
}

// Sparkline — one bar per run, ordered oldest→newest, grouped by app
function sparklines() {
  const appRuns = {};
  for (const run of [...runs].reverse()) {
    const key = run.app || "unknown";
    if (!appRuns[key]) appRuns[key] = [];
    appRuns[key].push(run);
  }
  const maxRunCost = Math.max(...runs.map(r => r.totalCost), 0.0001);
  return Object.entries(appRuns).map(([app, rs]) => {
    const bars = rs.map(r => {
      const h = Math.max(2, Math.round((r.totalCost / maxRunCost) * 40));
      const col = r.interrupted ? "#f59e0b" : "#6366f1";
      return `<rect x="0" y="${40 - h}" width="10" height="${h}" rx="2" fill="${col}" title="${esc(r.runId)}: ${fmtC(r.totalCost)}"/>`;
    });
    const svgW = rs.length * 13;
    return `
    <div class="spark-block">
      <div class="spark-label">${esc(app)}</div>
      <svg width="${svgW}" height="44" style="display:block">
        ${bars.map((b, i) => b.replace('x="0"', `x="${i * 13}"`)).join("")}
      </svg>
      <div class="dim" style="font-size:11px">${rs.length} run${rs.length !== 1 ? "s" : ""} · ${fmtC(rs.reduce((s, r) => s + r.totalCost, 0))}</div>
    </div>`;
  }).join("");
}

const generatedAt = new Date().toISOString();
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Explorer Cost Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; font-size: 14px; }
  a { color: #6366f1; }
  h1 { font-size: 20px; font-weight: 700; }
  h2 { font-size: 15px; font-weight: 600; color: #374151; margin-bottom: 12px; }
  .page { max-width: 1200px; margin: 0 auto; padding: 24px 20px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
  .header-meta { color: #64748b; font-size: 12px; margin-top: 4px; }
  .kpi-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 28px; }
  .kpi { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 130px; }
  .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; margin-bottom: 4px; }
  .kpi-val { font-size: 22px; font-weight: 700; color: #1e293b; }
  .kpi-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
  td { padding: 9px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .bold { font-weight: 600; }
  .dim { color: #94a3b8; }
  .cost-cell { font-weight: 600; color: #6366f1; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 9999px; font-size: 11px; background: #ede9fe; color: #6d28d9; margin-left: 6px; }
  .tag-warn { background: #fef3c7; color: #92400e; }
  code.ts { font-size: 12px; color: #64748b; }
  .run-header { cursor: pointer; }
  .run-header:hover td { background: #f8fafc; }
  .chevron { color: #94a3b8; font-size: 10px; display: inline-block; transition: transform .15s; }
  .chevron.open { transform: rotate(90deg); }
  .inner-table { width: 100%; border-collapse: collapse; border-top: 1px solid #f1f5f9; }
  .inner-table th { background: #f8fafc; font-size: 11px; padding: 6px 10px 6px 32px; color: #94a3b8; }
  .inner-table td { padding: 6px 10px 6px 32px; font-size: 13px; border-bottom: 1px solid #f8fafc; }
  .inner-table tr:last-child td { border-bottom: none; }
  .pl-8 { padding-left: 32px !important; }
  .spark-row { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 8px; }
  .spark-block { display: flex; flex-direction: column; gap: 4px; }
  .spark-label { font-size: 12px; font-weight: 600; color: #374151; }
  .notice { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #92400e; margin-bottom: 20px; }
  .filter-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
  .filter-bar input, .filter-bar select {
    border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px;
    font-size: 13px; background: #fff; color: #1e293b;
  }
  .filter-bar input:focus, .filter-bar select:focus { outline: 2px solid #6366f1; border-color: transparent; }
  @media (max-width: 700px) { .kpi-val { font-size: 18px; } .kpi { min-width: 100px; } }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div>
      <h1>🧪 Explorer Cost Dashboard</h1>
      <div class="header-meta">Generated ${generatedAt} · Prices approx (Gemini 2.0 Flash: $0.075/1M input, $0.30/1M output) · <a href="https://ai.google.dev/pricing" target="_blank">Verify at ai.google.dev/pricing</a></div>
    </div>
  </div>

  <div class="notice">⚠️ Cost estimates are approximate and based on public Gemini API pricing. Verify against your actual billing before invoicing clients.</div>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-label">Total Cost</div>
      <div class="kpi-val">${fmtC(lifetime.cost)}</div>
      <div class="kpi-sub">all time, all apps</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Tokens</div>
      <div class="kpi-val">${fmt(lifetime.total)}</div>
      <div class="kpi-sub">${fmt(lifetime.prompt)} prompt · ${fmt(lifetime.output)} output</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Runs</div>
      <div class="kpi-val">${byRun.size}</div>
      <div class="kpi-sub">${entries.length} role executions</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Apps Tested</div>
      <div class="kpi-val">${byApp.size}</div>
      <div class="kpi-sub">${Array.from(byApp.keys()).map(esc).join(", ")}</div>
    </div>
  </div>

  <!-- Sparklines -->
  <div class="card">
    <h2>Cost per Run</h2>
    <div class="spark-row">${sparklines()}</div>
    <div class="dim" style="font-size:11px;margin-top:8px">Each bar = one run · <span style="color:#6366f1">■</span> normal · <span style="color:#f59e0b">■</span> interrupted</div>
  </div>

  <!-- By App -->
  <div class="card">
    <h2>By App &nbsp;<span class="dim" style="font-weight:400;font-size:12px">(client billing view)</span></h2>
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th class="num">Runs</th>
          <th class="num">Role Execs</th>
          <th class="num">Prompt Tokens</th>
          <th class="num">Output Tokens</th>
          <th class="num">Total Tokens</th>
          <th class="num">Est. Cost</th>
          <th>Environments tested</th>
        </tr>
      </thead>
      <tbody>${appRows()}</tbody>
    </table>
  </div>

  <!-- Per Run -->
  <div class="card">
    <h2>Per-Run Breakdown &nbsp;<span class="dim" style="font-weight:400;font-size:12px">click a row to expand roles</span></h2>
    <div class="filter-bar">
      <input type="search" id="run-filter" placeholder="Filter by run ID / app…" oninput="filterRuns(this.value)" style="width:280px">
      <select id="app-filter" onchange="filterRuns(document.getElementById('run-filter').value)">
        <option value="">All apps</option>
        ${Array.from(byApp.keys()).map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}
      </select>
    </div>
    <table id="run-table">
      <thead>
        <tr>
          <th>Run ID</th>
          <th>Host</th>
          <th class="num">Roles</th>
          <th class="num">Prompt</th>
          <th class="num">Output</th>
          <th class="num">Total Tokens</th>
          <th class="num">Est. Cost</th>
        </tr>
      </thead>
      <tbody>${runRows()}</tbody>
    </table>
  </div>

</div>

<script>
function toggle(id) {
  const el   = document.getElementById(id);
  const chev = document.getElementById('chev-' + id);
  const open = el.style.display === 'none';
  el.style.display  = open ? '' : 'none';
  chev.classList.toggle('open', open);
}

function filterRuns(text) {
  const appFilter = document.getElementById('app-filter').value.toLowerCase();
  const q = text.toLowerCase();
  const rows = document.querySelectorAll('#run-table tbody tr.run-header');
  rows.forEach(row => {
    const detail = row.nextElementSibling;
    const txt    = row.textContent.toLowerCase();
    const match  = (!q || txt.includes(q)) && (!appFilter || txt.includes(appFilter));
    row.style.display    = match ? '' : 'none';
    detail.style.display = 'none'; // collapse on filter change
    const chev = row.querySelector('.chevron');
    if (chev) chev.classList.remove('open');
  });
}
</script>
</body>
</html>`;

fs.writeFileSync(outFile, html, "utf-8");
console.log(`Dashboard written: ${path.resolve(outFile)}`);
