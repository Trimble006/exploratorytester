// Generates talk/exploratory-tester.pptx
// Run: node talk/generate-slides.js

const PptxGenJS = require("pptxgenjs");
const { join } = require("path");

(async () => {
const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 16:9

// ──────────────────────────────────────────────────────────────────────────────
// Theme colours
// ──────────────────────────────────────────────────────────────────────────────
const BG      = "0F1117";
const FG      = "E2E8F0";
const ACCENT  = "A78BFA"; // purple
const ACCENT2 = "67E8F9"; // cyan
const GREEN   = "A3E635";
const DIM     = "64748B";
const CODE_BG = "1E293B";
const PINK    = "F0ABFC";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function addSlide() {
  const s = pptx.addSlide();
  s.background = { color: BG };
  return s;
}

function title(slide, text, y = 0.35, color = ACCENT) {
  slide.addText(text, {
    x: 0.5, y, w: 12.3, h: 0.7,
    fontSize: 28, bold: true, color,
    fontFace: "Segoe UI",
  });
  // underline rule
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y: y + 0.72, w: 12.3, h: 0.03,
    fill: { color: "7C3AED" }, line: { type: "none" },
  });
}

function body(slide, lines, opts = {}) {
  const defaults = {
    x: 0.5, y: 1.35, w: 12.3, h: 5.4,
    fontSize: 17, color: FG, fontFace: "Segoe UI",
    valign: "top", bullet: false,
  };
  slide.addText(lines, { ...defaults, ...opts });
}

function codeBox(slide, code, x = 0.5, y = 1.35, w = 12.3, h = 5.0) {
  slide.addShape(pptx.ShapeType.rect, {
    x, y, w, h,
    fill: { color: CODE_BG },
    line: { color: "7C3AED", width: 2, dashType: "solid" },
  });
  slide.addText(code, {
    x: x + 0.15, y: y + 0.1, w: w - 0.3, h: h - 0.2,
    fontSize: 11.5, color: FG, fontFace: "Courier New",
    valign: "top", wrap: true,
  });
}

function tag(slide, text, x, y, color = ACCENT2) {
  slide.addText(text, {
    x, y, w: 2.5, h: 0.35,
    fontSize: 11, color: BG, bold: true, fontFace: "Segoe UI",
    align: "center", fill: { color }, shape: pptx.ShapeType.roundRect,
  });
}

function blockquote(slide, text, y = 1.4) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y, w: 0.07, h: 0.75,
    fill: { color: "7C3AED" }, line: { type: "none" },
  });
  slide.addText(text, {
    x: 0.8, y, w: 11.8, h: 0.8,
    fontSize: 17, color: "94A3B8", italic: true, fontFace: "Segoe UI", valign: "middle",
  });
}

function footer(slide, text = "") {
  if (!text) return;
  slide.addText(text, {
    x: 0.5, y: 6.8, w: 12.3, h: 0.25,
    fontSize: 10, color: DIM, fontFace: "Segoe UI",
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slides
// ──────────────────────────────────────────────────────────────────────────────

// 1 — Title
{
  const s = addSlide();
  s.addText("Exploratory Tester", {
    x: 0.7, y: 1.8, w: 11.8, h: 1.1,
    fontSize: 48, bold: true, color: ACCENT, fontFace: "Segoe UI",
  });
  s.addText("AI-Powered Multi-Persona Test Exploration", {
    x: 0.7, y: 3.0, w: 11.8, h: 0.6,
    fontSize: 24, color: ACCENT2, fontFace: "Segoe UI",
  });
  s.addText("How it works · How it was built", {
    x: 0.7, y: 3.8, w: 11.8, h: 0.4,
    fontSize: 16, color: DIM, fontFace: "Segoe UI",
  });
}

// 2 — What is exploratory testing?
{
  const s = addSlide();
  title(s, "What is Exploratory Testing?");
  blockquote(s, '"Simultaneous learning, test design, and test execution" — Cem Kaner', 1.35);
  body(s, [
    { text: "Exploratory testing is ", options: { color: FG } },
    { text: "judgment-driven", options: { color: PINK, bold: true } },
    { text: ". A skilled tester:", options: { color: FG } },
  ], { y: 2.4, h: 0.4, bullet: false, fontSize: 18 });
  body(s, [
    { text: "Follows hunches based on experience\n", options: {} },
    { text: "Switches personas", options: { bold: true, color: PINK } },
    { text: " — admin vs. user vs. guest\n", options: {} },
    { text: "Investigates anomalies", options: { bold: true, color: PINK } },
    { text: " — if something looks odd, digs in\n", options: {} },
    { text: "Retests known weak spots", options: { bold: true, color: PINK } },
    { text: " from prior bugs\n", options: {} },
    { text: "Notices things a script ", options: {} },
    { text: "wouldn't even look for", options: { bold: true, color: PINK } },
  ], { y: 2.9, h: 2.5, bullet: { type: "bullet" }, fontSize: 17 });
  body(s, [
    { text: "The problem: ", options: { bold: true, color: ACCENT2 } },
    { text: "it doesn't scale. It needs humans — and their time.", options: { color: FG } },
  ], { y: 5.55, h: 0.5, fontSize: 17 });
}

// 3 — The Question
{
  const s = addSlide();
  title(s, "The Question");
  blockquote(s,
    "What if an LLM could hold a persona, understand an app, and explore it —\nrunning tool calls against a real browser, iteratively, like a tester would?",
    1.7);
  body(s, [
    { text: "LLMs can reason about app state from page snapshots\n", options: {} },
    { text: "LLMs can hold ", options: {} },
    { text: "identity, context, and goals", options: { bold: true, color: ACCENT2 } },
    { text: " across many turns\n", options: {} },
    { text: "LLMs can call tools", options: { bold: true, color: ACCENT2 } },
    { text: " (click, fill, navigate) — and adapt based on results\n", options: {} },
    { text: "You can run multiple agents ", options: {} },
    { text: "concurrently", options: { bold: true, color: GREEN } },
    { text: ", each as a different persona", options: {} },
  ], { y: 3.3, h: 2.8, bullet: { type: "bullet" }, fontSize: 18 });
}

// 4 — What It Does
{
  const s = addSlide();
  title(s, "The Answer: Exploratory Tester");
  body(s, [
    { text: "1. ", options: { bold: true, color: ACCENT2 } },
    { text: "Takes a ", options: {} },
    { text: "target URL", options: { bold: true, color: PINK } },
    { text: " and a set of ", options: {} },
    { text: "user personas (roles)\n", options: { bold: true, color: PINK } },
    { text: "2. ", options: { bold: true, color: ACCENT2 } },
    { text: "Spins up one ", options: {} },
    { text: "AI agent per role", options: { bold: true, color: PINK } },
    { text: ", each with a real Chromium browser\n", options: {} },
    { text: "3. ", options: { bold: true, color: ACCENT2 } },
    { text: "Each agent autonomously explores", options: { bold: true, color: PINK } },
    { text: " — clicks, fills forms, tests edge cases\n", options: {} },
    { text: "4. ", options: { bold: true, color: ACCENT2 } },
    { text: "Agents run ", options: {} },
    { text: "concurrently", options: { bold: true, color: GREEN } },
    { text: " and produce per-role reports\n", options: {} },
    { text: "5. ", options: { bold: true, color: ACCENT2 } },
    { text: "Findings aggregated into a ", options: {} },
    { text: "combined summary\n", options: { bold: true, color: PINK } },
    { text: "6. ", options: { bold: true, color: ACCENT2 } },
    { text: "Optionally ", options: {} },
    { text: "files GitHub issues", options: { bold: true, color: PINK } },
    { text: " for discovered bugs", options: {} },
  ], { y: 1.35, h: 4.6, fontSize: 17 });
  codeBox(s, "APP_UNDER_TEST=BookingPlatform APP_PROFILE=local npm start", 0.5, 6.1, 12.3, 0.55);
}

// 5 — Architecture
{
  const s = addSlide();
  title(s, "Architecture: Five Components");

  const boxes = [
    { label: "mcp-client.ts", sub: "Browser Layer", desc: "Playwright via MCP\nBrowser as a tool API", color: ACCENT },
    { label: "agent.ts", sub: "Agent Layer", desc: "AgentSession\nLLM loop per role", color: ACCENT2 },
    { label: "index.ts", sub: "Orchestration", desc: "Concurrency, config\nreport generation", color: GREEN },
    { label: "issue-ops.ts", sub: "GitHub", desc: "Fetch issues, post\nresults, swap labels", color: "FB923C" },
    { label: "Config System", sub: "App Profiles", desc: "roles.json · envs.json\ncontext/*.md", color: PINK },
  ];

  boxes.forEach((b, i) => {
    const x = 0.4 + i * 2.54;
    const y = 1.6;
    s.addShape(pptx.ShapeType.rect, {
      x, y, w: 2.3, h: 3.2,
      fill: { color: CODE_BG },
      line: { color: b.color, width: 2 },
    });
    s.addText(b.label, {
      x: x + 0.05, y: y + 0.15, w: 2.2, h: 0.5,
      fontSize: 13, bold: true, color: b.color, fontFace: "Courier New",
      align: "center",
    });
    s.addText(b.sub, {
      x: x + 0.05, y: y + 0.65, w: 2.2, h: 0.4,
      fontSize: 11, bold: true, color: FG, fontFace: "Segoe UI",
      align: "center",
    });
    s.addShape(pptx.ShapeType.rect, {
      x: x + 0.15, y: y + 1.1, w: 2.0, h: 0.02,
      fill: { color: b.color }, line: { type: "none" },
    });
    s.addText(b.desc, {
      x: x + 0.05, y: y + 1.2, w: 2.2, h: 1.8,
      fontSize: 12, color: "94A3B8", fontFace: "Segoe UI",
      align: "center", valign: "top",
    });
  });

  // Arrow labels between boxes
  for (let i = 0; i < 4; i++) {
    s.addText("→", {
      x: 2.6 + i * 2.54, y: 2.95, w: 0.2, h: 0.4,
      fontSize: 18, color: DIM, fontFace: "Segoe UI", align: "center",
    });
  }
}

// 6 — mcp-client.ts
{
  const s = addSlide();
  title(s, "The MCP Bridge  (mcp-client.ts)");
  body(s, [
    { text: "MCP", options: { bold: true, color: ACCENT2 } },
    { text: " = Model Context Protocol — expose any tool as a callable API for an LLM", options: {} },
  ], { y: 1.2, h: 0.45, fontSize: 17 });
  codeBox(s, `// Launch Playwright as a subprocess tool server
this.transport = new StdioClientTransport({
  command: "npx",
  args: ["@playwright/mcp@latest", "--browser", "chromium", ...],
});

this.client = new Client({ name: "exploratory-tester", version: "1.0.0" });

// Convert Playwright tool schemas → Gemini FunctionDeclarations
async getGeminiFunctionDeclarations(): Promise<FunctionDeclaration[]> {
  const tools = await this.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: convertMcpSchemaToGemini(tool.inputSchema),
  }));
}`, 0.5, 1.75, 12.3, 4.0);
  body(s, [
    { text: "The LLM can now call: ", options: { color: DIM } },
    { text: "browser_snapshot  browser_click  browser_fill_form  browser_navigate  ...", options: { color: GREEN, bold: true } },
  ], { y: 5.85, h: 0.45, fontSize: 15 });
}

// 7 — Agent Loop diagram
{
  const s = addSlide();
  title(s, "The Agent Loop  (agent.ts)");

  const steps = [
    { label: "setup()", detail: "Build system prompt · Load context · Init Gemini model with tools", color: ACCENT },
    { label: "step()", detail: "Call Gemini → get function calls → run MCP tools → append results", color: ACCENT2 },
    { label: "detect blockers", detail: "Modal? Cookie banner? Overlay? → attempt recovery (close/dismiss)", color: "FB923C" },
    { label: "loop / exit", detail: 'Repeat up to maxIterations  OR  until agent says "TESTING COMPLETE"', color: GREEN },
    { label: "finalize()", detail: "Append blocker log + risk coverage analysis → return full report", color: PINK },
  ];

  steps.forEach((step, i) => {
    const y = 1.3 + i * 0.98;
    s.addShape(pptx.ShapeType.rect, {
      x: 0.5, y, w: 2.3, h: 0.7,
      fill: { color: CODE_BG }, line: { color: step.color, width: 2 },
    });
    s.addText(step.label, {
      x: 0.5, y, w: 2.3, h: 0.7,
      fontSize: 14, bold: true, color: step.color, fontFace: "Courier New",
      align: "center", valign: "middle",
    });
    s.addText(step.detail, {
      x: 3.1, y: y + 0.05, w: 9.7, h: 0.6,
      fontSize: 15, color: FG, fontFace: "Segoe UI", valign: "middle",
    });
    if (i < steps.length - 1) {
      s.addText("↓", {
        x: 0.5, y: y + 0.72, w: 2.3, h: 0.25,
        fontSize: 13, color: DIM, align: "center",
      });
    }
  });
}

// 8 — step() code
{
  const s = addSlide();
  title(s, "One Iteration — step()");
  codeBox(s, `async step() {
  this.iterationsExecuted++;

  // 1. Ask Gemini what to do next (full conversation history sent each time)
  const result = await generateContentWithBackoff({
    model: this.generativeModel, contents: this.contents, ...
  });

  const functionCalls = result.response.functionCalls();

  // 2. Execute each browser tool via MCP
  const toolParts: Part[] = [];
  for (const call of functionCalls ?? []) {
    this.lastAction = \`Using tool: \${call.name}\`;
    const mcpResult = await mcpClient.callTool(call.name, call.args as any);
    toolParts.push({ functionResponse: { name: call.name, response: mcpResult } });
  }

  // 3. Append model response + tool results to conversation history
  this.contents.push({ role: "model", parts: [ ...functionCallParts ] });
  this.contents.push({ role: "user",  parts: toolParts });

  // 4. Check for completion signal
  if (textResponse?.includes("TESTING COMPLETE")) {
    this.completed = true;
  }
}`, 0.5, 1.2, 12.3, 5.55);
}

// 9 — Prompt anatomy
{
  const s = addSlide();
  title(s, "Prompt Anatomy");

  const layers = [
    { label: "Base testing guidelines", desc: "Navigate → snapshot → explore → document → final report", color: ACCENT },
    { label: "Credentials", desc: "identifierType + identifier + password (if authenticated role)", color: ACCENT2 },
    { label: "App context", desc: "What the app is, feature list, known architecture — from context/*.md", color: GREEN },
    { label: "Historical bugs", desc: "Known weak spots — agent prioritises these first", color: "FB923C" },
    { label: "Research summary", desc: "Auto-research mode: agent snapshots the app before testing to learn structure", color: PINK },
  ];

  layers.forEach((layer, i) => {
    const y = 1.5 + i * 0.98;
    s.addShape(pptx.ShapeType.rect, {
      x: 0.5, y, w: 12.3, h: 0.7,
      fill: { color: CODE_BG }, line: { color: layer.color, width: 1 },
    });
    s.addShape(pptx.ShapeType.rect, {
      x: 0.5, y, w: 0.12, h: 0.7,
      fill: { color: layer.color }, line: { type: "none" },
    });
    s.addText(layer.label, {
      x: 0.75, y: y + 0.06, w: 3.5, h: 0.3,
      fontSize: 13, bold: true, color: layer.color, fontFace: "Segoe UI",
    });
    s.addText(layer.desc, {
      x: 0.75, y: y + 0.35, w: 12.0, h: 0.28,
      fontSize: 12, color: "94A3B8", fontFace: "Segoe UI",
    });
  });
}

// 10 — Historical Bugs
{
  const s = addSlide();
  title(s, "Historical Bugs → Regression Coverage");
  body(s, [
    { text: "Historical bug reports turn ad-hoc exploration into ", options: { color: FG } },
    { text: "targeted regression testing", options: { bold: true, color: ACCENT2 } },
    { text: " — without writing a single test script.", options: { color: FG } },
  ], { y: 1.2, h: 0.5, fontSize: 17 });
  codeBox(s, `<!-- apps/BookingPlatform/local/context/historical-bugs.md -->

## [HIGH] Double-booking not prevented on lane reservations
Steps to reproduce:
  1. Log in as user
  2. Book lane 3, 7pm Saturday
  3. In a second tab, book lane 3, 7pm Saturday again
Expected: Second booking rejected
Actual: Both bookings confirmed`, 0.5, 1.85, 12.3, 2.6);

  body(s, [
    { text: "The agent reads this file, ", options: { color: FG } },
    { text: "prioritises these areas first", options: { bold: true, color: GREEN } },
    { text: ", then reports back:", options: { color: FG } },
  ], { y: 4.6, h: 0.4, fontSize: 16 });
  codeBox(s, `## Risk Retest Coverage
- Items considered: 12
- Clearly exercised: 9   ← confirmed still working or found regression
- Not clear: 3`, 0.5, 5.1, 12.3, 1.2);
}

// 11 — Config system
{
  const s = addSlide();
  title(s, "Config System — App Profiles");
  codeBox(s, `apps/
  BookingPlatform/
    local/
      roles.json           ← who to test as (credentials + context files)
      environments.json    ← URL per environment (local / dev / prod)
      context/
        app-context.md     ← what the app is, feature map, known limits
        historical-bugs.md ← regression target list
        admin-context.md   ← per-role context (optional)

APP_UNDER_TEST=BookingPlatform APP_PROFILE=local npm start`, 0.5, 1.25, 12.3, 3.5);

  body(s, "roles.json — three concurrent agents:", { y: 4.9, h: 0.4, fontSize: 15, color: ACCENT2, bold: true });
  codeBox(s, `{ "roles": [
  { "name": "platform admin", "identifier": "admin@wlbooking.com", "password": "admin123" },
  { "name": "tenant admin",   "identifier": "admin@lakeview.club",  "password": "club123" },
  { "name": "user",           "identifier": "user@lakeview.club",   "password": "user123" }
]}`, 0.5, 5.35, 12.3, 1.4);
}

// 12 — Concurrency
{
  const s = addSlide();
  title(s, "Concurrency — Three Agents at Once");
  codeBox(s, `// One MCP client (browser instance) per role, launched in parallel
const sessions = await Promise.all(
  roles.map(async (role) => {
    const mcpClient = new McpClient({ workingDir: outputDir });
    await mcpClient.connect();
    const session = new AgentSession({ ...options, roleName: role.name });
    await session.setup();
    return { role, session, mcpClient };
  })
);

// Interleaved execution — all roles step together each iteration
while (activeSessions.length > 0) {
  await Promise.all(activeSessions.map(s => s.session.step()));
  activeSessions = activeSessions.filter(s => !s.session.completed);
  logUpdate(renderDashboard(sessions, maxIterations));
}`, 0.5, 1.25, 12.3, 4.2);

  body(s, [
    { text: "Each role runs its own ", options: { color: FG } },
    { text: "independent browser", options: { bold: true, color: ACCENT2 } },
    { text: " and its own ", options: { color: FG } },
    { text: "Gemini conversation. ", options: { bold: true, color: ACCENT2 } },
    { text: "No shared state between agents.", options: { color: FG } },
  ], { y: 5.6, h: 0.45, fontSize: 16 });
}

// 13 — Live dashboard
{
  const s = addSlide();
  title(s, "Live Terminal Dashboard");
  codeBox(s, `Exploratory Tester - execution status
────────────────────────────────────────────────────────────
platform admin       [ 62%] Active   | Iteration: 31/50
  > browser_click: "Book a Lane" button
tenant admin         [ 58%] Active   | Iteration: 29/50
  > browser_fill_form: lane booking form
user                 [ 44%] Active   | Iteration: 22/50
  > browser_snapshot
────────────────────────────────────────────────────────────`, 0.5, 1.25, 12.3, 3.0);

  body(s, [
    { text: "log-update", options: { bold: true, color: ACCENT2 } },
    { text: " — repaints the terminal in-place (no scroll spam)\n", options: { color: FG } },
    { text: "chalk", options: { bold: true, color: ACCENT2 } },
    { text: " — colours per role / status\n", options: { color: FG } },
    { text: "session.lastAction", options: { bold: true, color: GREEN, fontFace: "Courier New" } },
    { text: " — updated after every tool call via ", options: { color: FG } },
    { text: "patchAgent.js", options: { bold: true, color: PINK, fontFace: "Courier New" } },
    { text: " instrumentation", options: { color: FG } },
  ], { y: 4.45, h: 2.0, bullet: { type: "bullet" }, fontSize: 16 });
}

// 14 — DEMO
{
  const s = addSlide();
  s.addText("DEMO", {
    x: 0.5, y: 2.0, w: 12.3, h: 1.5,
    fontSize: 72, bold: true, color: ACCENT,
    fontFace: "Segoe UI", align: "center",
  });
  s.addText("apps/BookingPlatform/local/outputs/localhost/", {
    x: 0.5, y: 3.7, w: 12.3, h: 0.6,
    fontSize: 20, color: ACCENT2, fontFace: "Courier New", align: "center",
  });
  body(s, [
    { text: "Walk through:\n", options: { bold: true, color: FG } },
    { text: "Per-role report", options: { bold: true, color: PINK } },
    { text: " — findings, STRs, severity levels, full transcript\n", options: { color: FG } },
    { text: "Risk retest coverage", options: { bold: true, color: PINK } },
    { text: " — which historical bugs were exercised\n", options: { color: FG } },
    { text: "Combined summary", options: { bold: true, color: PINK } },
    { text: " — all-role metadata + issue log results", options: { color: FG } },
  ], { y: 4.5, h: 2.0, fontSize: 16 });
}

// 15 — Sample output
{
  const s = addSlide();
  title(s, "What the Output Looks Like");
  codeBox(s, `# Exploratory Test Report

## Run Metadata
- Role: platform admin  |  Target URL: http://localhost:3000
- Iterations: 50/50     |  Model: gemini-2.0-flash

## Final Report

### Bugs Found
- [HIGH] Lane booking allows overlapping time slots
  STR: 1. Navigate to /bookings  2. Book lane 3 at 7pm Saturday
       3. Book lane 3 at 7pm Saturday again (same session)
  Expected: Conflict error shown  Actual: Second booking accepted

### UX Issues
- Search input state lost on page refresh — no URL state persistence

## Risk Retest Coverage
- Items considered: 12  |  Clearly exercised: 9  |  Not clear: 3

## Full Transcript
[Complete turn-by-turn conversation: snapshots, tool calls, observations]`, 0.5, 1.25, 12.3, 5.55);
}

// 16 — GitHub IssueOps
{
  const s = addSlide();
  title(s, "GitHub IssueOps Integration");
  body(s, "Two modes of GitHub integration:", { y: 1.25, h: 0.4, fontSize: 17, bold: true, color: ACCENT2 });

  s.addText("1  Issue-triggered runs", { x: 0.5, y: 1.8, w: 5.8, h: 0.4, fontSize: 15, bold: true, color: GREEN, fontFace: "Segoe UI" });
  codeBox(s, `Label issue "testing-requested"
  → system reads test params from issue body
  → runs test suite
  → posts results as comment
  → swaps label: testing-requested → testing-complete`, 0.5, 2.25, 5.8, 1.9);

  s.addText("2  Automatic bug filing", { x: 6.9, y: 1.8, w: 5.8, h: 0.4, fontSize: 15, bold: true, color: GREEN, fontFace: "Segoe UI" });
  codeBox(s, `Each finding → new GitHub issue
Deduplication by title
Labels applied automatically
Dry-run mode available`, 6.9, 2.25, 5.8, 1.9);

  codeBox(s, `// issue-tracker.github.json
{
  "provider": "github",
  "repo": "owner/repo",
  "labels": ["exploratory-test", "auto-filed"],
  "titlePrefix": "[Exploratory]",
  "dedupeByTitle": true,
  "dryRun": false
}`, 0.5, 4.3, 12.3, 2.15);
}

// 17 — How it was built
{
  const s = addSlide();
  title(s, "How It Was Built");

  const rows = [
    ["Decision", "Choice", "Why"],
    ["LLM", "Gemini (function calling)", "Native FunctionDeclaration schema; generous free tier"],
    ["Browser", "@playwright/mcp", "Tool-per-action API; no custom Playwright glue needed"],
    ["Language", "TypeScript", "Type safety across agent / tool / config interfaces"],
    ["Concurrency", "Interleaved Promise.all", "All roles step together; dashboard stays in sync"],
    ["Dashboard", "log-update + chalk", "In-place repainting without clearing terminal history"],
    ["Config", "App profile system", "Reusable across multiple apps and environments"],
    ["Instrumentation", "patchAgent.js / indexpatch.js", "Runtime patching to add dashboard state without changing source"],
  ];

  const colW = [2.5, 3.5, 6.1];
  const colX = [0.5, 3.1, 6.7];
  const rowH = 0.5;

  rows.forEach((row, ri) => {
    colX.forEach((cx, ci) => {
      const isHeader = ri === 0;
      s.addShape(pptx.ShapeType.rect, {
        x: cx, y: 1.3 + ri * rowH, w: colW[ci], h: rowH,
        fill: { color: isHeader ? "1E293B" : (ri % 2 === 0 ? "131721" : "0F1117") },
        line: { color: "1E293B", width: 1 },
      });
      s.addText(row[ci], {
        x: cx + 0.08, y: 1.3 + ri * rowH, w: colW[ci] - 0.08, h: rowH,
        fontSize: isHeader ? 13 : 12,
        bold: isHeader,
        color: isHeader ? ACCENT : (ci === 0 ? ACCENT2 : FG),
        fontFace: ci === 1 ? "Courier New" : "Segoe UI",
        valign: "middle",
      });
    });
  });
}

// 18 — Rate limiting
{
  const s = addSlide();
  title(s, "Rate Limiting & Resilience");
  body(s, [
    { text: "Real-world issue: ", options: { color: DIM } },
    { text: "Gemini's free tier rate-limits aggressively under concurrent multi-agent load.", options: { color: FG } },
  ], { y: 1.2, h: 0.45, fontSize: 17 });
  codeBox(s, `async function generateContentWithBackoff({ model, contents, ... }) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent({ contents });

    } catch (err) {
      if (is429(err) && attempt < maxRetries) {
        const delay = Math.min(
          baseDelay * 2 ** (attempt - 1) + jitter(),  // exponential + jitter
          maxDelay
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}`, 0.5, 1.75, 12.3, 3.8);

  body(s, [
    { text: "Configurable via env vars: ", options: { color: DIM } },
    { text: "GEMINI_RATE_LIMIT_BASE_DELAY_MS", options: { color: GREEN, fontFace: "Courier New" } },
    { text: "  ", options: {} },
    { text: "MAX_DELAY_MS", options: { color: GREEN, fontFace: "Courier New" } },
    { text: "  ", options: {} },
    { text: "MAX_RETRIES", options: { color: GREEN, fontFace: "Courier New" } },
  ], { y: 5.7, h: 0.4, fontSize: 15 });
}

// 19 — What's next
{
  const s = addSlide();
  title(s, "What's Next / Open Questions");

  s.addText("Possible extensions", { x: 0.5, y: 1.3, w: 5.8, h: 0.4, fontSize: 16, bold: true, color: ACCENT2, fontFace: "Segoe UI" });
  body(s, [
    "Support other LLMs (OpenAI, Claude) — same tool interface\n",
    "Visual diffing — compare snapshots across runs for UI regressions\n",
    "Confidence scoring — how thoroughly was each area covered?\n",
    "Structured finding schema — machine-parseable bugs, not just markdown",
  ].map(t => ({ text: t, options: {} })),
  { x: 0.5, y: 1.75, w: 5.8, h: 3.5, bullet: { type: "bullet" }, fontSize: 15 });

  s.addText("Open questions the tool surfaces", { x: 6.9, y: 1.3, w: 5.8, h: 0.4, fontSize: 16, bold: true, color: "FB923C", fontFace: "Segoe UI" });
  body(s, [
    "How many iterations is 'enough'? (currently env-var tunable)\n",
    "Should agents share state, or stay isolated?\n",
    "How do you measure coverage when there's no test plan?\n",
    "When does it replace exploratory testing vs. augment it?",
  ].map(t => ({ text: t, options: {} })),
  { x: 6.9, y: 1.75, w: 5.8, h: 3.5, bullet: { type: "bullet" }, fontSize: 15 });
}

// 20 — Q&A
{
  const s = addSlide();
  s.addText("Thanks", {
    x: 0.5, y: 2.0, w: 12.3, h: 1.2,
    fontSize: 64, bold: true, color: ACCENT,
    fontFace: "Segoe UI", align: "center",
  });
  s.addText("Questions?", {
    x: 0.5, y: 3.3, w: 12.3, h: 0.7,
    fontSize: 28, color: ACCENT2, fontFace: "Segoe UI", align: "center",
  });
  s.addText(
    "src/agent.ts  ·  src/mcp-client.ts  ·  src/index.ts\napps/BookingPlatform/local/",
    {
      x: 0.5, y: 4.3, w: 12.3, h: 0.8,
      fontSize: 15, color: DIM, fontFace: "Courier New", align: "center",
    }
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Write file
// ──────────────────────────────────────────────────────────────────────────────
const out = join(__dirname, "exploratory-tester.pptx");
await pptx.writeFile({ fileName: out });
console.log(`Created: ${out}`);
})();
