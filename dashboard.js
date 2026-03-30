#!/usr/bin/env node
// Token Usage Dashboard — shows cost breakdown per run, per app/URL, and lifetime totals.
//
// Usage:
//   node dashboard.js
//   node dashboard.js --url=localhost:3000
//   node dashboard.js --since=2026-03-29
//   node dashboard.js --log=apps/bookingplatform/local/outputs/token-usage.ndjson
//   node dashboard.js --json
//
// Add npm script: "dashboard": "node dashboard.js"
"use strict";

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Pricing table (approximate) — verify at https://ai.google.dev/pricing
// ---------------------------------------------------------------------------
const PRICING = {
  "gemini-2.0-flash":         { inputPer1M: 0.075, outputPer1M: 0.30 },
  "gemini-2.0-flash-lite":    { inputPer1M: 0.018, outputPer1M: 0.075 },
  "gemini-1.5-flash":         { inputPer1M: 0.075, outputPer1M: 0.30 },
  "gemini-1.5-pro":           { inputPer1M: 1.25,  outputPer1M: 5.00 },
};
const DEFAULT_PRICING = { inputPer1M: 0.075, outputPer1M: 0.30 };

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  const key = Object.keys(PRICING).find(k => model.startsWith(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

function calcCost(entry) {
  const p = getPricing(entry.model);
  return (entry.prompt / 1_000_000) * p.inputPer1M
       + (entry.output / 1_000_000) * p.outputPer1M;
}

// ---------------------------------------------------------------------------
// File discovery — walks workspace looking for token-usage.ndjson
// ---------------------------------------------------------------------------
function findLogFiles(baseDir) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
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

const filterUrl  = argMap.url;
const filterSince = argMap.since ? new Date(argMap.since) : undefined;
const jsonOutput  = argMap.json === true;

// ---------------------------------------------------------------------------
// Load entries
// ---------------------------------------------------------------------------
let logFiles = argMap.log ? [argMap.log] : findLogFiles(process.cwd());

if (logFiles.length === 0) {
  console.error("No token-usage.ndjson files found. Run the tester first.");
  process.exit(1);
}

let entries = logFiles.flatMap(readEntries);

if (filterUrl)   entries = entries.filter(e => e.url && e.url.includes(filterUrl));
if (filterSince) entries = entries.filter(e => new Date(e.ts) >= filterSince);

if (entries.length === 0) {
  console.log("No token usage entries match the given filters.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Aggregate: by run
// ---------------------------------------------------------------------------
const byRun = new Map();
for (const e of entries) {
  if (!byRun.has(e.runId)) {
    byRun.set(e.runId, {
      runId: e.runId,
      url: e.url,
      model: e.model,
      firstTs: e.ts,
      interrupted: e.runId.endsWith("-interrupted"),
      roles: [],
      totalPrompt: 0, totalOutput: 0, totalCached: 0, totalTokens: 0, totalCost: 0,
    });
  }
  const run = byRun.get(e.runId);
  const cost = calcCost(e);
  run.roles.push({ role: e.role, prompt: e.prompt, output: e.output, cached: e.cached, total: e.total, cost });
  run.totalPrompt  += e.prompt;
  run.totalOutput  += e.output;
  run.totalCached  += e.cached;
  run.totalTokens  += e.total;
  run.totalCost    += cost;
}

// ---------------------------------------------------------------------------
// Aggregate: by App (for client billing) — falls back to URL host for old entries
// ---------------------------------------------------------------------------
const byApp = new Map();
for (const e of entries) {
  const appKey = e.app || (() => { try { return new URL(e.url).host; } catch { return e.url; } })();
  if (!byApp.has(appKey)) {
    byApp.set(appKey, { app: appKey, prompt: 0, output: 0, cached: 0, total: 0, cost: 0, runIds: new Set(), roleExecs: 0, envs: new Set() });
  }
  const a = byApp.get(appKey);
  a.prompt    += e.prompt;
  a.output    += e.output;
  a.cached    += e.cached;
  a.total     += e.total;
  a.cost      += calcCost(e);
  a.runIds.add(e.runId);
  a.roleExecs++;
  if (e.url) { try { a.envs.add(new URL(e.url).host); } catch { a.envs.add(e.url); } }
}

// ---------------------------------------------------------------------------
// Lifetime totals
// ---------------------------------------------------------------------------
const lifetime = entries.reduce((acc, e) => {
  acc.prompt  += e.prompt;
  acc.output  += e.output;
  acc.cached  += e.cached;
  acc.total   += e.total;
  acc.cost    += calcCost(e);
  return acc;
}, { prompt: 0, output: 0, cached: 0, total: 0, cost: 0 });

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------
if (jsonOutput) {
  const runs = Array.from(byRun.values()).map(r => ({
    ...r,
    roles: r.roles,
    totalCost: +r.totalCost.toFixed(6),
  }));
  const apps = Array.from(byApp.values()).map(a => ({
    ...a,
    runIds: Array.from(a.runIds),
    envs: Array.from(a.envs),
    runCount: a.runIds.size,
    cost: +a.cost.toFixed(6),
  }));
  console.log(JSON.stringify({ runs, apps, lifetime: { ...lifetime, cost: +lifetime.cost.toFixed(6) } }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Terminal rendering helpers
// ---------------------------------------------------------------------------
const W = Math.min(process.stdout.columns || 120, 160);
const bold   = s => `\x1b[1m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const green  = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;

function pad(s, w, right = false) {
  const str = String(s);
  if (str.length >= w) return str.slice(0, w);
  return right ? str.padStart(w) : str.padEnd(w);
}

function fmt(n)    { return n.toLocaleString(); }
function fmtC(usd) { return `$${usd.toFixed(4)}`; }

function table(headers, colWidths, rows) {
  const sep = "  ";
  const header = headers.map((h, i) => bold(pad(h, colWidths[i]))).join(sep);
  const divider = dim(colWidths.map(w => "─".repeat(w)).join(sep));
  console.log("  " + header);
  console.log("  " + divider);
  for (const row of rows) {
    console.log("  " + row.map((cell, i) => {
      const raw = cell && typeof cell === "object" ? cell : { text: String(cell ?? ""), right: false, color: null };
      const text   = typeof cell === "object" ? cell.text   : String(cell ?? "");
      const right  = typeof cell === "object" ? cell.right  : false;
      const color  = typeof cell === "object" ? cell.color  : null;
      const padded = pad(text, colWidths[i], right);
      return color ? color(padded) : padded;
    }).join(sep));
  }
}

function r(text, color) { return { text: String(text), right: true, color: color ?? null }; }
function l(text, color) { return { text: String(text), right: false, color: color ?? null }; }

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
console.log("");
console.log(bold(cyan("  Exploratory Tester — Token Usage & Cost Dashboard")));
console.log(dim(`  Pricing: Gemini 2.0 Flash ~$0.075/1M input, ~$0.30/1M output [approx — verify at ai.google.dev/pricing]`));
if (logFiles.length > 1) console.log(dim(`  Sources: ${logFiles.length} log files discovered`));
if (filterUrl)           console.log(dim(`  Filter: url contains "${filterUrl}"`));
if (filterSince)         console.log(dim(`  Filter: since ${filterSince.toISOString()}`));
console.log("");

// ---------------------------------------------------------------------------
// Per-run table
// ---------------------------------------------------------------------------
const runs = Array.from(byRun.values()).sort((a, b) => a.runId.localeCompare(b.runId));
console.log(bold("  Per-Run Breakdown"));
console.log("");

const runCols  = [30, 24, 7, 11, 11, 11, 10];
const runHdrs  = ["Run ID (timestamp)", "URL host", "Roles", "Prompt", "Output", "Total", "Cost"];
const runRows  = [];

for (const run of runs) {
  let host; try { host = new URL(run.url).host; } catch { host = run.url; }
  const label  = run.interrupted ? `${run.runId} ⚡` : run.runId;
  const clabel = run.interrupted ? yellow : null;

  runRows.push([
    l(label, clabel),
    l(host),
    r(run.roles.length),
    r(fmt(run.totalPrompt)),
    r(fmt(run.totalOutput)),
    r(fmt(run.totalTokens)),
    r(fmtC(run.totalCost), run.totalCost > 0.05 ? yellow : green),
  ]);

  // per-role detail rows
  for (const ro of run.roles) {
    runRows.push([
      l(dim(`  └ ${ro.role}`)),
      l(""),
      r(""),
      r(dim(fmt(ro.prompt))),
      r(dim(fmt(ro.output))),
      r(dim(fmt(ro.total))),
      r(dim(fmtC(ro.cost))),
    ]);
  }
}

table(runHdrs, runCols, runRows);
console.log("");

// ---------------------------------------------------------------------------
// By App — client billing view
// ---------------------------------------------------------------------------
console.log(bold("  By App  (client billing view)"));
console.log("");

const appSorted = Array.from(byApp.values()).sort((a, b) => b.cost - a.cost);
const appCols   = [28, 8, 12, 14, 14, 14, 12, 20];
const appHdrs   = ["App", "Runs", "Role Execs", "Prompt", "Output", "Total Tokens", "Est. Cost", "Environments tested"];
const appRows   = [];
for (const a of appSorted) {
  const envList = Array.from(a.envs).join(", ");
  appRows.push([
    l(a.app),
    r(a.runIds.size),
    r(a.roleExecs),
    r(fmt(a.prompt)),
    r(fmt(a.output)),
    r(fmt(a.total)),
    r(fmtC(a.cost), a.cost > 0.10 ? yellow : green),
    l(dim(envList)),
  ]);
}

table(appHdrs, appCols, appRows);
console.log("");

// ---------------------------------------------------------------------------
// Lifetime totals
// ---------------------------------------------------------------------------
console.log(bold("  Lifetime Totals"));
console.log("");
console.log(`  Runs tracked:  ${byRun.size}`);
console.log(`  Role execs:    ${entries.length}`);
console.log(`  Prompt tokens: ${fmt(lifetime.prompt)}`);
console.log(`  Output tokens: ${fmt(lifetime.output)}`);
if (lifetime.cached > 0)
  console.log(`  Cached tokens: ${fmt(lifetime.cached)}`);
console.log(`  Total tokens:  ${fmt(lifetime.total)}`);
console.log(bold(`  Total cost:    ${green(fmtC(lifetime.cost) + " [approx]")}`));
console.log("");

if (logFiles.length === 1) console.log(dim(`  Log: ${logFiles[0]}`));
else logFiles.forEach(f => console.log(dim(`  Log: ${f}`)));
console.log("");
