---
marp: true
theme: default
paginate: true
style: |
  :root {
    --color-bg: #0f1117;
    --color-fg: #e2e8f0;
    --color-accent: #7c3aed;
    --color-accent2: #06b6d4;
    --color-dim: #64748b;
    --color-code-bg: #1e293b;
  }
  section {
    background-color: var(--color-bg);
    color: var(--color-fg);
    font-family: 'Segoe UI', system-ui, sans-serif;
    padding: 48px 64px;
  }
  h1 {
    color: #a78bfa;
    font-size: 2.2em;
    border-bottom: 2px solid #7c3aed;
    padding-bottom: 12px;
  }
  h2 {
    color: #67e8f9;
    font-size: 1.5em;
    margin-top: 0;
  }
  h3 {
    color: #a3e635;
    font-size: 1.1em;
  }
  code {
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 0.85em;
  }
  pre {
    background: #1e293b !important;
    border-left: 3px solid #7c3aed;
    border-radius: 6px;
    padding: 16px 20px;
    font-size: 0.72em;
    overflow: hidden;
  }
  pre code {
    background: transparent;
    padding: 0;
  }
  ul, ol {
    line-height: 1.9;
  }
  li {
    margin-bottom: 4px;
  }
  strong {
    color: #f0abfc;
  }
  em {
    color: #67e8f9;
  }
  blockquote {
    border-left: 4px solid #7c3aed;
    padding-left: 20px;
    color: #94a3b8;
    font-style: italic;
    margin: 24px 0;
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 40px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85em;
  }
  th {
    background: #1e293b;
    color: #a78bfa;
    padding: 8px 12px;
    text-align: left;
  }
  td {
    border-top: 1px solid #1e293b;
    padding: 8px 12px;
  }
  footer {
    color: #334155;
    font-size: 0.7em;
  }
  section.title {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
  }
  section.title h1 {
    font-size: 2.8em;
    border: none;
    margin-bottom: 8px;
  }
  section.cover-tag {
    color: #64748b;
    font-size: 1em;
    margin-top: 0;
  }
---

<!-- _class: title -->

# Exploratory Tester
## AI-Powered Multi-Persona Test Exploration

<p class="cover-tag">How it works · How it was built</p>

---

# What is Exploratory Testing?

> *"Simultaneous learning, test design, and test execution"*
> — Cem Kaner

Exploratory testing is **judgment-driven**. A good tester:

- Follows hunches based on experience
- **Switches personas** — admin vs. user vs. guest
- **Investigates anomalies** — if something looks odd, dig in
- **Retests known weak spots** from prior bugs
- Notices things a script wouldn't even look for

**The problem:** it doesn't scale. It needs humans — and their time.

---

# The Question

<br>

> *What if an LLM could hold a persona, understand an app, and explore it — running tool calls against a real browser, iteratively, like a tester would?*

<br>

- LLMs can reason about app state from snapshots
- LLMs can hold identity, context, and goals across many turns
- LLMs can call tools (browser clicks, form fills) — and adapt based on results
- You can run multiple agents **concurrently**, each as a different persona

---

# The Answer: Exploratory Tester

A tool that:

1. Takes a **target URL** and a set of **user personas** (roles)
2. Spins up one **AI agent per role**, each with a real Chromium browser
3. Each agent **autonomously explores** the app — clicks, fills forms, tests edge cases
4. Agents run **concurrently** and produce **per-role reports**
5. Findings are aggregated into a **combined summary**
6. Optionally **files GitHub issues** for discovered bugs

```
APP_UNDER_TEST=BookingPlatform APP_PROFILE=local npm start
```

---

# Architecture: Five Components

<div class="columns">
<div>

### Browser Layer
**`src/mcp-client.ts`**
Playwright via Model Context Protocol — browser as a tool API

### Brain Layer
**`src/agent.ts`**
`AgentSession` — the LLM agent loop per role

### Orchestration
**`src/index.ts`**
Concurrency, config loading, report generation

</div>
<div>

### GitHub Integration
**`src/issue-ops.ts`**
Fetch issue params, post results, swap labels

### Config System
`roles.json` · `environments.json`
`context/*.md` — per-app, per-profile

</div>
</div>

---

# The MCP Bridge (`mcp-client.ts`)

**MCP = Model Context Protocol** — turn any tool into a callable API for an LLM.

```typescript
this.transport = new StdioClientTransport({
  command: "npx",
  args: ["@playwright/mcp@latest", "--browser", "chromium", ...],
});

this.client = new Client(
  { name: "exploratory-tester", version: "1.0.0" },
  { capabilities: {} }
);
```

Then convert Playwright's tool schemas → **Gemini `FunctionDeclaration`** format:

```typescript
async getGeminiFunctionDeclarations(): Promise<FunctionDeclaration[]> {
  const tools = await this.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: convertMcpSchemaToGemini(tool.inputSchema),
  }));
}
```

The agent can now call `browser_click`, `browser_fill_form`, `browser_snapshot`... just like any other function.

---

# The Agent Loop (`agent.ts`)

```
setup()
  ↓ Build system prompt (persona + app context + historical bugs)
  ↓ Load Gemini model with Playwright tools as function declarations
  ↓ Optional: quick auto-research pass (snapshot + inspect)

step()  ← called repeatedly up to maxIterations
  ↓ Call Gemini with full conversation history
  ↓ Receive text response + function call requests
  ↓ Execute each browser tool via MCP
  ↓ Detect & recover from blockers (modals, cookie banners, overlays)
  ↓ Append tool results → conversation history
  ↓ Check for "TESTING COMPLETE" signal

finalize()
  ↓ Append blocker summary
  ↓ Append risk coverage analysis (which known bugs were exercised?)
  ↓ Return AgentRunResult with full transcript + token usage
```

---

# The Agent Loop — Code

```typescript
async step() {
  this.iterationsExecuted++;

  // Call Gemini with full conversation history
  const result = await generateContentWithBackoff({
    model: this.generativeModel,
    contents: this.contents,
    ...
  });

  const functionCalls = result.response.functionCalls();

  // Execute each browser tool via MCP
  const toolResults = [];
  for (const call of functionCalls ?? []) {
    const mcpResult = await this.options.mcpClient.callTool(call.name, call.args);
    toolResults.push({ name: call.name, result: mcpResult });
  }

  // Append results to conversation history
  this.contents.push({ role: "model", parts: [...] });
  this.contents.push({ role: "user",  parts: toolResults });

  // Check for completion signal
  if (textResponse?.includes("TESTING COMPLETE")) {
    this.completed = true;
  }
}
```

---

# Prompt Anatomy

The **system prompt** is where the testing intelligence lives.

```
SYSTEM PROMPT = base testing guidelines
              + credentials (if authenticated)
              + app context (what this app is and does)
              + historical bug reports (known weak spots)
              + research summary (if auto-research mode)
```

**Key instructions in the base prompt:**
- Test both happy paths and edge cases
- Try special characters, long strings, SQL injection patterns in inputs
- Dismiss blockers (modals, cookie banners) before retrying
- If historical bug reports provided: **prioritize those areas first**
- Signal "TESTING COMPLETE" when done

---

# Prompt Anatomy — Historical Bugs

Historical bug reports turn ad-hoc exploration into **targeted regression testing**.

```markdown
<!-- apps/BookingPlatform/local/context/historical-bugs.md -->

## [HIGH] Double-booking not prevented on lane reservations
Steps to reproduce:
1. Log in as user
2. Book lane 3, 7pm Saturday
3. In a second tab, book lane 3, 7pm Saturday again
Expected: Second booking rejected
Actual: Both bookings confirmed
```

The agent reads this file, **prioritizes these areas**, and at the end:

```markdown
## Risk Retest Coverage
- Items considered: 12
- Clearly exercised: 9
- Not clear: 3
```

---

# Config System

The **app profile system** lets you run against any app, any environment.

```
apps/
  BookingPlatform/
    local/
      roles.json          ← who to test as
      environments.json   ← where to point
      context/
        app-context.md    ← what the app is
        historical-bugs.md
        admin-context.md  ← per-role context
```

```bash
APP_UNDER_TEST=BookingPlatform APP_PROFILE=local npm start
```

**`roles.json`** — three concurrent agents:
```json
{ "roles": [
  { "name": "platform admin", "identifier": "admin@wlbooking.com", ... },
  { "name": "tenant admin",   "identifier": "admin@lakeview.club", ... },
  { "name": "user",           "identifier": "user@lakeview.club",  ... }
]}
```

---

# Concurrency — Three Agents at Once

```typescript
// src/index.ts

// One MCP client (browser) per role
const sessions = await Promise.all(
  roles.map(async (role) => {
    const mcpClient = new McpClient({ workingDir: outputDir });
    await mcpClient.connect();
    const session = new AgentSession({ ...options, roleName: role.name });
    await session.setup();
    return { role, session, mcpClient };
  })
);

// Interleaved execution — all roles step together
while (activeSessions.length > 0) {
  await Promise.all(activeSessions.map(s => s.session.step()));
  activeSessions = activeSessions.filter(s => !s.session.completed);
  logUpdate(renderDashboard(sessions, maxIterations));
}
```

Each role runs **its own browser instance** and **its own conversation** with Gemini.

---

# Live Dashboard

The real-time terminal dashboard shows all roles progressing simultaneously.

```
Exploratory Tester - execution status
────────────────────────────────────────────────────────────
platform admin       [ 62%] Active   | Iteration: 31/50
  > browser_click: "Book a Lane" button
tenant admin         [ 58%] Active   | Iteration: 29/50
  > browser_fill_form: lane booking form
user                 [ 44%] Active   | Iteration: 22/50
  > browser_snapshot
────────────────────────────────────────────────────────────
```

Built with `log-update` (in-place terminal repainting) and `chalk` (colors).

`session.lastAction` is updated after every tool call via **`patchAgent.js`** — an instrumentation patch applied at startup.

---

# Demo

**Pre-run output** — `apps/BookingPlatform/local/outputs/localhost/`

Walk through:
1. **Per-role report** — findings, STRs, severity levels, transcript
2. **Risk retest coverage** — which historical bugs were exercised
3. **Combined summary** — metadata, all-role status, issue log results

<br>

> _OR: live run with `APP_UNDER_TEST=BookingPlatform APP_PROFILE=local npm start`_

---

# What the Output Looks Like

**Role report** (`role-reports/report-platform-admin-*.md`):

```markdown
# Exploratory Test Report
## Run Metadata
- Role: platform admin
- Target URL: http://localhost:3000
- Iterations: 50/50 | Model: gemini-2.0-flash

## Final Report
### Bugs Found
- [HIGH] Lane booking allows overlapping time slots
  STR: 1. Navigate to /bookings  2. Book lane 3 at 7pm...

### UX Issues
- Search input clears on page refresh — no state persistence

## Risk Retest Coverage
- Items considered: 12 | Clearly exercised: 9 | Not clear: 3

## Full Transcript
[Complete turn-by-turn conversation with all tool calls and results]
```

---

# GitHub IssueOps Integration

Two modes of GitHub integration:

**1. Issue-triggered runs** (`src/issue-ops.ts`)
- A GitHub issue labelled `testing-requested` triggers a test run
- Parameters (URL, app, roles) extracted from issue body
- Results posted back as a comment
- Label swapped: `testing-requested` → `testing-complete`

**2. Automatic bug filing**
- Each finding above a severity threshold → new GitHub issue
- Title prefixed, deduplication by title, labels applied
- Dry-run mode available

```json
{ "provider": "github", "repo": "owner/repo",
  "labels": ["exploratory-test", "auto-filed"],
  "dedupeByTitle": true, "dryRun": false }
```

---

# How It Was Built

| Decision | Choice | Why |
|----------|--------|-----|
| LLM | **Gemini** (function calling) | Native function declaration schema, generous free tier |
| Browser | **Playwright via MCP** | Tool-per-action API; no custom Playwright glue needed |
| Language | **TypeScript** | Type safety across agent/tool interfaces |
| Concurrency | **Interleaved Promise.all** | All roles step together; dashboard stays in sync |
| Dashboard | **log-update + chalk** | In-place repainting without clearing terminal history |
| Config | **App profile system** | Reusable across multiple apps and environments |

**Patch files** (`patchAgent.js`, `indexpatch.js`) — lightweight runtime instrumentation to add dashboard state tracking without modifying compiled source.

---

# Rate Limiting & Resilience

Real-world issue: Gemini's free tier rate-limits aggressively.

```typescript
async function generateContentWithBackoff({ model, contents, ... }) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent({ contents });
    } catch (err) {
      if (is429(err) && attempt < maxRetries) {
        const delay = Math.min(
          baseDelay * 2 ** (attempt - 1) + jitter(),
          maxDelay
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}
```

Configurable via env vars: `GEMINI_RATE_LIMIT_BASE_DELAY_MS`, `MAX_DELAY_MS`, `MAX_RETRIES`.

---

# What's Next / Open Questions

**Possible extensions:**
- Support other LLMs (OpenAI, Claude) with the same tool interface
- Visual diffing — compare snapshots across runs to detect UI regressions
- Confidence scoring — how thoroughly was each area covered?
- Structured finding schema — machine-parseable bugs, not just markdown

**Open questions the tool surfaces:**
- How many iterations is "enough"? (currently env-var tunable)
- Should agents share state? (currently fully isolated)
- How do you measure coverage when there's no test plan?

---

<!-- _class: title -->

# Thanks

<p class="cover-tag">Questions?</p>

<br>

**Code:** `src/agent.ts` · `src/mcp-client.ts` · `src/index.ts`
**Config:** `apps/BookingPlatform/local/`
**Outputs:** `apps/BookingPlatform/local/outputs/localhost/`
