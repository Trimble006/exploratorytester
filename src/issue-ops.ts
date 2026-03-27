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
  appProfile?: string;
  maxIterations?: number;
  concurrency?: number;
  roles?: string;
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
  const overrides = parseJsonBlock(issue.body ?? "");

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

  if (!jsonString) {
    return {};
  }

  try {
    const parsed = JSON.parse(jsonString.trim());
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as IssueBodyOverrides;
    }
  } catch {
    console.warn("Warning: could not parse JSON config block from issue body.");
  }
  return {};
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
