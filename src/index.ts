import * as dotenv from "dotenv";
import { access, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpClient } from "./mcp-client.js";
import { runAgent, AgentSession, type AppContext, type TestCredentials } from "./agent.js";
import {
  parseIssueArg,
  fetchIssueTestParams,
  postIssueSummary,
  swapIssueLabel,
  type IssueOpsConfig,
  type IssueTestParams,
} from "./issue-ops.js";

import logUpdate from "log-update";
import chalk from "chalk";

function renderDashboard(sessions: { roleName: string; session: AgentSession }[], maxIterations: number): string {
  const lines: string[] = [];
  lines.push(chalk.bold.blue("Exploratory Tester - execution status"));
  lines.push(chalk.dim("—".repeat(60)));
  for (const { roleName, session } of sessions) {
    const perc = Math.min(100, Math.round((session.iterationsExecuted / maxIterations) * 100));
    const statusColor = session.completed ? chalk.green : chalk.yellow;
    const statusText = session.completed ? "Done" : "Active";
    const stateColor = session.completed ? chalk.dim : chalk.white;
    lines.push(
      `${chalk.bold(roleName.padEnd(20))} [${perc.toString().padStart(3)}%] ${statusColor(statusText.padEnd(8))} | Iteration: ${session.iterationsExecuted}/${maxIterations}`
    );
    lines.push(`  ${stateColor("> " + (session.lastAction || "Idle").substring(0, 70))}`);
  }
  lines.push(chalk.dim("—".repeat(60)));
  return lines.join("\n");
}

dotenv.config();

function normalizeTargetUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeHostForFilename(urlString: string): string {
  try {
    const hostname = new URL(urlString).hostname;
    return hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "unknown-host";
  }
}

function relativeDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

interface RoleConfig {
  name: string;
  testCredentials?: TestCredentials;
  contextFile?: string;
  historicalBugReportsFile?: string;
}

interface RoleExecutionOutcome {
  role: RoleConfig;
  status: "success" | "failed";
  resultPath: string;
  result?: Awaited<ReturnType<typeof runAgent>>;
  error?: string;
}

interface IssueFinding {
  roleName: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  summary: string;
}

interface GithubIssueTrackerConfig {
  provider: "github";
  enabled: boolean;
  repo: string;
  tokenEnv: string;
  labels?: string[];
  titlePrefix?: string;
  dedupeByTitle?: boolean;
  dryRun?: boolean;
}

interface LoggedIssue {
  roleName: string;
  severity: string;
  summary: string;
  title: string;
  issueNumber?: number;
  issueUrl?: string;
  action: "created" | "existing" | "dry-run";
}

interface AppProfileDefaults {
  enabled: boolean;
  appUnderTest?: string;
  appProfile?: string;
  appVersion?: string;
  appRootDir?: string;
  rolesConfigFile?: string;
  issueTrackerConfigFile?: string;
  appContextFile?: string;
  historicalBugReportsFile?: string;
  resultsDir?: string;
  recentIssuesContext?: string;
}

function normalizeAppKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function tryResolveExistingFile(filePath: string): Promise<string | undefined> {
  const resolvedFile = resolve(filePath);
  try {
    await access(resolvedFile);
    return resolvedFile;
  } catch {
    return undefined;
  }
}

async function getMostRecentIssues(resultsDir: string, host: string): Promise<string | undefined> {
  const hostDir = join(resultsDir, host);
  try {
    const entries = await readdir(hostDir, { withFileTypes: true });
    // Sort directories backward (most recent first)
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
    
    for (const dir of dirs) {
      const combinedDir = join(hostDir, dir, "combined");
      try {
        const files = await readdir(combinedDir);
        // Find combined-summary-<host>-<timestamp>.md
        const summaryFile = files.find(f => f.startsWith(`combined-summary-${host}-`) && f.endsWith(".md"));
        if (summaryFile) {
          const content = await readFile(join(combinedDir, summaryFile), "utf-8");
          const startMatch = content.match(/\*\*Issues found:\*\*/);
          if (startMatch && startMatch.index !== undefined) {
             const startIndex = startMatch.index + startMatch[0].length;
             const remaining = content.slice(startIndex);
             const endMatch = remaining.match(/##|\*\*Positive observations:\*\*/);
             const endIndex = endMatch && endMatch.index !== undefined ? endMatch.index : remaining.length;
             const issuesSection = remaining.slice(0, endIndex).trim();
             if (issuesSection) {
               return issuesSection;
             }
          }
        }
      } catch (err) {
        // Ignore errors for individual dirs, maybe 'combined' doesn't exist
      }
    }
  } catch (err) {
    // Host dir might not exist yet
  }
  return undefined;
}

async function resolveAppProfileDefaults(): Promise<AppProfileDefaults> {
  const appUnderTestRaw = envValue("APP_UNDER_TEST");
  if (!appUnderTestRaw) {
    return { enabled: false };
  }

  const appUnderTest = normalizeAppKey(appUnderTestRaw);
  if (!appUnderTest) {
    throw new Error("APP_UNDER_TEST is set but invalid after normalization.");
  }

  const appProfile = normalizeAppKey(envValue("APP_PROFILE") ?? "default");
  if (!appProfile) {
    throw new Error("APP_PROFILE resolved to an empty value.");
  }

  const appVersion = envValue("APP_VERSION");

  const appRootDir = join("apps", appUnderTest, appProfile);

  const [
    rolesConfigFile,
    issueTrackerConfigFile,
    appContextFile,
    historicalBugReportsFile,
  ] = await Promise.all([
    tryResolveExistingFile(join(appRootDir, "roles.json")),
    tryResolveExistingFile(join(appRootDir, "issue-tracker.github.json")),
    tryResolveExistingFile(join(appRootDir, "app-context.md")),
    tryResolveExistingFile(join(appRootDir, "historical-bugs.md")),
  ]);

  return {
    enabled: true,
    appUnderTest,
    appProfile,
    appVersion,
    appRootDir,
    rolesConfigFile,
    issueTrackerConfigFile,
    appContextFile,
    historicalBugReportsFile,
    resultsDir: join(appRootDir, "outputs"),
  };
}

function roleKey(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function roleEnvToken(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function parseCredentialFields(
  email: string | undefined,
  username: string | undefined,
  password: string | undefined,
  sourceLabel: string
): TestCredentials | undefined {
  const hasIdentifier = Boolean(email || username);
  const hasPassword = Boolean(password);

  if (hasPassword && !hasIdentifier) {
    throw new Error(
      `Invalid credential configuration (${sourceLabel}): password is set but identifier is missing.`
    );
  }

  if (hasIdentifier && !hasPassword) {
    throw new Error(
      `Invalid credential configuration (${sourceLabel}): identifier is set but password is missing.`
    );
  }

  if (!hasIdentifier && !hasPassword) {
    return undefined;
  }

  if (email && username) {
    console.log(
      `${sourceLabel}: both email and username are set. Using email and ignoring username.`
    );
  }

  if (email) {
    return {
      identifierType: "email",
      identifier: email,
      password: password!,
    };
  }

  return {
    identifierType: "username",
    identifier: username!,
    password: password!,
  };
}

function parseLegacyTestCredentials(): TestCredentials | undefined {
  return parseCredentialFields(
    envValue("TEST_USER_EMAIL"),
    envValue("TEST_USERNAME"),
    envValue("TEST_USER_PASSWORD"),
    "legacy TEST_USER_* vars"
  );
}

function parseRolesFromEnv(): RoleConfig[] {
  const rolesRaw = envValue("ROLES");
  if (!rolesRaw) {
    return [];
  }

  const names = rolesRaw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (!names.length) {
    throw new Error("ROLES is set but contains no valid role names.");
  }

  const seen = new Set<string>();
  const parsed: RoleConfig[] = [];

  for (const name of names) {
    const key = roleEnvToken(name);
    const dedupeKey = name.toLowerCase();

    if (seen.has(dedupeKey)) {
      throw new Error(`Duplicate role name in ROLES: ${name}`);
    }
    seen.add(dedupeKey);

    const email = envValue(`ROLE_${key}_EMAIL`);
    const username = envValue(`ROLE_${key}_USERNAME`);
    const password = envValue(`ROLE_${key}_PASSWORD`);
    const contextFile = envValue(`ROLE_${key}_CONTEXT_FILE`);
    const historicalBugReportsFile = envValue(
      `ROLE_${key}_HISTORICAL_BUG_REPORTS_FILE`
    );

    const credentials = parseCredentialFields(
      email,
      username,
      password,
      `role ${name}`
    );

    if (!credentials) {
      throw new Error(
        `Role ${name} is missing credentials. Set ROLE_${key}_EMAIL or ROLE_${key}_USERNAME and ROLE_${key}_PASSWORD.`
      );
    }

    parsed.push({
      name,
      testCredentials: credentials,
      contextFile,
      historicalBugReportsFile,
    });
  }

  return parsed;
}

async function parseRolesFromJson(filePath: string): Promise<RoleConfig[]> {
  const resolvedFile = resolve(filePath);

  try {
    await access(resolvedFile);
  } catch {
    throw new Error(`ROLES_CONFIG_FILE not found: ${resolvedFile}`);
  }

  const fileContent = await readFile(resolvedFile, "utf-8");

  let raw: unknown;
  try {
    raw = JSON.parse(fileContent);
  } catch {
    throw new Error(`ROLES_CONFIG_FILE is not valid JSON: ${resolvedFile}`);
  }

  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw && Array.isArray((raw as { roles?: unknown[] }).roles)
      ? (raw as { roles: unknown[] }).roles
      : [];

  if (!list.length) {
    throw new Error(
      `ROLES_CONFIG_FILE does not contain any roles: ${resolvedFile}`
    );
  }

  const seen = new Set<string>();
  const parsed: RoleConfig[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") {
      throw new Error("Each role in ROLES_CONFIG_FILE must be an object.");
    }

    const roleObj = item as {
      name?: string;
      identifierType?: string;
      identifier?: string;
      email?: string;
      username?: string;
      password?: string;
      contextFile?: string;
      historicalBugReportsFile?: string;
    };

    const name = roleObj.name?.trim();
    if (!name) {
      throw new Error("Each role in ROLES_CONFIG_FILE must include a name.");
    }

    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) {
      throw new Error(`Duplicate role name in ROLES_CONFIG_FILE: ${name}`);
    }
    seen.add(dedupeKey);

    let email: string | undefined;
    let username: string | undefined;

    if (roleObj.identifierType && roleObj.identifier) {
      if (roleObj.identifierType === "email") {
        email = roleObj.identifier;
      } else if (roleObj.identifierType === "username") {
        username = roleObj.identifier;
      } else {
        throw new Error(
          `Role ${name} has invalid identifierType. Use email or username.`
        );
      }
    } else {
      email = roleObj.email;
      username = roleObj.username;
    }

    const credentials = parseCredentialFields(
      email?.trim(),
      username?.trim(),
      roleObj.password?.trim(),
      `role ${name}`
    );

    if (!credentials) {
      throw new Error(
        `Role ${name} is missing credentials in ROLES_CONFIG_FILE.`
      );
    }

    parsed.push({
      name,
      testCredentials: credentials,
      contextFile: roleObj.contextFile?.trim() || undefined,
      historicalBugReportsFile:
        roleObj.historicalBugReportsFile?.trim() || undefined,
    });
  }

  return parsed;
}

function applyRoleScopedDefaults(
  roles: RoleConfig[],
  appProfileDefaults: AppProfileDefaults
): RoleConfig[] {
  if (!appProfileDefaults.enabled) {
    return roles;
  }

  return roles.map((role) => ({
    ...role,
    contextFile: role.contextFile ?? appProfileDefaults.appContextFile,
    historicalBugReportsFile:
      role.historicalBugReportsFile ??
      appProfileDefaults.historicalBugReportsFile,
  }));
}

async function resolveRoles(
  appProfileDefaults: AppProfileDefaults
): Promise<RoleConfig[]> {
  const configPath = envValue("ROLES_CONFIG_FILE");
  if (configPath) {
    return parseRolesFromJson(configPath);
  }

  if (appProfileDefaults.rolesConfigFile) {
    return parseRolesFromJson(appProfileDefaults.rolesConfigFile);
  }

  const envRoles = parseRolesFromEnv();
  if (envRoles.length) {
    return applyRoleScopedDefaults(envRoles, appProfileDefaults);
  }

  const fallbackRoles: RoleConfig[] = [
    {
      name: "default",
      testCredentials: parseLegacyTestCredentials(),
      contextFile: envValue("APP_CONTEXT_FILE") ?? appProfileDefaults.appContextFile,
      historicalBugReportsFile:
        envValue("HISTORICAL_BUG_REPORTS_FILE") ??
        appProfileDefaults.historicalBugReportsFile,
    },
  ];

  return applyRoleScopedDefaults(fallbackRoles, appProfileDefaults);
}

async function readContextFile(contextFile: string): Promise<AppContext> {
  const resolvedFile = resolve(contextFile);

  try {
    await access(resolvedFile);
  } catch {
    throw new Error(
      `Invalid app context configuration: context file not found: ${resolvedFile}`
    );
  }

  let content: string;
  try {
    content = await readFile(resolvedFile, "utf-8");
  } catch {
    throw new Error(
      `Invalid app context configuration: unable to read context file: ${resolvedFile}`
    );
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(
      `Invalid app context configuration: context file is empty: ${resolvedFile}`
    );
  }

  const maxChars = 12000;
  if (trimmed.length > maxChars) {
    console.warn(
      `Context file content is longer than ${maxChars} characters. It will be truncated.`
    );
  }

  return {
    mode: "file",
    sourceFile: resolvedFile,
    content: trimmed.slice(0, maxChars),
  };
}

async function resolveAppContext(contextFile?: string): Promise<AppContext> {
  if (!contextFile) {
    return { mode: "auto-research" };
  }
  return readContextFile(contextFile);
}

async function readHistoricalBugReportsFile(
  historicalBugReportsFile: string
): Promise<{ sourceFile: string; content: string }> {
  const resolvedFile = resolve(historicalBugReportsFile);

  try {
    await access(resolvedFile);
  } catch {
    throw new Error(
      `Invalid historical bug reports configuration: file not found: ${resolvedFile}`
    );
  }

  let content: string;
  try {
    content = await readFile(resolvedFile, "utf-8");
  } catch {
    throw new Error(
      `Invalid historical bug reports configuration: unable to read file: ${resolvedFile}`
    );
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(
      `Invalid historical bug reports configuration: file is empty: ${resolvedFile}`
    );
  }

  const maxChars = 10000;
  return {
    sourceFile: resolvedFile,
    content: trimmed.slice(0, maxChars),
  };
}

async function resolveRoleAppContext(
  contextFile?: string,
  historicalBugReportsFile?: string,
  appVersion?: string,
  recentIssuesContext?: string
): Promise<AppContext> {
  const appContext = await resolveAppContext(contextFile);
  appContext.appVersion = appVersion;

  let bugReportsContent = "";
  let bugReportsSourceFile: string | undefined = undefined;

  if (historicalBugReportsFile) {
    const bugReports = await readHistoricalBugReportsFile(
      historicalBugReportsFile
    );
    bugReportsContent = bugReports.content;
    bugReportsSourceFile = bugReports.sourceFile;
  }

  if (recentIssuesContext) {
    bugReportsContent += `\n\n### Autodiscovered Recent Issues\n${recentIssuesContext}`;
    bugReportsContent = bugReportsContent.trim();
  }

  return {
    ...appContext,
    ...(bugReportsSourceFile ? { historicalBugReportSourceFile: bugReportsSourceFile } : {}),
    ...(bugReportsContent ? { historicalBugReportContext: bugReportsContent } : {}),
  };
}

async function resolveIssueTrackerConfig(
  appProfileDefaults: AppProfileDefaults
): Promise<GithubIssueTrackerConfig | undefined> {
  const configPath =
    envValue("ISSUE_TRACKER_CONFIG_FILE") ??
    appProfileDefaults.issueTrackerConfigFile;
  if (!configPath) {
    return undefined;
  }

  const resolvedFile = resolve(configPath);
  try {
    await access(resolvedFile);
  } catch {
    throw new Error(`ISSUE_TRACKER_CONFIG_FILE not found: ${resolvedFile}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolvedFile, "utf-8"));
  } catch {
    throw new Error(
      `ISSUE_TRACKER_CONFIG_FILE is not valid JSON: ${resolvedFile}`
    );
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Issue tracker config must be a JSON object.");
  }

  const config = raw as {
    provider?: string;
    enabled?: boolean;
    repo?: string;
    tokenEnv?: string;
    labels?: unknown;
    titlePrefix?: string;
    dedupeByTitle?: boolean;
    dryRun?: boolean;
  };

  if (config.provider !== "github") {
    throw new Error(
      "Only provider=github is currently supported in ISSUE_TRACKER_CONFIG_FILE."
    );
  }

  if (!config.repo || !config.repo.includes("/")) {
    throw new Error("Issue tracker github repo must be in owner/repo format.");
  }

  if (!config.tokenEnv) {
    throw new Error("Issue tracker config must include tokenEnv.");
  }

  const labels = Array.isArray(config.labels)
    ? config.labels.filter((item): item is string => typeof item === "string")
    : undefined;

  return {
    provider: "github",
    enabled: config.enabled ?? true,
    repo: config.repo,
    tokenEnv: config.tokenEnv,
    labels,
    titlePrefix: config.titlePrefix?.trim() || undefined,
    dedupeByTitle: config.dedupeByTitle ?? true,
    dryRun: config.dryRun ?? false,
  };
}

function extractIssueFindings(
  roleName: string,
  finalReport: string
): IssueFinding[] {
  const findings: IssueFinding[] = [];
  const lines = finalReport.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(
      /^\s*-\s*\*\*(Critical|High|Medium|Low)\*\*:\s*(.+)\s*$/i
    );
    if (!match) {
      continue;
    }
    const severity =
      (match[1].charAt(0).toUpperCase() +
        match[1].slice(1).toLowerCase()) as IssueFinding["severity"];
    const summary = match[2].trim();
    if (!summary) {
      continue;
    }
    findings.push({
      roleName,
      severity,
      summary,
    });
  }
  return findings;
}

function severityLabel(severity: string): string {
  return `severity:${severity.toLowerCase()}`;
}

function buildIssueTitle(
  finding: IssueFinding,
  titlePrefix?: string
): string {
  const base = `[${finding.severity}] ${finding.summary}`;
  return titlePrefix ? `${titlePrefix} ${base}` : base;
}

function buildIssueBody(
  finding: IssueFinding,
  targetUrl: string,
  reportPath: string
): string {
  return [
    "## Auto-filed Exploratory Testing Finding",
    "",
    `- Role: ${finding.roleName}`,
    `- Severity: ${finding.severity}`,
    `- Target URL: ${targetUrl}`,
    `- Report Path: ${reportPath}`,
    "",
    "### Finding",
    finding.summary,
  ].join("\n");
}

async function githubRequest(
  path: string,
  token: string,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  return response;
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repo format: ${repo}`);
  }
  return { owner, name };
}

async function findExistingGithubIssueByTitle(
  repo: string,
  title: string,
  token: string
): Promise<{ number: number; html_url: string } | undefined> {
  const query = encodeURIComponent(`repo:${repo} is:issue state:open in:title \"${title}\"`);
  const response = await githubRequest(`/search/issues?q=${query}&per_page=1`, token, {
    method: "GET",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub search failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    items?: Array<{ number: number; html_url: string }>;
  };
  return data.items?.[0];
}

async function createGithubIssue(params: {
  repo: string;
  token: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<{ number: number; html_url: string }> {
  const { owner, name } = parseRepo(params.repo);
  const response = await githubRequest(`/repos/${owner}/${name}/issues`, params.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      labels: params.labels,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub issue create failed (${response.status}): ${body}`);
  }

  const created = (await response.json()) as {
    number: number;
    html_url: string;
  };
  return created;
}

async function logIssuesToGithub(params: {
  config: GithubIssueTrackerConfig;
  findings: Array<IssueFinding & { reportPath: string }>;
  targetUrl: string;
}): Promise<LoggedIssue[]> {
  const { config, findings, targetUrl } = params;
  if (!config.enabled || findings.length === 0) {
    return [];
  }

  if (config.dryRun) {
    return findings.map((finding) => ({
      roleName: finding.roleName,
      severity: finding.severity,
      summary: finding.summary,
      title: buildIssueTitle(finding, config.titlePrefix),
      action: "dry-run",
    }));
  }

  const token = envValue(config.tokenEnv);
  if (!token) {
    throw new Error(
      `GitHub issue logging is enabled but token env var ${config.tokenEnv} is missing.`
    );
  }

  const created: LoggedIssue[] = [];
  for (const finding of findings) {
    const title = buildIssueTitle(finding, config.titlePrefix);
    const labels = [
      ...(config.labels ?? []),
      "exploratory-testing",
      severityLabel(finding.severity),
      `role:${finding.roleName.toLowerCase()}`,
    ];

    if (config.dedupeByTitle) {
      const existing = await findExistingGithubIssueByTitle(config.repo, title, token);
      if (existing) {
        created.push({
          roleName: finding.roleName,
          severity: finding.severity,
          summary: finding.summary,
          title,
          issueNumber: existing.number,
          issueUrl: existing.html_url,
          action: "existing",
        });
        continue;
      }
    }

    const issue = await createGithubIssue({
      repo: config.repo,
      token,
      title,
      body: buildIssueBody(finding, targetUrl, finding.reportPath),
      labels,
    });

    created.push({
      roleName: finding.roleName,
      severity: finding.severity,
      summary: finding.summary,
      title,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      action: "created",
    });
  }

  return created;
}

function resolveConcurrencyLimit(totalRoles: number): number {
  const parsed = parseInt(envValue("MAX_CONCURRENT_AGENTS") ?? "2", 10);
  const safe = Number.isNaN(parsed) ? 2 : parsed;
  return Math.max(1, Math.min(safe, Math.max(1, totalRoles)));
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function workerLoop(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => workerLoop())
  );

  return results;
}

function toMarkdownReport(result: {
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
}, appProfileDefaults?: AppProfileDefaults): string {
  const lines: string[] = [];
  lines.push("# Exploratory Test Report");
  lines.push("");
  lines.push("## Run Metadata");
  lines.push("");
  lines.push(`- Role: ${result.roleName}`);
  lines.push(`- Target URL: ${result.targetUrl}`);
  if (appProfileDefaults?.enabled) {
    lines.push(`- App Under Test: ${appProfileDefaults.appUnderTest}`);
    lines.push(`- App Profile: ${appProfileDefaults.appProfile}`);
  }
  lines.push(`- Model: ${result.model}`);
  lines.push(`- Iterations Executed: ${result.iterationsExecuted}/${result.maxIterations}`);
  lines.push(`- Completed Flag: ${result.completed ? "TESTING COMPLETE" : "Loop Ended"}`);
  lines.push(`- Completed At (UTC): ${result.completedAt}`);
  lines.push(`- App Context Mode: ${result.contextMode}`);
  if (result.contextSource) {
    lines.push(`- App Context Source: ${result.contextSource}`);
  }
  lines.push("");
  lines.push("## Final Report");
  lines.push("");
  lines.push(result.finalReport || "No final report produced.");
  lines.push("");
  lines.push("## Full Transcript");
  lines.push("");
  for (const entry of result.transcript) {
    lines.push(`- ${entry}`);
  }
  lines.push("");

  return lines.join("\n");
}

function toFailedRoleReport(
  roleName: string,
  targetUrl: string,
  errorMessage: string
): string {
  const lines: string[] = [];
  lines.push("# Exploratory Test Report");
  lines.push("");
  lines.push("## Run Metadata");
  lines.push("");
  lines.push(`- Role: ${roleName}`);
  lines.push(`- Target URL: ${targetUrl}`);
  lines.push(`- Completed Flag: Failed Before Completion`);
  lines.push(`- Completed At (UTC): ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Failure");
  lines.push("");
  lines.push(errorMessage);
  lines.push("");
  return lines.join("\n");
}

function toCombinedSummaryMarkdown(params: {
  targetUrl: string;
  model: string;
  maxIterations: number;
  concurrencyLimit: number;
  resultsScope: string;
  appProfileDefaults?: AppProfileDefaults;
  outcomes: RoleExecutionOutcome[];
  loggedIssues?: LoggedIssue[];
  issueLoggingError?: string;
  issueLoggingMode?: "disabled" | "github" | "github-dry-run";
}): string {
  const {
    targetUrl,
    model,
    maxIterations,
    concurrencyLimit,
    resultsScope,
    appProfileDefaults,
    outcomes,
    loggedIssues,
    issueLoggingError,
    issueLoggingMode,
  } = params;
  const successful = outcomes.filter((o) => o.status === "success");
  const failed = outcomes.filter((o) => o.status === "failed");

  const lines: string[] = [];
  lines.push("# Multi-Role Exploratory Test Summary");
  lines.push("");
  lines.push("## Run Metadata");
  lines.push("");
  lines.push(`- Target URL: ${targetUrl}`);
  if (appProfileDefaults?.enabled) {
    lines.push(`- App Under Test: ${appProfileDefaults.appUnderTest}`);
    lines.push(`- App Profile: ${appProfileDefaults.appProfile}`);
  }
  lines.push(`- Results Scope: ${relativeDisplayPath(resultsScope)}`);
  lines.push(`- Model: ${model}`);
  lines.push(`- Max Iterations Per Role: ${maxIterations}`);
  lines.push(`- Concurrency Limit: ${concurrencyLimit}`);
  lines.push(`- Roles Attempted: ${outcomes.length}`);
  lines.push(`- Roles Succeeded: ${successful.length}`);
  lines.push(`- Roles Failed: ${failed.length}`);
  lines.push(`- Completed At (UTC): ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Role Status");
  lines.push("");
  for (const outcome of outcomes) {
    const status = outcome.status === "success" ? "Success" : "Failed";
    lines.push(`- ${outcome.role.name}: ${status}`);
    if (outcome.status === "success" && outcome.result) {
      lines.push(
        `  - Iterations: ${outcome.result.iterationsExecuted}/${outcome.result.maxIterations}`
      );
      lines.push(
        `  - Context Mode: ${outcome.result.contextMode}${outcome.result.contextSource ? ` (${outcome.result.contextSource})` : ""}`
      );
    }
    if (outcome.status === "failed") {
      lines.push(`  - Error: ${outcome.error}`);
    }
    lines.push(`  - Report: ${outcome.resultPath}`);
  }
  lines.push("");

  lines.push("## Final Report Excerpts");
  lines.push("");
  for (const outcome of successful) {
    const text = outcome.result?.finalReport ?? "No final report produced.";
    lines.push(`### ${outcome.role.name}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  lines.push("## External Issue Logging");
  lines.push("");
  if (issueLoggingError) {
    lines.push(`- Status: Failed`);
    lines.push(`- Error: ${issueLoggingError}`);
  } else if (loggedIssues && loggedIssues.length > 0) {
    const createdCount = loggedIssues.filter((item) => item.action === "created").length;
    const existingCount = loggedIssues.filter((item) => item.action === "existing").length;
    const dryRunCount = loggedIssues.filter((item) => item.action === "dry-run").length;
    if (issueLoggingMode === "github-dry-run") {
      lines.push(`- Status: Enabled (GitHub dry-run)`);
      lines.push(`- Planned Issues: ${dryRunCount}`);
    } else {
      lines.push(`- Status: Enabled (GitHub)`);
      lines.push(`- Created Issues: ${createdCount}`);
      lines.push(`- Matched Existing Issues: ${existingCount}`);
    }
    lines.push("");
    lines.push("### Filed/Matched Issues");
    lines.push("");
    for (const issue of loggedIssues) {
      if (issue.action === "dry-run") {
        lines.push(
          `- [DRY-RUN] (${issue.severity}) ${issue.summary} -> title: ${issue.title}`
        );
        continue;
      }
      lines.push(
        `- [${issue.action.toUpperCase()}] #${issue.issueNumber} (${issue.severity}) ${issue.summary} -> ${issue.issueUrl}`
      );
    }
  } else {
    if (issueLoggingMode === "github-dry-run") {
      lines.push(`- Status: Enabled (GitHub dry-run) but no issues detected`);
    } else {
      lines.push(`- Status: Disabled or no issues detected`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  // ── IssueOps: check for --issue=### CLI argument ──
  const issueNumber = parseIssueArg(process.argv);
  let issueOpsConfig: IssueOpsConfig | undefined;
  let issueParams: IssueTestParams | undefined;

  if (issueNumber !== undefined) {
    const ghRepo = envValue("GITHUB_REPO");
    const ghToken = envValue("GITHUB_TOKEN");
    if (!ghRepo) {
      console.error("--issue requires GITHUB_REPO to be set (owner/repo format).");
      process.exit(1);
    }
    if (!ghToken) {
      console.error("--issue requires GITHUB_TOKEN to be set.");
      process.exit(1);
    }

    issueOpsConfig = { repo: ghRepo, token: ghToken, issueNumber };
    console.log(`IssueOps: fetching issue #${issueNumber} from ${ghRepo}...`);
    issueParams = await fetchIssueTestParams(issueOpsConfig);
    console.log(`IssueOps: issue "${issueParams.issueTitle}" (${issueParams.issueUrl})`);

    // Apply label-derived overrides to process.env so downstream resolution picks them up
    if (issueParams.appUnderTest) {
      process.env.APP_UNDER_TEST = issueParams.appUnderTest;
      console.log(`IssueOps: APP_UNDER_TEST overridden to "${issueParams.appUnderTest}" (from label)`);
    }
    if (issueParams.appVersion) {
      process.env.APP_VERSION = issueParams.appVersion;
      console.log(`IssueOps: APP_VERSION overridden to "${issueParams.appVersion}" (from label)`);
    }
    // Apply JSON body overrides
    if (issueParams.overrides.appProfile) {
      process.env.APP_PROFILE = issueParams.overrides.appProfile;
      console.log(`IssueOps: APP_PROFILE overridden to "${issueParams.overrides.appProfile}"`);
    }
    if (issueParams.overrides.maxIterations !== undefined) {
      process.env.MAX_ITERATIONS = String(issueParams.overrides.maxIterations);
      console.log(`IssueOps: MAX_ITERATIONS overridden to ${issueParams.overrides.maxIterations}`);
    }
    if (issueParams.overrides.roles) {
      process.env.ROLES = issueParams.overrides.roles;
      console.log(`IssueOps: ROLES overridden to "${issueParams.overrides.roles}"`);
    }
    if (issueParams.overrides.concurrency !== undefined) {
      process.env.MAX_CONCURRENT_AGENTS = String(issueParams.overrides.concurrency);
      console.log(`IssueOps: MAX_CONCURRENT_AGENTS overridden to ${issueParams.overrides.concurrency}`);
    }
  }

  // ── Resolve target URL ──
  // Priority: issue body override > positional CLI arg (skip --issue and its value)
  let targetArg: string | undefined = issueParams?.overrides.targetUrl;
  if (!targetArg) {
    const positionalArgs = process.argv.slice(2).filter((a) => {
      if (a.startsWith("--")) return false;
      if (/^\d+$/.test(a)) return false; // skip bare issue number
      return true;
    });
    targetArg = positionalArgs[0];
  }
  if (!targetArg) {
    console.error("Usage: npm start -- <url>");
    console.error("   or: npm start -- --issue=123  (with targetUrl in issue JSON block)");
    console.error("   or: npm start -- --issue=123 <url>");
    console.error("Example: npm start -- https://example.com");
    process.exit(1);
  }

  const targetUrl = normalizeTargetUrl(targetArg);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing GEMINI_API_KEY. Set it in a .env file or as an environment variable."
    );
    process.exit(1);
  }

  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const maxIterations = parseInt(process.env.MAX_ITERATIONS ?? "50", 10);
  const appProfileDefaults = await resolveAppProfileDefaults();

  const resultsBaseDir = process.env.RESULTS_DIR?.trim() || appProfileDefaults.resultsDir || "results";
  const recentIssues = await getMostRecentIssues(resultsBaseDir, safeHostForFilename(targetUrl));
  if (recentIssues) {
    appProfileDefaults.recentIssuesContext = recentIssues;
  }

  const roles = await resolveRoles(appProfileDefaults);
  const issueTrackerConfig = await resolveIssueTrackerConfig(appProfileDefaults);
  const issueLoggingMode: "disabled" | "github" | "github-dry-run" =
    issueTrackerConfig?.enabled
      ? issueTrackerConfig.dryRun
        ? "github-dry-run"
        : "github"
      : "disabled";
  const concurrencyLimit = resolveConcurrencyLimit(roles.length);

  console.log(`Resolved ${roles.length} role(s).`);
  console.log(`Using concurrency limit: ${concurrencyLimit}`);

  const activeClients = new Set<McpClient>();

  // Graceful shutdown
  const cleanup = async () => {
    console.log("\nShutting down...");
    await Promise.all(
      Array.from(activeClients).map(async (client) => {
        try {
          await client.close();
        } catch {
          // ignore cleanup errors
        }
      })
    );
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await mkdir(resultsBaseDir, { recursive: true });

    const reportTimestamp = timestampForFilename(new Date());
    const hostPart = safeHostForFilename(targetUrl);
    const runScopeDir = join(resultsBaseDir, hostPart, reportTimestamp);
    const roleResultsDir = join(runScopeDir, "role-reports");
    const combinedResultsDir = join(runScopeDir, "combined");
    const artifactsBaseDir = join(runScopeDir, "artifacts", "playwright-mcp");

    await mkdir(runScopeDir, { recursive: true });
    await mkdir(roleResultsDir, { recursive: true });
    await mkdir(combinedResultsDir, { recursive: true });
    await mkdir(artifactsBaseDir, { recursive: true });

    const interleaveRoles = process.env.INTERLEAVE_ROLES === "true";
    let settled: PromiseSettledResult<Awaited<ReturnType<typeof runAgent>>>[];

    if (interleaveRoles) {
      console.log(`Interleaved execution enabled. Booting ${roles.length} clients...`);
      const sessions: { roleName: string; session: AgentSession; client: McpClient }[] = [];
      const interleavedResults: PromiseSettledResult<Awaited<ReturnType<typeof runAgent>>>[] = new Array(roles.length);

      // Startup phase
      for (let roleIndex = 0; roleIndex < roles.length; roleIndex++) {
        const role = roles[roleIndex];
        const roleArtifactDir = join(
          artifactsBaseDir,
          `${String(roleIndex + 1).padStart(2, "0")}-${roleKey(role.name)}`
        );
        await mkdir(roleArtifactDir, { recursive: true });

        const mcpClient = new McpClient({ workingDir: roleArtifactDir });
        activeClients.add(mcpClient);

        try {
          await mcpClient.connect();
          const appContext = await resolveRoleAppContext(
            role.contextFile,
            role.historicalBugReportsFile,
            appProfileDefaults.appVersion,
            appProfileDefaults.recentIssuesContext
          );
          
          const session = new AgentSession({
            apiKey,
            model,
            mcpClient,
            roleName: role.name,
            targetUrl,
            maxIterations,
            testCredentials: role.testCredentials,
            appContext,
          });

          await session.setup();
          sessions.push({ roleName: role.name, session, client: mcpClient });
        } catch (err) {
          interleavedResults[roleIndex] = { status: "rejected", reason: err };
        }
      }

            // Interleaved Turn Phase
      for (let iter = 1; iter <= maxIterations; iter++) {
        let anyActive = false;
        if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));

        for (const { session } of sessions) {
          if (!session.completed && session.iterationsExecuted < maxIterations) {
            anyActive = true;
            try {
              if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));
              await session.step();
            } catch (err) {
              console.error(`Error during interleaved step for ${session.options.roleName}:`, err);
              session.completed = true; 
            }
          }
        }
        if (process.env.VERBOSE !== "true") logUpdate(renderDashboard(sessions, maxIterations));
        if (!anyActive) break;
      }
      if (process.env.VERBOSE !== "true") logUpdate.clear();

      // Teardown and Format Results
      for (let i = 0; i < roles.length; i++) {
        const matchingSession = sessions.find(s => s.roleName === roles[i].name);
        if (matchingSession && !interleavedResults[i]) {
          try {
            const finalized = matchingSession.session.finalize();
            interleavedResults[i] = { status: "fulfilled", value: finalized };
          } catch (err) {
            interleavedResults[i] = { status: "rejected", reason: err };
          }
          try {
            await matchingSession.client.close();
          } finally {
            activeClients.delete(matchingSession.client);
          }
        }
      }
      settled = interleavedResults;

    } else {
      settled = await runWithConcurrency(
        roles,
        concurrencyLimit,
        async (role, roleIndex) => {
          const roleArtifactDir = join(
            artifactsBaseDir,
            `${String(roleIndex + 1).padStart(2, "0")}-${roleKey(role.name)}`
          );
          await mkdir(roleArtifactDir, { recursive: true });

          const mcpClient = new McpClient({ workingDir: roleArtifactDir });
          activeClients.add(mcpClient);

          try {
            await mcpClient.connect();
            const appContext = await resolveRoleAppContext(
              role.contextFile,
              role.historicalBugReportsFile,
              appProfileDefaults.appVersion,
              appProfileDefaults.recentIssuesContext
            );
            const result = await runAgent({
              apiKey,
              model,
              mcpClient,
              roleName: role.name,
              targetUrl,
              maxIterations,
              testCredentials: role.testCredentials,
              appContext,
            });
            return result;
          } finally {
            try {
              await mcpClient.close();
            } finally {
              activeClients.delete(mcpClient);
            }
          }
        }
      );
    }

    const outcomes: RoleExecutionOutcome[] = [];

    for (let i = 0; i < settled.length; i++) {
      const role = roles[i];
      const reportName = `report-${roleKey(role.name)}-${hostPart}-${reportTimestamp}.md`;
      const reportPath = join(roleResultsDir, reportName);
      const settledResult = settled[i];

      if (settledResult.status === "fulfilled") {
        const markdown = toMarkdownReport(settledResult.value, appProfileDefaults);
        await writeFile(reportPath, markdown, "utf-8");
        console.log(`Role report written (${role.name}): ${reportPath}`);
        outcomes.push({
          role,
          status: "success",
          resultPath: reportPath,
          result: settledResult.value,
        });
      } else {
        const errorMessage =
          settledResult.reason instanceof Error
            ? settledResult.reason.message
            : String(settledResult.reason);
        const markdown = toFailedRoleReport(role.name, targetUrl, errorMessage);
        await writeFile(reportPath, markdown, "utf-8");
        console.error(`Role run failed (${role.name}): ${errorMessage}`);
        console.log(`Role failure report written (${role.name}): ${reportPath}`);
        outcomes.push({
          role,
          status: "failed",
          resultPath: reportPath,
          error: errorMessage,
        });
      }
    }

    let loggedIssues: LoggedIssue[] = [];
    let issueLoggingError: string | undefined;

    if (issueTrackerConfig?.enabled) {
      try {
        const findingsWithPaths: Array<IssueFinding & { reportPath: string }> = [];
        for (const outcome of outcomes) {
          if (outcome.status !== "success" || !outcome.result) {
            continue;
          }
          const findings = extractIssueFindings(
            outcome.role.name,
            outcome.result.finalReport
          );
          for (const finding of findings) {
            findingsWithPaths.push({
              ...finding,
              reportPath: outcome.resultPath,
            });
          }
        }

        loggedIssues = await logIssuesToGithub({
          config: issueTrackerConfig,
          findings: findingsWithPaths,
          targetUrl,
        });
        console.log(
          `GitHub issue logging completed. ${loggedIssues.length} issue entries processed.`
        );
      } catch (error) {
        issueLoggingError =
          error instanceof Error ? error.message : String(error);
        console.error(`GitHub issue logging failed: ${issueLoggingError}`);
      }
    }

    const combinedName = `combined-summary-${hostPart}-${reportTimestamp}.md`;
    const combinedPath = join(combinedResultsDir, combinedName);
    const combinedMarkdown = toCombinedSummaryMarkdown({
      targetUrl,
      model,
      maxIterations,
      concurrencyLimit,
      resultsScope: runScopeDir,
      appProfileDefaults,
      outcomes,
      loggedIssues,
      issueLoggingError,
      issueLoggingMode,
    });
    await writeFile(combinedPath, combinedMarkdown, "utf-8");
    console.log(`Combined summary written: ${combinedPath}`);

    // ── IssueOps: post summary comment and swap labels ──
    if (issueOpsConfig && issueParams) {
      try {
        const issueCount = outcomes
          .filter((o) => o.status === "success" && o.result)
          .reduce((sum, o) => {
            const matches = o.result!.finalReport.match(/\*\*Issues found:\*\*/g);
            return sum + (matches ? matches.length : 0);
          }, 0);
        const failedCount = outcomes.filter((o) => o.status === "failed").length;

        const summaryLines = [
          `## Explorer Run Complete`,
          ``,
          `| Detail | Value |`,
          `|--------|-------|`,
          `| Issue | #${issueParams.issueNumber} |`,
          `| Target | ${targetUrl} |`,
          appProfileDefaults.appVersion ? `| Version | ${appProfileDefaults.appVersion} |` : null,
          `| Roles | ${outcomes.length} (${outcomes.length - failedCount} succeeded, ${failedCount} failed) |`,
          `| Model | ${model} |`,
          ``,
          `**Report:** \`${combinedPath}\``,
        ].filter(Boolean).join("\n");

        await postIssueSummary(issueOpsConfig, summaryLines);
        console.log(`IssueOps: posted summary comment on issue #${issueParams.issueNumber}`);

        await swapIssueLabel(issueOpsConfig, "Explorerworking", "ExplorerFinished");
        console.log(`IssueOps: swapped label Explorerworking → ExplorerFinished`);
      } catch (issueOpsError) {
        console.error(
          `IssueOps feedback failed: ${issueOpsError instanceof Error ? issueOpsError.message : String(issueOpsError)}`
        );
      }
    }

    const successCount = outcomes.filter((o) => o.status === "success").length;
    if (successCount === 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  } finally {
    await Promise.all(
      Array.from(activeClients).map(async (client) => {
        try {
          await client.close();
        } catch {
          // ignore shutdown errors
        }
      })
    );
  }
}

main();
