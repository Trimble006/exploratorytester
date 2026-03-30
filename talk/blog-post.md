# We Built an AI That Explores Our Apps Like a Tester Would

Testing software well is slow. Not because running tests is slow — automated test suites can blast through hundreds of checks in minutes — but because *designing good tests* takes a particular kind of human attention. A skilled tester doesn't follow a script mechanically; they follow hunches, switch perspectives, poke at things that look slightly off, and revisit the places that broke before.

That kind of judgment-driven, curiosity-led testing has a name: **exploratory testing**. And it's historically been something only humans could do.

We wanted to change that.

---

## The Idea

Large language models are surprisingly good at holding context and adapting their behaviour across many steps. They can maintain a persona — *"I'm an admin, I have these permissions"* — while also following a thread of investigation: *"that looked odd, let me try it a different way"*.

What they've been missing is a browser.

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) changes that. MCP is an open standard that lets you expose tools — any tools — to an LLM as callable functions. Playwright, the browser automation library, now ships an MCP server. That means a language model can call `browser_click`, `browser_fill_form`, `browser_snapshot` and get structured results back, exactly as if those were API endpoints.

Put the two together and you have an AI agent that can actually *use* a web application.

---

## What We Built

We built a tool called **Exploratory Tester** that orchestrates these agents across multiple user roles simultaneously.

At its core:

- You give it a target URL and a set of **personas** — each with credentials, role-specific context, and a list of known historical bugs to retest
- It spins up **one AI agent per persona**, each with its own real Chromium browser
- All agents run **concurrently**, stepping through the app in parallel
- Each produces a **detailed report**: bugs found with steps to reproduce, UX issues, severity ratings, and a risk retest coverage table

A single command kicks off the whole run:

```bash
APP_UNDER_TEST=BookingPlatform APP_PROFILE=local npm start
```

While it runs, a live terminal dashboard shows all three agents progressing together:

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

---

## What It Actually Found

We ran it against an early build of our BookingPlatform — a multi-tenant SaaS platform for bowling clubs, with roles from platform admin down to regular club members.

In a single run with five iterations per role, across all three personas, the agents independently confirmed a set of real, reproducible bugs:

- **Critical:** The Bookings page crashed for all three roles with `TypeError: availability.map is not a function` — a data-shape mismatch between the API and the frontend component
- **Critical blocker:** A `<nextjs-portal>` overlay was intercepting pointer events, making the error page's "Reload" and "Back" buttons unclickable — a particularly insidious bug because it prevents recovery from the first crash
- **High:** The Maintenance page had the same class of crash (`TypeError: tasks.map is not a function`)
- **Medium:** The "Sign Out" button had silently stopped working

The same Bookings crash appeared in all three role reports — which is itself useful signal. A bug that breaks the experience regardless of who you are logged in as is categorically different from one that only affects a specific privilege level.

The agents also tracked **regression coverage** against the historical bug list:

```
Historical risk items considered: 15
Clearly exercised during run:     10
Not clearly exercised:             5
```

Known weak spots that were still present were flagged. Known weak spots that couldn't be reached (due to earlier crashes blocking navigation) were noted as "not clear" rather than silently counted as passing.

---

## How It Works (For the Engineers)

The system has five main components:

**`mcp-client.ts`** launches `@playwright/mcp` as a subprocess and connects over MCP's stdio transport. It converts the Playwright tool schemas into Gemini `FunctionDeclaration` objects so the model can call them natively:

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

**`agent.ts`** manages a single role's session. `setup()` builds the system prompt — base testing guidelines, credentials, app context loaded from a markdown file, historical bugs — and initialises the Gemini model. `step()` runs one iteration: call the model, get function call requests back, execute each browser tool via MCP, append results to the conversation history. The loop continues until the agent signals `"TESTING COMPLETE"` or `maxIterations` is reached. `finalize()` appends the blocker log and risk coverage analysis.

**`index.ts`** orchestrates everything: reads `roles.json` and `environments.json` from the app profile, creates one `McpClient` and one `AgentSession` per role, runs setup in parallel, then steps all sessions together in a `Promise.all` loop. After each pass it redraws the dashboard with `log-update`.

**`issue-ops.ts`** handles GitHub integration in both directions: test runs can be triggered by labelling an issue `testing-requested`, and findings above a severity threshold can be automatically filed as new issues with deduplication by title.

**The config system** uses an app profile structure — `apps/<AppName>/<profile>/` — so the same tool runs cleanly against different applications and environments without changing any code:

```
apps/
  BookingPlatform/
    local/
      roles.json          ← personas and credentials
      environments.json   ← URL per environment
      context/
        app-context.md    ← what the app is
        historical-bugs.md
```

Rate limiting on Gemini's free tier is handled with exponential backoff and jitter, configurable via environment variables. Running three concurrent agents with 50 iterations each generates enough calls to hit limits regularly — the backoff makes this graceful rather than fatal.

---

## Why This Matters to Us as a Development Team

Fast feedback is the point. The traditional testing pyramid gets you unit and integration coverage quickly, but exploratory coverage — *does this actually hang together as a product?* — is typically deferred to manual QA cycles that take days to schedule, run, and report on.

A run of this tool against a branch takes minutes to kick off. The output is a set of structured markdown reports with concrete steps to reproduce, not a vague "something seems off". Findings that match the historical bug list are flagged as possible regressions on the first pass.

That doesn't replace human judgment — a human tester still has to look at the reports, verify findings, and decide what matters. But it materially closes the gap between commit and feedback.

---

## What This Means If You're a Client

Testing thoroughness is often invisible to clients. You see the finished product; you don't see the investigation that found and fixed the twenty issues before it reached you.

What this approach makes possible is systematic, multi-perspective testing of every build — not just the happy paths, but the edge cases, the error recovery flows, the role-specific experience for your admins, your staff, and your end users simultaneously.

We're not pitching this as "AI replaces testers". It doesn't. What it does is make the things that previously required a full manual regression cycle happen automatically, earlier, and more consistently.

The result is software that has been genuinely explored before it gets to you.

---

## Controlling What Gets Tested (and What Doesn't)

Running AI agents against a browser isn't free. Each iteration calls the LLM, and the cost scales with: **prompt size × iterations × number of roles**. With three concurrent roles at 50 iterations each, that's 150 Gemini calls — and each one sends the full system prompt along with the accumulated conversation history.

That's manageable, but it's worth being thoughtful about. Here's how the tool lets you tune it.

### The scope file

The simplest lever is a plain markdown file — `context/testing-scope.md` — that tells the agent what to skip and what to focus on:

```markdown
## Skip

- **Form field validation** — empty fields, missing required inputs, basic type errors.
  This is comprehensively covered by unit tests. Do not spend iterations on it.

## Focus

- **Authenticated user journeys** — flows that require login and span multiple steps.
- **Role-permission boundaries** — verify each persona can only access what they should.
- **Areas from the historical bug reports** — exercise these first.
```

This directly reduces wasted iterations. An agent following this scope won't spend five turns submitting blank forms — it'll go straight to the booking flow or the admin-only routes where real gaps are more likely to exist. If your unit test coverage is strong in a particular area, you can explicitly exclude it and direct the agent's budget toward the things that unit tests can't easily reach.

### Per-role tuning in `roles.json`

Not all roles need the same depth of exploration. An anonymous guest role might only need 10 iterations to confirm public-facing pages are intact, while a platform admin role exercising backend management features might justify 50. You can now set `maxIterations` per role:

```json
{ "roles": [
  { "name": "platform admin", ..., "maxIterations": 50, "model": "gemini-2.0-flash" },
  { "name": "user",           ..., "maxIterations": 20, "model": "gemini-2.0-flash-lite" }
]}
```

`model` lets you use a cheaper, faster model for lower-risk roles — useful when you want broad coverage quickly and are willing to trade some reasoning depth on the simpler flows.

### Context caching

The system prompt — base testing guidelines, credentials, app context, historical bugs — is the same for every call within a role's session. Without caching, Gemini re-processes it on every single iteration. With caching, it's uploaded once at the start of the session and referenced by pointer for all subsequent calls.

The saving is proportional to prompt size. With a rich app-context file, the system prompt can be several thousand tokens; caching eliminates that cost for all but the first call. The tool attempts to create a cache automatically and falls back silently if the content is below Gemini's minimum threshold (32,768 tokens) — so it's opt-in by existence, not by configuration flag.

---

## What's Next

We're currently treating the tool as internal infrastructure. A few directions we're watching:

- **Cross-run diffing** — detecting when something that passed last week now fails, even if it isn't in the historical bugs list yet
- **Multi-LLM support** — the MCP layer is model-agnostic; swapping Gemini for Claude or OpenAI is a configuration change
- **Structured finding schemas** — machine-readable bug reports that plug directly into issue trackers without the intermediate markdown step
- **Coverage confidence scoring** — a quantitative measure of how thoroughly a feature area was reached, not just whether the agent visited it

The core loop — persona-aware agent, real browser, concurrent runs, structured output — is proving solid. We're building on it.

---

*Exploratory Tester is built on [Google Gemini](https://deepmind.google/technologies/gemini/), [@playwright/mcp](https://github.com/microsoft/playwright-mcp), and TypeScript.*
