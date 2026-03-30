/**
 * GitHub IssueOps — fetch a GitHub issue by number, extract test parameters
 * from labels and a JSON config block, run tests, and post results back.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueOpsConfig {
  repo: string;
  token: string;
  issueNumber: number;
}

export interface IssueTestParams {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  /** Extracted from `app:<value>` label */
  appUnderTest?: string;
  /** Extracted from `version:<value>` label */
  appVersion?: string;
  /** All labels on the issue */
  labels: string[];
  /** Overrides parsed from a ```json block in the issue body */
  overrides: IssueBodyOverrides;
}

export interface IssueBodyOverrides {
  targetUrl?: string;
  environment?: string;
  appProfile?: string;
  maxIterations?: number;
  concurrency?: number;
  interleave?: boolean;
  roles?: string;
  /** Array of role objects for auto-scaffolding a new app profile */
  roleConfig?: unknown[];
  /** GitHub issue-tracker config object for auto-scaffolding */
  issueTracker?: Record<string, unknown>;
  /** Inline app context content (populated from ## App Context heading or contextUrl) */
  appContext?: string;
  /** Inline historical bugs content (populated from ## Historical Bugs heading or historicalBugsUrl) */
  historicalBugs?: string;
  /** URL to fetch app context from (fallback when no inline ## App Context section) */
  contextUrl?: string;
  /** URL to fetch historical bugs from (fallback when no inline ## Historical Bugs section) */
  historicalBugsUrl?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

async function ghRequest(
  path: string,
  token: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Fetch & parse
// ---------------------------------------------------------------------------

export async function fetchIssueTestParams(
  config: IssueOpsConfig
): Promise<IssueTestParams> {
  const { owner, name } = parseRepo(config.repo);
  const res = await ghRequest(
    `/repos/${owner}/${name}/issues/${config.issueNumber}`,
    config.token
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to fetch issue #${config.issueNumber} (${res.status}): ${body}`
    );
  }

  const issue = (await res.json()) as {
    number: number;
    title: string;
    html_url: string;
    body?: string;
    labels: Array<{ name: string } | string>;
  };

  const labels = issue.labels.map((l) =>
    typeof l === "string" ? l : l.name
  );

  const appUnderTest = extractPrefixedLabel(labels, "app:");
  const appVersion = extractPrefixedLabel(labels, "version:");
  const issueBody = issue.body ?? "";
  const overrides = parseJsonBlock(issueBody);

  // Resolve app context: inline heading wins, then contextUrl fallback
  const sections = parseContextSections(issueBody);
  if (sections.appContext) {
    overrides.appContext = sections.appContext;
  } else if (overrides.contextUrl && typeof overrides.contextUrl === "string") {
    try {
      overrides.appContext = await fetchTextUrl(overrides.contextUrl);
    } catch (err) {
      console.warn(`IssueOps: could not fetch contextUrl (${overrides.contextUrl}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Resolve historical bugs: inline heading wins, then historicalBugsUrl fallback
  if (sections.historicalBugs) {
    overrides.historicalBugs = sections.historicalBugs;
  } else if (overrides.historicalBugsUrl && typeof overrides.historicalBugsUrl === "string") {
    try {
      overrides.historicalBugs = await fetchTextUrl(overrides.historicalBugsUrl);
    } catch (err) {
      console.warn(`IssueOps: could not fetch historicalBugsUrl (${overrides.historicalBugsUrl}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Resolve roles scope: ## Roles heading wins over plain-text; JSON block wins over both
  if (!overrides.roles && sections.roles) {
    overrides.roles = sections.roles;
  }

  return {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    appUnderTest,
    appVersion,
    labels,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Post results back
// ---------------------------------------------------------------------------

export async function postIssueSummary(
  config: IssueOpsConfig,
  summary: string
): Promise<void> {
  const { owner, name } = parseRepo(config.repo);
  const res = await ghRequest(
    `/repos/${owner}/${name}/issues/${config.issueNumber}/comments`,
    config.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: summary }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to post comment on issue #${config.issueNumber} (${res.status}): ${body}`
    );
  }
}

export async function swapIssueLabel(
  config: IssueOpsConfig,
  removeLabel: string,
  addLabel: string
): Promise<void> {
  const { owner, name } = parseRepo(config.repo);

  // Remove old label (ignore 404 — label may not exist)
  const removeRes = await ghRequest(
    `/repos/${owner}/${name}/issues/${config.issueNumber}/labels/${encodeURIComponent(removeLabel)}`,
    config.token,
    { method: "DELETE" }
  );
  if (!removeRes.ok && removeRes.status !== 404) {
    const body = await removeRes.text();
    console.warn(
      `Warning: failed to remove label "${removeLabel}" (${removeRes.status}): ${body}`
    );
  }

  // Add new label
  const addRes = await ghRequest(
    `/repos/${owner}/${name}/issues/${config.issueNumber}/labels`,
    config.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [addLabel] }),
    }
  );
  if (!addRes.ok) {
    const body = await addRes.text();
    console.warn(
      `Warning: failed to add label "${addLabel}" (${addRes.status}): ${body}`
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repo format: "${repo}". Expected owner/repo.`);
  }
  return { owner, name };
}

function extractPrefixedLabel(
  labels: string[],
  prefix: string
): string | undefined {
  const match = labels.find((l) =>
    l.toLowerCase().startsWith(prefix.toLowerCase())
  );
  return match ? match.slice(prefix.length).trim() || undefined : undefined;
}

function parsePlainTextOverrides(body: string): IssueBodyOverrides {
  const overrides: IssueBodyOverrides = {};
  const lower = body.toLowerCase();

  // URL: match http:// or https:// URLs
  const urlMatch = body.match(/https?:\/\/[^\s,)>"']+/i);
  if (urlMatch) {
    overrides.targetUrl = urlMatch[0];
  }

  // Iterations: "20 iterations", "iterations: 20", "max iterations 20"
  const iterMatch = lower.match(/(?:max\s+)?iterations[\s:]*(\d+)|(\d+)\s+iterations/);
  if (iterMatch) {
    overrides.maxIterations = parseInt(iterMatch[1] ?? iterMatch[2], 10);
  }

  // Concurrency: "2 concurrent", "concurrency: 2", "2 agents"
  const concurrencyMatch = lower.match(/concurren(?:cy|t)[\s:]*(\d+)|(\d+)\s+concurrent|(\d+)\s+agents?/);
  if (concurrencyMatch) {
    overrides.concurrency = parseInt(concurrencyMatch[1] ?? concurrencyMatch[2] ?? concurrencyMatch[3], 10);
  }

  // Profile: "profile: local", "app profile local"
  const profileMatch = lower.match(/(?:app\s+)?profile[\s:]+([a-z0-9_-]+)/);
  if (profileMatch) {
    overrides.appProfile = profileMatch[1];
  }

  // Interleave: "interleave", "interleaved"
  if (/\binterleave[d]?\b/i.test(lower)) {
    overrides.interleave = true;
  }

  // Environment: "run on dev", "environment: prod", "env: test", "on staging"
  const envMatch = lower.match(/(?:run\s+on|environment|env)[\s:]+([a-z0-9_-]+)/);
  if (envMatch) {
    overrides.environment = envMatch[1];
  }

  // Roles (scope): "test only Maintenance role", "only run platform admin", "roles: maintenance, user"
  const rolesNaturalMatch = body.match(
    /(?:test\s+only|only\s+test|run\s+only|only\s+run)\s+([\w][^.,;\n]*?)(?:\s+roles?)?\s*(?:[.,;]|\s*$)/im
  );
  const rolesKvMatch = body.match(/\broles?[\s:]+([^\n{}\[\]]+)/i);
  if (rolesNaturalMatch) {
    overrides.roles = rolesNaturalMatch[1].trim().toLowerCase();
  } else if (rolesKvMatch) {
    overrides.roles = rolesKvMatch[1].trim().toLowerCase();
  }

  return overrides;
}

function parseContextSections(body: string): { appContext?: string; historicalBugs?: string; roles?: string } {
  const result: { appContext?: string; historicalBugs?: string; roles?: string } = {};

  // Match a heading (## or #) followed by its content up to the next heading or end of string
  const sectionRegex = /^#{1,2}\s+(.+)$/gm;
  const headings: Array<{ name: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(body)) !== null) {
    headings.push({ name: match[1].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const { name, start } = headings[i];
    const end = i + 1 < headings.length ? headings[i + 1].start - headings[i + 1].name.length - 5 : body.length;
    const content = body.slice(start, end).trim();

    if (/^app\s+context$/i.test(name)) {
      result.appContext = content || undefined;
    } else if (/^historical\s+bugs?$/i.test(name)) {
      result.historicalBugs = content || undefined;
    } else if (/^roles?$/i.test(name)) {
      // Strip markdown list markers and join as comma-separated names
      const names = content
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean)
        .join(", ");
      result.roles = names.toLowerCase() || undefined;
    }
  }

  return result;
}

async function fetchTextUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching context URL: ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonBlock(body: string): IssueBodyOverrides {
  // Try fenced ```json block first
  const fencedMatch = body.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  let jsonString = fencedMatch?.[1];

  // Fallback: find first bare JSON object in the body
  if (!jsonString) {
    const bareMatch = body.match(/\{[\s\S]*\}/);
    if (bareMatch) {
      jsonString = bareMatch[0];
    }
  }

  if (jsonString) {
    try {
      const parsed = JSON.parse(jsonString.trim());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as IssueBodyOverrides;
      }
    } catch {
      // JSON parse failed — fall through to plain-text extraction
    }
  }

  // Plain-text pattern matching fallback
  return parsePlainTextOverrides(body);
}

// ---------------------------------------------------------------------------
// CLI argument helper
// ---------------------------------------------------------------------------

export function parseIssueArg(argv: string[]): number | undefined {
  for (const arg of argv.slice(2)) {
    const eqMatch = arg.match(/^--issue=(\d+)$/);
    if (eqMatch) return parseInt(eqMatch[1], 10);

    if (arg === "--issue") {
      const next = argv[argv.indexOf(arg) + 1];
      if (next && /^\d+$/.test(next)) return parseInt(next, 10);
    }
  }
  return undefined;
}
