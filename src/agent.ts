import {
  GoogleGenerativeAI,
  type Content,
  type FunctionCall,
  type GenerateContentResult,
  type Part,
} from "@google/generative-ai";
import { McpClient } from "./mcp-client.js";


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

5. After thorough exploration, provide a **final test report** summarizing:
   - Pages/areas tested
   - Issues found with severity (Critical/High/Medium/Low). For all bugs, YOU MUST include **Steps To Reproduce (STR)** and any **Test Data used**.
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
}

export class AgentSession {
  public options: AgentOptions;
  public rolePrefix: string;
  public transcript: string[] = [];
  public blockerEvents: BlockerEvent[] = [];
  public contents: Content[] = [];
  
  public contextMode: "file" | "auto-research";
  public contextSource?: string;
  public historicalBugReportSource?: string;
  public researchSummary?: string;
  
  public genAI: GoogleGenerativeAI;
  public generativeModel!: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;
  
  public completed = false;
  public finalReport = "No final report produced.";
  public iterationsExecuted = 0;
  public lastAction = "Initializing...";

  constructor(options: AgentOptions) {
    this.options = options;
    this.rolePrefix = `[${options.roleName}]`;
    this.genAI = new GoogleGenerativeAI(options.apiKey);
    this.contextMode = options.appContext?.mode ?? "auto-research";
    this.contextSource = options.appContext?.sourceFile;
    this.historicalBugReportSource = options.appContext?.historicalBugReportSourceFile;
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

    this.generativeModel = this.genAI.getGenerativeModel({
      model,
      tools: [{ functionDeclarations }],
      systemInstruction: buildSystemPrompt(testCredentials, appContext, this.researchSummary),
    });

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
            this.blockerEvents.push({ phase: "suspected", details: `${fc.name} failed with recoverable interaction error: ${errorMessage}` });
            this.transcript.push(`Blocker suspected after ${fc.name} failure. Attempting blocker recovery.`);
            const recoveryResult = await attemptBlockerRecovery(mcpClient, this.rolePrefix, this.transcript, errorMessage, this.blockerEvents);
            this.transcript.push(`Blocker recovery outcome: ${recoveryResult.reason}`);
            this.blockerEvents.push({ phase: "outcome", details: recoveryResult.reason });

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

    if (!this.completed) {
      const lastAgentEntry = [...this.transcript].reverse().find((line) => line.startsWith("[Agent] ")) ?? "";
      if (lastAgentEntry) {
        this.finalReport = lastAgentEntry.replace("[Agent] ", "");
      }
    }

    this.finalReport = appendBlockerSummary(this.finalReport, this.blockerEvents);
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
      parts: [{ text: "maxIterations reached. Testing time is up. Please provide your final test report immediately, including any Issues found (with Steps To Reproduce and Test Data used), Positive observations, and Recommendations. State TESTING COMPLETE at the end." }],
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
  if (toolName !== "browser_click") {
    return false;
  }
  return BLOCKED_INTERACTION_PATTERNS.some((pattern) =>
    pattern.test(errorMessage)
  );
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

async function attemptBlockerRecovery(
  mcpClient: McpClient,
  rolePrefix: string,
  transcript: string[],
  originalError: string,
  blockerEvents: BlockerEvent[]
): Promise<RecoveryAttemptResult> {
  let snapshotText = "";
  try {
    snapshotText = await safeSnapshotText(mcpClient);
  } catch (snapshotError) {
    const message =
      snapshotError instanceof Error
        ? snapshotError.message
        : String(snapshotError);
    return {
      recovered: false,
      reason: `Could not capture snapshot for blocker recovery: ${message}`,
    };
  }

  const detection = detectBlockers(snapshotText);
  blockerEvents.push({
    phase: "detected",
    details: `${detection.reason} Candidates: ${detection.candidates.length}.`,
  });
  transcript.push(
    `Blocker detection: ${detection.reason} Candidates: ${detection.candidates.length}.`
  );

  if (!detection.blockerSuspected) {
    return {
      recovered: false,
      reason: `Recovery skipped. Original error: ${originalError}`,
    };
  }

  let attempts = 0;
  for (const candidate of detection.candidates) {
    if (attempts >= MAX_DISMISS_ATTEMPTS) {
      break;
    }

    attempts += 1;
    blockerEvents.push({
      phase: "attempt",
      details: `Attempt ${attempts}: click ${candidate.label} (ref=${candidate.ref}).`,
    });
    transcript.push(
      `Blocker recovery attempt ${attempts}: clicking dismiss candidate ${candidate.label} (ref=${candidate.ref}).`
    );

    try {
      await mcpClient.callTool("browser_click", {
        ref: candidate.ref,
        element: candidate.label,
      });
      const postSnapshot = await safeSnapshotText(mcpClient);
      const postDetection = detectBlockers(postSnapshot);
      if (!postDetection.blockerSuspected) {
        return {
          recovered: true,
          reason: `Dismissed blocker via ${candidate.label}.`,
        };
      }
    } catch (candidateError) {
      const message =
        candidateError instanceof Error
          ? candidateError.message
          : String(candidateError);
      transcript.push(
        `Dismiss click failed for ${candidate.label} (ref=${candidate.ref}): ${message}`
      );
    }
  }

  try {
    transcript.push("Blocker recovery fallback: sending Escape key.");
    await mcpClient.callTool("browser_press_key", { key: "Escape" });
    const postEscapeSnapshot = await safeSnapshotText(mcpClient);
    const postEscapeDetection = detectBlockers(postEscapeSnapshot);
    if (!postEscapeDetection.blockerSuspected) {
      return {
        recovered: true,
        reason: "Dismissed blocker via Escape key.",
      };
    }
  } catch (escapeError) {
    const message =
      escapeError instanceof Error ? escapeError.message : String(escapeError);
    transcript.push(`Escape key fallback failed: ${message}`);
  }

  console.log(`${rolePrefix} Blocker recovery exhausted without success.`);
  return {
    recovered: false,
    reason: "Blocker could not be dismissed. Continuing with alternate paths.",
  };
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
- Use this context where relevant, but prioritize observed UI behavior and tool outputs.

${truncateResult(appContext.content, 12000)}`;
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
