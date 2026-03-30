import {
  GoogleGenerativeAI,
  type Content,
  type FunctionCall,
  type GenerateContentResult,
  type Part,
} from "@google/generative-ai";
import { GoogleAICacheManager } from "@google/generative-ai/server";
import { McpClient } from "./mcp-client.js";

export interface TokenUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

const isVerbose = process.env.VERBOSE === "true";
export function vlog(...args: any[]) {
  if (isVerbose) {
    console.log(...args);
  }
}
export function verror(...args: any[]) {
  if (isVerbose) {
    console.error(...args);
  }
}

const SYSTEM_PROMPT = `You are an expert exploratory tester. Your job is to thoroughly test a website by interacting with it through the browser tools available to you.

## Your Testing Approach

1. **Navigate** to the target URL first.
2. **Take a snapshot** of the page to understand the current state.
3. **Systematically explore** the website:
   - Click on links and navigation items to discover all pages
   - Identify and interact with forms, buttons, dropdowns, and other interactive elements
   - Test form validation by submitting empty forms, invalid data, and boundary values
   - Try special characters, very long strings, and SQL injection patterns in text inputs
   - Test navigation flows (back button, breadcrumbs, deep linking)
   - Check for broken links and missing images
   - Look for console errors after each major interaction

4. **Document issues** as you find them. Categories include:
   - **Bug**: Something is clearly broken or behaves incorrectly
   - **UX Issue**: Confusing or poor user experience
   - **Accessibility**: Missing labels, poor contrast, keyboard navigation issues
   - **Performance**: Slow loading, unresponsive elements
   - **Security Concern**: Visible in the UI (e.g., sensitive data exposure, missing HTTPS)
   - **Agent Issue**: A problem with the testing tooling itself, NOT the application — e.g. Playwright/browser errors, MCP tool failures, dev-only overlays (Next.js Dev Overlay, React error boundaries in dev mode), or other infrastructure problems that would not affect real users. Use this category whenever the issue is with how the agent interacts with the app rather than a genuine application defect.

5. After thorough exploration, provide a **final test report** summarizing:
   - Pages/areas tested
   - Issues found with severity (Critical/High/Medium/Low). For all bugs, YOU MUST include **Steps To Reproduce (STR)**, **Expected result**, **Actual result**, and any **Test Data used**. Where a server error response (e.g. 403) is the correct behaviour, add a **Note** clarifying where the fix should be applied. For **Agent Issue** items, use severity **Agent Issue** (not Critical/High/Medium/Low) so they can be distinguished from real app defects. When an error could be data-related (e.g. "unique constraint", "already exists", "duplicate"), retry with clearly different test data before reporting as a bug, and document both attempts in the STR to rule out a pre-existing data clash.
   - If historical bug reports are provided, split Issues found into two sub-sections: **Regressions** (previously reported issues confirmed still present) and **New findings** (issues not previously reported).
   - Positive observations (things that work well)
   - Recommendations

## Important Rules
- Always take a snapshot before and after significant interactions to observe changes.
- If something looks interactive, try clicking it.
- Test both happy paths and edge cases.
- If you encounter an error or unexpected behavior, try to reproduce it.
- If historical bug reports are provided, use them to prioritize high-risk areas and likely regressions first.
- Recognize blockers that prevent interaction (dialogs, modals, overlays, cookie/consent banners, permission prompts).
- Dismiss blockers when appropriate before retrying blocked interactions.
- Prefer non-destructive dismissal first (Close, Cancel, Dismiss, Reject, Escape). If needed to continue, Confirm/OK is allowed.
- If a blocker cannot be dismissed, record it and continue testing other reachable paths.
- If a browser JS dialog (alert, confirm, or prompt) appears, dismiss it immediately before continuing.
- If a browser permission prompt appears (camera, microphone, location, or notifications), deny or block it and continue testing.
- If a third-party chat widget, support overlay, or similar non-app popup appears, dismiss it and continue.
- If an interaction fails with no visible in-page blocker, the browser may have lost focus to an OS notification or another app. Take a snapshot to restore browser focus and retry the action.
- Keep track of which areas you've tested to ensure coverage.
- When you've thoroughly tested the site, state "TESTING COMPLETE" and provide your final report.`;

const BLOCKED_INTERACTION_PATTERNS = [
  /not clickable/i,
  /not interactable/i,
  /intercepted/i,
  /receives pointer events/i,
  /another element would receive the click/i,
  /element is outside of the viewport/i,
  /target closed/i,
];

const BLOCKER_HINT_PATTERNS = [
  /\bdialog\b/i,
  /aria-modal/i,
  /\bmodal\b/i,
  /\boverlay\b/i,
  /\bbackdrop\b/i,
  /cookie/i,
  /consent/i,
  /newsletter/i,
  /subscribe/i,
  /permission/i,
  /allow notifications/i,
];

const BROWSER_DIALOG_PATTERNS = [
  /role=dialog/i,
  /javascript.*dialog/i,
  /\balert\b.*button/i,
  /confirm.*dialog/i,
  /\bprompt\b.*dialog/i,
];

const PERMISSION_PROMPT_PATTERNS = [
  /wants to/i,
  /access your/i,
  /use your microphone/i,
  /use your camera/i,
  /know your location/i,
  /send.*notification/i,
  /show.*notification/i,
];

const EXTERNAL_OVERLAY_PATTERNS = [
  /intercom/i,
  /\bcrisp\b/i,
  /hubspot/i,
  /zendesk/i,
  /\bdrift\b/i,
  /\btawk\b/i,
  /livechat/i,
  /freshchat/i,
];

const DENY_PERMISSION_LABELS = [
  "block",
  "deny",
  "don't allow",
  "dont allow",
  "never",
  "disallow",
];

const SAFE_DISMISS_LABELS = [
  "close",
  "dismiss",
  "cancel",
  "not now",
  "no thanks",
  "skip",
  "later",
  "reject",
  "decline",
];

const PROCEED_LABELS = [
  "ok",
  "okay",
  "allow",
  "accept",
  "agree",
  "continue",
  "confirm",
  "yes",
];

const INTERACTABLE_TOOLS = new Set([
  "browser_click",
  "browser_fill",
  "browser_select_option",
  "browser_check",
  "browser_uncheck",
  "browser_drag_and_drop",
]);

const MAX_DISMISS_ATTEMPTS = 6;
const GEMINI_RATE_LIMIT_MAX_RETRIES = parsePositiveIntEnv(
  "GEMINI_RATE_LIMIT_MAX_RETRIES",
  5
);
const GEMINI_RATE_LIMIT_BASE_DELAY_MS = parsePositiveIntEnv(
  "GEMINI_RATE_LIMIT_BASE_DELAY_MS",
  1000
);
const GEMINI_RATE_LIMIT_MAX_DELAY_MS = parsePositiveIntEnv(
  "GEMINI_RATE_LIMIT_MAX_DELAY_MS",
  30000
);
const GEMINI_RATE_LIMIT_JITTER_MS = parsePositiveIntEnv(
  "GEMINI_RATE_LIMIT_JITTER_MS",
  500
);

interface DismissCandidate {
  ref: string;
  label: string;
  priority: number;
}

interface BlockerDetection {
  blockerSuspected: boolean;
  reason: string;
  candidates: DismissCandidate[];
}

interface RecoveryAttemptResult {
  recovered: boolean;
  reason: string;
}

interface BlockerEvent {
  phase: "suspected" | "detected" | "attempt" | "outcome";
  details: string;
}

interface UnexpectedActivityEvent {
  type: "browser-dialog" | "permission-prompt" | "external-overlay" | "focus-interference";
  source: string;
  handled: boolean;
  details: string;
}

interface RiskCoverageItem {
  risk: string;
  exercised: boolean;
}

interface GenerateContentModel {
  generateContent(input: { contents: Content[] }): Promise<GenerateContentResult>;
}

export interface TestCredentials {
  identifierType: "email" | "username";
  identifier: string;
  password: string;
}

export interface AppContext {
  mode: "file" | "auto-research";
  appVersion?: string;
  content?: string;
  sourceFile?: string;
  historicalBugReportContext?: string;
  historicalBugReportSourceFile?: string;
  testingScopeContent?: string;
  testingScopeSourceFile?: string;
  issueContext?: string;
}

export interface AgentOptions {
  apiKey: string;
  model: string;
  mcpClient: McpClient;
  targetUrl: string;
  maxIterations: number;
  roleName: string;
  testCredentials?: TestCredentials;
  appContext?: AppContext;
}

export interface AgentRunResult {
  roleName: string;
  targetUrl: string;
  model: string;
  maxIterations: number;
  iterationsExecuted: number;
  completed: boolean;
  completedAt: string;
  contextMode: "file" | "auto-research";
  contextSource?: string;
  finalReport: string;
  transcript: string[];
  tokenUsage: TokenUsage;
}

export class AgentSession {
  public options: AgentOptions;
  public rolePrefix: string;
  public transcript: string[] = [];
  public blockerEvents: BlockerEvent[] = [];
  public unexpectedActivityEvents: UnexpectedActivityEvent[] = [];
  public hasDialogTool = false;
  public contents: Content[] = [];
  
  public contextMode: "file" | "auto-research";
  public contextSource?: string;
  public historicalBugReportSource?: string;
  public testingScopeSource?: string;
  public researchSummary?: string;
  
  public genAI: GoogleGenerativeAI;
  public generativeModel!: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;
  
  public completed = false;
  public finalReport = "No final report produced.";
  public iterationsExecuted = 0;
  public lastAction = "Initializing...";
  public tokenUsage: TokenUsage = { promptTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 };

  constructor(options: AgentOptions) {
    this.options = options;
    this.rolePrefix = `[${options.roleName}]`;
    this.genAI = new GoogleGenerativeAI(options.apiKey);
    this.contextMode = options.appContext?.mode ?? "auto-research";
    this.contextSource = options.appContext?.sourceFile;
    this.historicalBugReportSource = options.appContext?.historicalBugReportSourceFile;
    this.testingScopeSource = options.appContext?.testingScopeSourceFile;
  }

  async setup() {
    const { model, mcpClient, targetUrl, maxIterations, roleName, testCredentials, appContext } = this.options;
    
    this.transcript.push(`${this.rolePrefix} Starting exploratory testing of: ${targetUrl}`);
    this.transcript.push(`${this.rolePrefix} Model: ${model} | Max iterations: ${maxIterations}`);

    if (this.contextMode === "auto-research") {
      vlog(`${this.rolePrefix} Running quick pre-test research pass...`);
      this.transcript.push(`${this.rolePrefix} Running quick pre-test research pass.`);
      this.researchSummary = await runQuickResearch(mcpClient, targetUrl);
      this.transcript.push(`${this.rolePrefix} Research summary: ${this.researchSummary}`);
    }

    const functionDeclarations = await mcpClient.getGeminiFunctionDeclarations();
    vlog(`${this.rolePrefix} Loaded ${functionDeclarations.length} browser tools from Playwright MCP`);
    this.hasDialogTool = functionDeclarations.some((fd) => fd.name === "browser_handle_dialog");

    const systemPrompt = buildSystemPrompt(testCredentials, appContext, this.researchSummary);
    const cacheTtlSeconds = parsePositiveIntEnv("GEMINI_CACHE_TTL_SECONDS", 600);
    let cacheUsed = false;

    try {
      const cacheManager = new GoogleAICacheManager(this.options.apiKey);
      const cache = await cacheManager.create({
        model,
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        ttlSeconds: cacheTtlSeconds,
        contents: [],
      });
      this.generativeModel = this.genAI.getGenerativeModelFromCachedContent(cache, {
        tools: [{ functionDeclarations }],
      });
      cacheUsed = true;
      this.transcript.push(`${this.rolePrefix} [cache created: TTL ${cacheTtlSeconds}s, name=${cache.name}]`);
      vlog(`${this.rolePrefix} Context cache created (${cache.name})`);
    } catch (cacheErr) {
      const reason = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
      this.transcript.push(`${this.rolePrefix} [cache skipped: ${reason.slice(0, 120)}]`);
      vlog(`${this.rolePrefix} Context cache skipped: ${reason}`);
    }

    if (!cacheUsed) {
      this.generativeModel = this.genAI.getGenerativeModel({
        model,
        tools: [{ functionDeclarations }],
        systemInstruction: systemPrompt,
      });
    }

    const initialInstruction = buildInitialInstruction(targetUrl, appContext, this.researchSummary);

    this.contents.push({
      role: "user",
      parts: [{ text: initialInstruction }],
    });

    vlog(`\n${"=".repeat(60)}`);
    vlog(`${this.rolePrefix} Starting exploratory testing of: ${targetUrl}`);
    vlog(`${this.rolePrefix} Model: ${model} | Max iterations: ${maxIterations}`);
    vlog(`${this.rolePrefix} App context mode: ${this.contextMode}`);
    if (this.contextSource) vlog(`${this.rolePrefix} App context file: ${this.contextSource}`);
    if (testCredentials) vlog(`${this.rolePrefix} Authenticated testing enabled with ${testCredentials.identifierType} credentials.`);
    vlog(`${"=".repeat(60)}\n`);

    this.transcript.push(`${this.rolePrefix} App context mode: ${this.contextMode}`);
    if (this.contextSource) this.transcript.push(`${this.rolePrefix} App context file: ${this.contextSource}`);
    if (this.historicalBugReportSource) this.transcript.push(`${this.rolePrefix} Historical bug reports file: ${this.historicalBugReportSource}`);
    if (this.testingScopeSource) this.transcript.push(`${this.rolePrefix} Testing scope file: ${this.testingScopeSource}`);
    if (testCredentials) this.transcript.push(`${this.rolePrefix} Authenticated testing enabled with ${testCredentials.identifierType} credentials.`);
  }

  async step() {
    if (this.completed || this.iterationsExecuted >= this.options.maxIterations) {
      return;
    }

    this.iterationsExecuted++;
    const iteration = this.iterationsExecuted;
    const { maxIterations, mcpClient } = this.options;

    vlog(`${this.rolePrefix} --- Iteration ${iteration}/${maxIterations} ---`);
    this.transcript.push(`\n--- Iteration ${iteration}/${maxIterations} ---`);

    let result;
    try {
      result = await generateContentWithBackoff({
        model: this.generativeModel,
        contents: this.contents,
        rolePrefix: this.rolePrefix,
        transcript: this.transcript,
      });
    } catch (error) {
      verror("Gemini API error:", error);
      this.transcript.push(`Gemini API error: ${error instanceof Error ? error.message : String(error)}`);
      this.completed = true;
      return;
    }

    const response = result.response;
    const meta = response.usageMetadata;
    if (meta) {
      this.tokenUsage.promptTokens += meta.promptTokenCount ?? 0;
      this.tokenUsage.outputTokens += meta.candidatesTokenCount ?? 0;
      this.tokenUsage.totalTokens += meta.totalTokenCount ?? 0;
      this.tokenUsage.cachedTokens += meta.cachedContentTokenCount ?? 0;
    }
    const functionCalls = response.functionCalls();
    let textResponse: string | undefined;

    try {
      textResponse = response.text();
    } catch {
      // empty string fallback
    }

    if (textResponse) {
      vlog(`\n${this.rolePrefix} [Agent]: ${textResponse}\n`);
      this.lastAction = "Reasoning & Emitting Tool Calls...";
      this.transcript.push(`[Agent] ${textResponse}`);
    }

    if (textResponse?.includes("TESTING COMPLETE")) {
      vlog(`\n${"=".repeat(60)}`);
      this.lastAction = "TESTING COMPLETE"; vlog(`${this.rolePrefix} Agent has completed exploratory testing.`);
      vlog(`${"=".repeat(60)}\n`);
      this.completed = true;
      this.finalReport = textResponse;
      this.transcript.push("Agent signaled TESTING COMPLETE.");
      return;
    }

    if (functionCalls && functionCalls.length > 0) {
      const modelParts: Part[] = [];
      if (textResponse) modelParts.push({ text: textResponse });
      for (const fc of functionCalls) modelParts.push({ functionCall: fc });
      this.contents.push({ role: "model", parts: modelParts });

      const functionResponseParts: Part[] = [];

      for (const fc of functionCalls) {
        this.lastAction = `Using tool: ${fc.name}`; vlog(`${this.rolePrefix} -> Calling tool: ${fc.name}`);
        this.transcript.push(`Tool call: ${fc.name}`);
        try {
          const toolResult = await mcpClient.callTool(fc.name, (fc.args as Record<string, unknown>) ?? {});
          const resultContent = extractMcpResultText(toolResult);
          const truncated = truncateResult(resultContent, 8000);

          functionResponseParts.push({
            functionResponse: { name: fc.name, response: { result: truncated } },
          });
          this.transcript.push(`Tool result (${fc.name}): ${truncateResult(truncated, 600)}`);
        } catch (error) {
          verror(`${this.rolePrefix} !! Tool error (${fc.name}):`, error);
          let errorMessage = error instanceof Error ? error.message : String(error);

          if (isRecoverableInteractionFailure(fc.name, errorMessage)) {
            this.transcript.push(`Unexpected activity suspected after ${fc.name} failure. Attempting recovery.`);
            const recoveryResult = await attemptUnexpectedActivityRecovery(
              mcpClient, this.rolePrefix, this.transcript, errorMessage,
              this.blockerEvents, this.unexpectedActivityEvents, this.hasDialogTool, fc.name
            );
            this.transcript.push(`Recovery outcome: ${recoveryResult.reason}`);

            if (recoveryResult.recovered) {
              try {
                const retryResult = await mcpClient.callTool(fc.name, (fc.args as Record<string, unknown>) ?? {});
                const retryContent = extractMcpResultText(retryResult);
                const truncatedRetry = truncateResult(retryContent, 8000);
                functionResponseParts.push({
                  functionResponse: { name: fc.name, response: { result: truncatedRetry } },
                });
                this.transcript.push(`Tool retry result (${fc.name}): ${truncateResult(truncatedRetry, 600)}`);
                continue;
              } catch (retryError) {
                errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
                this.transcript.push(`Tool retry error (${fc.name}): ${errorMessage}`);
              }
            }
          }

          this.transcript.push(`Tool error (${fc.name}): ${errorMessage}`);
          functionResponseParts.push({ functionResponse: { name: fc.name, response: { error: errorMessage } } });
        }
      }
      this.contents.push({ role: "user", parts: functionResponseParts });
    } else {
      this.contents.push({ role: "model", parts: [{ text: textResponse ?? "" }] });
      if (this.iterationsExecuted < this.options.maxIterations) {
        this.contents.push({
          role: "user",
          parts: [{ text: "Continue testing. If you've covered all areas, provide your final report and state TESTING COMPLETE." }],
        });
      }
    }
  }

  finalize(): AgentRunResult {
    vlog(`\n${this.rolePrefix} Agent loop finished after processing conversation turns.\n`);

    if (!this.finalReport) {
      const lastAgentEntry = [...this.transcript].reverse().find(
        (line) => line.startsWith("[Agent Final Timeout Report] ") || line.startsWith("[Agent] ")
      ) ?? "";
      if (lastAgentEntry) {
        this.finalReport = lastAgentEntry
          .replace("[Agent Final Timeout Report] ", "")
          .replace("[Agent] ", "");
      }
    }

    this.finalReport = appendBlockerSummary(this.finalReport, this.blockerEvents);
    this.finalReport = appendUnexpectedActivitySummary(this.finalReport, this.unexpectedActivityEvents);
    this.finalReport = appendRiskRetestCoverage(this.finalReport, this.options.appContext?.historicalBugReportContext, this.transcript);

    return {
      roleName: this.options.roleName,
      targetUrl: this.options.targetUrl,
      model: this.options.model,
      maxIterations: this.options.maxIterations,
      iterationsExecuted: this.iterationsExecuted,
      completed: this.completed,
      completedAt: new Date().toISOString(),
      contextMode: this.contextMode,
      contextSource: this.contextSource,
      finalReport: this.finalReport,
      transcript: this.transcript,
      tokenUsage: this.tokenUsage,
    };
  }
}

export async function runAgent(options: AgentOptions): Promise<AgentRunResult> {
  const session = new AgentSession(options);
  await session.setup();

  while (!session.completed && session.iterationsExecuted < options.maxIterations) {
    await session.step();
  }

  if (!session.completed) {
    console.log(`\n${session.rolePrefix} Max iterations (${options.maxIterations}) reached. Forcing final report generation.`);
    session.transcript.push(`\n--- Max iterations reached. Forcing final report generation. ---`);
    session.contents.push({
      role: "user",
      parts: [{ text: "maxIterations reached. Testing time is up. Please provide your final test report immediately, including any Issues found split into Regressions (known issues confirmed) and New findings (with Steps To Reproduce, Expected result, Actual result, and Test Data used for each), Positive observations, and Recommendations. State TESTING COMPLETE at the end." }],
    });
    session.completed = true;

    try {
      const result = await generateContentWithBackoff({
        model: session.generativeModel,
        contents: session.contents,
        rolePrefix: session.rolePrefix,
        transcript: session.transcript,
      });
      const response = result.response;
      const forcedMeta = response.usageMetadata;
      if (forcedMeta) {
        session.tokenUsage.promptTokens += forcedMeta.promptTokenCount ?? 0;
        session.tokenUsage.outputTokens += forcedMeta.candidatesTokenCount ?? 0;
        session.tokenUsage.totalTokens += forcedMeta.totalTokenCount ?? 0;
        session.tokenUsage.cachedTokens += forcedMeta.cachedContentTokenCount ?? 0;
      }
      let textResponse: string | undefined;
      try {
        textResponse = response.text();
      } catch {
        // empty string fallback
      }
      
      if (textResponse) {
        console.log(`\n${session.rolePrefix} [Agent Final Timeout Report]:\n${textResponse}\n`);
        session.transcript.push(`[Agent Final Timeout Report] ${textResponse}`);
        session.finalReport = textResponse;
      }
    } catch (error) {
      console.error(`\n${session.rolePrefix} Failed to generate forced final report:`, error);
      session.transcript.push(`Failed to generate forced final report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return session.finalize();
}

function extractMcpResultText(result: unknown): string {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (r.isError) {
    const errorText =
      r.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "Unknown error";
    return `ERROR: ${errorText}`;
  }

  if (r.content) {
    return r.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  return JSON.stringify(result);
}

function truncateResult(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n... [truncated]";
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGeminiRateLimitError(error: unknown): boolean {
  const candidate = error as { status?: number; message?: string };
  if (candidate?.status === 429) {
    return true;
  }

  const message = (candidate?.message ?? "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("resource exhausted")
  );
}

function calculateBackoffDelayMs(attempt: number): number {
  const exponential = Math.min(
    GEMINI_RATE_LIMIT_MAX_DELAY_MS,
    GEMINI_RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1)
  );
  const jitter = Math.floor(Math.random() * GEMINI_RATE_LIMIT_JITTER_MS);
  return exponential + jitter;
}

async function generateContentWithBackoff(args: {
  model: GenerateContentModel;
  contents: Content[];
  rolePrefix: string;
  transcript: string[];
}): Promise<GenerateContentResult> {
  const { model, contents, rolePrefix, transcript } = args;

  for (let attempt = 1; attempt <= GEMINI_RATE_LIMIT_MAX_RETRIES + 1; attempt++) {
    try {
      return await model.generateContent({ contents });
    } catch (error) {
      const shouldRetry =
        isGeminiRateLimitError(error) &&
        attempt <= GEMINI_RATE_LIMIT_MAX_RETRIES;

      if (!shouldRetry) {
        throw error;
      }

      const delayMs = calculateBackoffDelayMs(attempt);
      const message = `${rolePrefix} Gemini 429 rate limit hit. Retrying in ${delayMs}ms (${attempt}/${GEMINI_RATE_LIMIT_MAX_RETRIES}).`;
      console.warn(message);
      transcript.push(message);
      await sleep(delayMs);
    }
  }

  throw new Error("Gemini request failed after retry attempts.");
}

function isRecoverableInteractionFailure(
  toolName: string,
  errorMessage: string
): boolean {
  if (!INTERACTABLE_TOOLS.has(toolName)) {
    return false;
  }
  return BLOCKED_INTERACTION_PATTERNS.some((pattern) =>
    pattern.test(errorMessage)
  );
}

function classifyActivity(
  snapshotText: string
): "browser-dialog" | "permission-prompt" | "external-overlay" | "in-app-blocker" | "focus-interference" {
  if (BROWSER_DIALOG_PATTERNS.some((p) => p.test(snapshotText))) {
    return "browser-dialog";
  }
  if (PERMISSION_PROMPT_PATTERNS.some((p) => p.test(snapshotText))) {
    return "permission-prompt";
  }
  if (EXTERNAL_OVERLAY_PATTERNS.some((p) => p.test(snapshotText))) {
    return "external-overlay";
  }
  if (BLOCKER_HINT_PATTERNS.some((p) => p.test(snapshotText))) {
    return "in-app-blocker";
  }
  return "focus-interference";
}

function parseDismissCandidates(snapshotText: string): DismissCandidate[] {
  const candidates = new Map<string, DismissCandidate>();
  const lines = snapshotText.split(/\r?\n/);

  for (const line of lines) {
    const refMatch = line.match(/\[ref=([^\]]+)\]/i);
    if (!refMatch) {
      continue;
    }
    const ref = refMatch[1].trim();
    if (!ref) {
      continue;
    }

    const quoted = line.match(/"([^"]+)"/);
    const rawLabel = quoted?.[1] ?? line.replace(/\[ref=[^\]]+\]/i, "").trim();
    const label = rawLabel.toLowerCase();

    let priority = Number.POSITIVE_INFINITY;
    if (SAFE_DISMISS_LABELS.some((token) => label.includes(token))) {
      priority = 1;
    } else if (PROCEED_LABELS.some((token) => label.includes(token))) {
      priority = 2;
    }

    if (!Number.isFinite(priority)) {
      continue;
    }

    const existing = candidates.get(ref);
    if (!existing || priority < existing.priority) {
      candidates.set(ref, { ref, label: rawLabel, priority });
    }
  }

  return [...candidates.values()].sort((a, b) => a.priority - b.priority);
}

function detectBlockers(snapshotText: string): BlockerDetection {
  const blockerSuspected = BLOCKER_HINT_PATTERNS.some((pattern) =>
    pattern.test(snapshotText)
  );
  const candidates = parseDismissCandidates(snapshotText).slice(
    0,
    MAX_DISMISS_ATTEMPTS
  );

  if (!blockerSuspected && candidates.length === 0) {
    return {
      blockerSuspected: false,
      reason: "No blocker indicators found in snapshot.",
      candidates: [],
    };
  }

  return {
    blockerSuspected: true,
    reason: blockerSuspected
      ? "Modal/overlay indicators present in snapshot."
      : "Dismiss controls detected in snapshot.",
    candidates,
  };
}

async function safeSnapshotText(mcpClient: McpClient): Promise<string> {
  const snapshotResult = await mcpClient.callTool("browser_snapshot", {});
  return extractMcpResultText(snapshotResult);
}

async function dismissWithCandidates(
  mcpClient: McpClient,
  transcript: string[],
  candidates: DismissCandidate[],
  blockerEvents: BlockerEvent[]
): Promise<RecoveryAttemptResult> {
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_DISMISS_ATTEMPTS) {
      break;
    }
    attempts += 1;
    blockerEvents.push({ phase: "attempt", details: `Attempt ${attempts}: click ${candidate.label} (ref=${candidate.ref}).` });
    transcript.push(`Dismiss attempt ${attempts}: clicking ${candidate.label} (ref=${candidate.ref}).`);
    try {
      await mcpClient.callTool("browser_click", { ref: candidate.ref, element: candidate.label });
      const postSnapshot = await safeSnapshotText(mcpClient);
      const postDetection = detectBlockers(postSnapshot);
      if (!postDetection.blockerSuspected) {
        return { recovered: true, reason: `Dismissed via ${candidate.label}.` };
      }
    } catch (candidateError) {
      const message = candidateError instanceof Error ? candidateError.message : String(candidateError);
      transcript.push(`Dismiss click failed for ${candidate.label} (ref=${candidate.ref}): ${message}`);
    }
  }

  try {
    transcript.push("Dismiss fallback: sending Escape key.");
    await mcpClient.callTool("browser_press_key", { key: "Escape" });
    const postEscapeSnapshot = await safeSnapshotText(mcpClient);
    const postEscapeDetection = detectBlockers(postEscapeSnapshot);
    if (!postEscapeDetection.blockerSuspected) {
      return { recovered: true, reason: "Dismissed via Escape key." };
    }
  } catch (escapeError) {
    const message = escapeError instanceof Error ? escapeError.message : String(escapeError);
    transcript.push(`Escape key fallback failed: ${message}`);
  }

  return { recovered: false, reason: "Could not be dismissed. Continuing with alternate paths." };
}

async function attemptFocusRestoration(
  mcpClient: McpClient,
  _rolePrefix: string,
  transcript: string[],
  toolName: string,
  unexpectedActivityEvents: UnexpectedActivityEvent[]
): Promise<RecoveryAttemptResult> {
  transcript.push("Focus interference recovery: taking snapshot to restore browser focus.");
  try {
    await mcpClient.callTool("browser_snapshot", {});
    unexpectedActivityEvents.push({
      type: "focus-interference",
      source: toolName,
      handled: true,
      details: "Snapshot taken to restore browser focus after suspected OS-level interference.",
    });
    return { recovered: true, reason: "Focus restored via snapshot — potential OS notification interference." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    unexpectedActivityEvents.push({
      type: "focus-interference",
      source: toolName,
      handled: false,
      details: `Focus restoration failed: ${message}`,
    });
    return { recovered: false, reason: `Focus restoration snapshot failed: ${message}` };
  }
}

async function attemptUnexpectedActivityRecovery(
  mcpClient: McpClient,
  rolePrefix: string,
  transcript: string[],
  originalError: string,
  blockerEvents: BlockerEvent[],
  unexpectedActivityEvents: UnexpectedActivityEvent[],
  hasDialogTool: boolean,
  toolName: string
): Promise<RecoveryAttemptResult> {
  let snapshotText = "";
  try {
    snapshotText = await safeSnapshotText(mcpClient);
  } catch (snapshotError) {
    const message = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
    return { recovered: false, reason: `Could not capture snapshot for recovery: ${message}` };
  }

  const activityType = classifyActivity(snapshotText);
  transcript.push(`Activity classified as: ${activityType}.`);

  if (activityType === "focus-interference") {
    return attemptFocusRestoration(mcpClient, rolePrefix, transcript, toolName, unexpectedActivityEvents);
  }

  const detection = detectBlockers(snapshotText);

  if (activityType === "browser-dialog") {
    unexpectedActivityEvents.push({ type: "browser-dialog", source: toolName, handled: false, details: "Browser JS dialog detected." });
    if (hasDialogTool) {
      try {
        transcript.push("Browser dialog recovery: calling browser_handle_dialog({ action: 'dismiss' }).");
        await mcpClient.callTool("browser_handle_dialog", { action: "dismiss" });
        unexpectedActivityEvents[unexpectedActivityEvents.length - 1].handled = true;
        return { recovered: true, reason: "Browser JS dialog dismissed via browser_handle_dialog." };
      } catch (dialogError) {
        const message = dialogError instanceof Error ? dialogError.message : String(dialogError);
        transcript.push(`browser_handle_dialog failed: ${message}. Falling back to Escape.`);
      }
    }
    try {
      transcript.push("Browser dialog fallback: sending Escape key.");
      await mcpClient.callTool("browser_press_key", { key: "Escape" });
      const postEscape = await safeSnapshotText(mcpClient);
      if (!BROWSER_DIALOG_PATTERNS.some((p) => p.test(postEscape))) {
        unexpectedActivityEvents[unexpectedActivityEvents.length - 1].handled = true;
        return { recovered: true, reason: "Browser JS dialog dismissed via Escape key." };
      }
    } catch (escapeError) {
      const msg = escapeError instanceof Error ? escapeError.message : String(escapeError);
      transcript.push(`Escape fallback failed: ${msg}`);
    }
    return { recovered: false, reason: "Browser JS dialog could not be dismissed." };
  }

  if (activityType === "permission-prompt") {
    unexpectedActivityEvents.push({ type: "permission-prompt", source: toolName, handled: false, details: "Browser permission prompt detected." });
    const denyCandidates = detection.candidates.filter((c) =>
      DENY_PERMISSION_LABELS.some((label) => c.label.toLowerCase().includes(label))
    );
    const orderedCandidates = [
      ...denyCandidates,
      ...detection.candidates.filter((c) => !denyCandidates.includes(c)),
    ].slice(0, MAX_DISMISS_ATTEMPTS);
    for (const candidate of orderedCandidates) {
      try {
        transcript.push(`Permission prompt recovery: clicking ${candidate.label} (ref=${candidate.ref}).`);
        await mcpClient.callTool("browser_click", { ref: candidate.ref, element: candidate.label });
        unexpectedActivityEvents[unexpectedActivityEvents.length - 1].handled = true;
        unexpectedActivityEvents[unexpectedActivityEvents.length - 1].details = `Permission prompt dismissed via ${candidate.label}.`;
        return { recovered: true, reason: `Permission prompt dismissed via ${candidate.label}.` };
      } catch {
        // try next candidate
      }
    }
    return { recovered: false, reason: "Permission prompt could not be dismissed." };
  }

  if (activityType === "external-overlay") {
    unexpectedActivityEvents.push({ type: "external-overlay", source: toolName, handled: false, details: "Third-party overlay detected." });
    const result = await dismissWithCandidates(mcpClient, transcript, detection.candidates, blockerEvents);
    if (result.recovered) {
      unexpectedActivityEvents[unexpectedActivityEvents.length - 1].handled = true;
      unexpectedActivityEvents[unexpectedActivityEvents.length - 1].details = `Third-party overlay dismissed: ${result.reason}`;
    }
    return result;
  }

  // in-app-blocker — preserve existing behaviour, log to blockerEvents
  blockerEvents.push({ phase: "suspected", details: `${toolName} failed with recoverable interaction error: ${originalError}` });
  blockerEvents.push({ phase: "detected", details: `${detection.reason} Candidates: ${detection.candidates.length}.` });
  transcript.push(`Blocker detection: ${detection.reason} Candidates: ${detection.candidates.length}.`);

  if (!detection.blockerSuspected) {
    blockerEvents.push({ phase: "outcome", details: "Recovery skipped. No clear blocker in snapshot." });
    return { recovered: false, reason: `Recovery skipped. Original error: ${originalError}` };
  }

  const inAppResult = await dismissWithCandidates(mcpClient, transcript, detection.candidates, blockerEvents);
  blockerEvents.push({ phase: "outcome", details: inAppResult.reason });
  return inAppResult;
}

function buildSystemPrompt(
  testCredentials?: TestCredentials,
  appContext?: AppContext,
  researchSummary?: string
): string {
  let prompt = SYSTEM_PROMPT;

  if (appContext?.appVersion) {
    prompt += `

## Application Version
- You are testing version ${appContext.appVersion} of the application.
- Prioritize verifying fixes for bugs reported in previous versions, and confirm new features specific to this release version if documented.`;
  }

  if (testCredentials) {
    prompt += `

## Optional Login Context
- Credentials are available for authenticated testing.
- Identifier type: ${testCredentials.identifierType}
- Identifier value: ${testCredentials.identifier}
- Password: ${testCredentials.password}
- If the target website has a login flow, attempt login and then continue exploratory testing across authenticated areas.
- If no login flow is visible, continue with anonymous exploratory testing.`;
  }

  if (appContext?.mode === "file" && appContext.content) {
    prompt += `

## Application Context (Provided)
- This context defines the role's capabilities and the features available to them.
- Treat every capability listed as something that MUST be tested. Derive test scenarios directly from this context — if a capability is listed, exercise it.
- Use your judgment to identify both happy-path and edge-case scenarios for each capability.
- Prioritize observed UI behavior and tool outputs over assumptions, but do not skip a capability simply because it isn't immediately visible.

${truncateResult(appContext.content, 12000)}`;
  }

  if (appContext?.issueContext) {
    prompt += `

## Issue Context (Test Charter)
- This issue defines the objective and scope for this test run.
- Treat every capability, scenario, or objective described here as something that MUST be exercised.
- Derive both happy-path and edge-case scenarios from this context.
- This supplements (does not replace) the Application Context above — honour both.

${truncateResult(appContext.issueContext, 4000)}`;
  }

  if (appContext?.testingScopeContent) {
    prompt += `

## Testing Scope
- These directives define what to focus on or skip during this run. Follow them precisely to avoid wasting effort on areas already covered elsewhere.

${truncateResult(appContext.testingScopeContent, 4000)}`;
  }

  if (appContext?.historicalBugReportContext) {
    prompt += `

## Historical Bug Reports (Risk Context)
- Use these historical defects to prioritize risk-based exploration.
- Start by retesting previously affected areas and nearby user journeys.
- Actively look for regressions and variants of known failures.
- Do not waste time testing areas known to be broken. Use these known issues to steer clear of broken features, focus your exploration on other areas, and avoid reporting duplicate bugs.

${truncateResult(appContext.historicalBugReportContext, 10000)}`;
  }

  if (researchSummary) {
    prompt += `

## Application Context (Quick Research)
- This was discovered before the main testing loop. Use it as guidance and validate findings during exploration.

${truncateResult(researchSummary, 4000)}`;
  }

  return prompt;
}

function appendBlockerSummary(
  reportText: string,
  blockerEvents: BlockerEvent[]
): string {
  if (blockerEvents.length === 0) {
    return reportText;
  }

  const suspectedCount = blockerEvents.filter(
    (event) => event.phase === "suspected"
  ).length;
  const detectionEvents = blockerEvents.filter(
    (event) => event.phase === "detected"
  );
  const attemptCount = blockerEvents.filter(
    (event) => event.phase === "attempt"
  ).length;
  const recoveredCount = blockerEvents.filter(
    (event) =>
      event.phase === "outcome" && /dismissed blocker via/i.test(event.details)
  ).length;
  const unresolvedCount = blockerEvents.filter(
    (event) =>
      event.phase === "outcome" && /could not be dismissed/i.test(event.details)
  ).length;

  const uniqueDetectionReasons = [...new Set(detectionEvents.map((e) => e.details))]
    .slice(0, 5)
    .map((reason) => `- ${reason}`)
    .join("\n");

  const summaryLines = [
    "## Blocker Handling Summary",
    `- Suspected blockers: ${suspectedCount}`,
    `- Dismiss attempts: ${attemptCount}`,
    `- Recovered interactions: ${recoveredCount}`,
    `- Unresolved blockers: ${unresolvedCount}`,
  ];

  if (uniqueDetectionReasons) {
    summaryLines.push("- Detection signals:");
    summaryLines.push(uniqueDetectionReasons);
  }

  return `${reportText.trim()}\n\n${summaryLines.join("\n")}`;
}

function appendUnexpectedActivitySummary(
  reportText: string,
  events: UnexpectedActivityEvent[]
): string {
  if (events.length === 0) {
    return reportText;
  }

  const byType: Record<string, UnexpectedActivityEvent[]> = {
    "browser-dialog": events.filter((e) => e.type === "browser-dialog"),
    "permission-prompt": events.filter((e) => e.type === "permission-prompt"),
    "external-overlay": events.filter((e) => e.type === "external-overlay"),
    "focus-interference": events.filter((e) => e.type === "focus-interference"),
  };

  const handledCount = events.filter((e) => e.handled).length;
  const unhandledCount = events.length - handledCount;

  const summaryLines = [
    "## Unexpected Activity Summary",
    `- Total unexpected activity events: ${events.length}`,
    `- Handled: ${handledCount} | Unhandled: ${unhandledCount}`,
  ];

  for (const [type, typeEvents] of Object.entries(byType)) {
    if (typeEvents.length > 0) {
      summaryLines.push(`- ${type}: ${typeEvents.length} (${typeEvents.filter((e) => e.handled).length} handled)`);
    }
  }

  summaryLines.push("- Detail:");
  for (const event of events) {
    summaryLines.push(`  - [${event.handled ? "HANDLED" : "UNHANDLED"}] ${event.type} (triggered by ${event.source}): ${event.details}`);
  }

  return `${reportText.trim()}\n\n${summaryLines.join("\n")}`;
}

function extractHistoricalRiskItems(historicalBugReportContext: string): string[] {
  const lines = historicalBugReportContext
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items: string[] = [];
  for (const line of lines) {
    if (/^[-*]\s+/.test(line)) {
      items.push(line.replace(/^[-*]\s+/, "").trim());
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      items.push(line.replace(/^\d+\.\s+/, "").trim());
    }
  }

  return items.slice(0, 15);
}

function keywordsFromRisk(risk: string): string[] {
  return risk
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .slice(0, 8);
}

function computeRiskCoverage(
  historicalBugReportContext: string,
  transcript: string[]
): RiskCoverageItem[] {
  const risks = extractHistoricalRiskItems(historicalBugReportContext);
  if (risks.length === 0) {
    return [];
  }

  const transcriptBlob = transcript.join("\n").toLowerCase();
  return risks.map((risk) => {
    const keywords = keywordsFromRisk(risk);
    const matches = keywords.filter((keyword) => transcriptBlob.includes(keyword));
    const exercised = keywords.length > 0 && matches.length >= Math.min(2, keywords.length);
    return {
      risk,
      exercised,
    };
  });
}

function appendRiskRetestCoverage(
  reportText: string,
  historicalBugReportContext: string | undefined,
  transcript: string[]
): string {
  if (!historicalBugReportContext) {
    return reportText;
  }

  const coverage = computeRiskCoverage(historicalBugReportContext, transcript);
  if (coverage.length === 0) {
    return reportText;
  }

  const exercised = coverage.filter((item) => item.exercised).length;
  const unclear = coverage.length - exercised;

  const summaryLines = [
    "## Risk Retest Coverage",
    `- Historical risk items considered: ${coverage.length}`,
    `- Clearly exercised during run: ${exercised}`,
    `- Not clearly exercised: ${unclear}`,
    "- Coverage detail:",
    ...coverage.map(
      (item) =>
        `- [${item.exercised ? "EXERCISED" : "NOT CLEAR"}] ${item.risk}`
    ),
  ];

  return `${reportText.trim()}\n\n${summaryLines.join("\n")}`;
}

function buildInitialInstruction(
  targetUrl: string,
  appContext?: AppContext,
  researchSummary?: string
): string {
  if (appContext?.mode === "file") {
    return `Use the provided application context, then navigate to ${targetUrl} and begin exploratory testing. Be thorough — test forms, links, navigation, edge cases, and interactive elements. Report any bugs, UX issues, accessibility problems, or security concerns you find.`;
  }

  if (researchSummary) {
    return `Use the quick research summary as starting context, then continue exploratory testing at ${targetUrl}. Be thorough — test forms, links, navigation, edge cases, and interactive elements. Report any bugs, UX issues, accessibility problems, or security concerns you find.`;
  }

  return `Navigate to ${targetUrl} and begin exploratory testing. Be thorough — test forms, links, navigation, edge cases, and interactive elements. Report any bugs, UX issues, accessibility problems, or security concerns you find.`;
}

async function runQuickResearch(
  mcpClient: McpClient,
  targetUrl: string
): Promise<string> {
  const notes: string[] = [];

  try {
    const navResult = await mcpClient.callTool("browser_navigate", {
      url: targetUrl,
    });
    notes.push(
      `Navigation result:\n${truncateResult(extractMcpResultText(navResult), 2500)}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`Navigation failed during quick research: ${message}`);
    return notes.join("\n\n");
  }

  try {
    const snapshotResult = await mcpClient.callTool("browser_snapshot", {});
    notes.push(
      `Homepage snapshot:\n${truncateResult(
        extractMcpResultText(snapshotResult),
        4500
      )}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`Snapshot failed during quick research: ${message}`);
  }

  return notes.join("\n\n");
}
