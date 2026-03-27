# Exploratory Tester

A tool for exploratory testing with optional authenticated role coverage and concurrent role execution.

## Getting Started

```bash
npm install
npm run build
npm start -- https://example.com
```

## Configuration

Set your API key in `.env`:

```bash
GEMINI_API_KEY=your-api-key-here
```

Optional settings:

```bash
GEMINI_MODEL=gemini-2.0-flash
MAX_ITERATIONS=50
GEMINI_RATE_LIMIT_MAX_RETRIES=5
GEMINI_RATE_LIMIT_BASE_DELAY_MS=1000
GEMINI_RATE_LIMIT_MAX_DELAY_MS=30000
GEMINI_RATE_LIMIT_JITTER_MS=500
RESULTS_DIR=results
ISSUE_TRACKER_CONFIG_FILE=./apps/wlbooking/local/issue-tracker.github.json
HISTORICAL_BUG_REPORTS_FILE=./apps/wlbooking/local/historical-bugs.md
APP_UNDER_TEST=wlbooking
APP_PROFILE=local
```

## GitHub Issue Logging (Optional)

GitHub-only issue logging is supported via project config.

1. Copy `apps/example/local/issue-tracker.github.example.json` to `apps/<app>/<profile>/issue-tracker.github.json`.
2. Set your target repository and token env var in that file.
3. Set `ISSUE_TRACKER_CONFIG_FILE=./apps/<app>/<profile>/issue-tracker.github.json`.
4. Export a token with issue write access, for example `GITHUB_TOKEN`.

Example config:

```json
{
	"provider": "github",
	"enabled": true,
	"repo": "owner/repo",
	"tokenEnv": "GITHUB_TOKEN",
	"labels": ["exploratory-test", "auto-filed"],
	"titlePrefix": "[Exploratory]",
	"dedupeByTitle": true,
	"dryRun": false
}
```

Behavior:
- Extracts findings from `Issues Found` lines in final role reports.
- Files GitHub issues with severity and role labels.
- Dedupes by exact issue title when `dedupeByTitle` is enabled.
- Adds issue logging results to the combined summary output.

Dry-run mode:
- Set `"dryRun": true` to preview issue titles/findings without calling GitHub APIs.
- Combined summary will show planned issues as `DRY-RUN` entries.

Optional app context (hybrid mode):

```bash
MAX_CONCURRENT_AGENTS=2
# If set, file context is injected into the agent prompt
APP_CONTEXT_FILE=./apps/wlbooking/local/app-context.md
```

## App-Scoped Configuration (Optional)

Use app-scoped mode when you run this tester against multiple applications and want isolated config and outputs per app-under-test.

Enable scoped mode:

```bash
APP_UNDER_TEST=wlbooking
# optional, defaults to "default"
APP_PROFILE=local
```

When `APP_UNDER_TEST` is set, default config files are discovered from:

```text
apps/<app-under-test>/<app-profile>/roles.json
apps/<app-under-test>/<app-profile>/issue-tracker.github.json
apps/<app-under-test>/<app-profile>/app-context.md
apps/<app-under-test>/<app-profile>/historical-bugs.md
```

Results are isolated by default under:

```text
apps/<app-under-test>/<app-profile>/outputs/
```

Precedence rules:
- Explicit env vars always win (`ROLES_CONFIG_FILE`, `ISSUE_TRACKER_CONFIG_FILE`, `APP_CONTEXT_FILE`, `HISTORICAL_BUG_REPORTS_FILE`, `RESULTS_DIR`).
- App-scoped defaults are used only when explicit values are not set.
- If `APP_UNDER_TEST` is not set, behavior remains unchanged from legacy/global mode.

## App Scaffold Pattern

Use one app folder per app under `apps/`, with profiles beneath each app:

```text
apps/<app>/<profile>/
```

Example real app scaffold in this repo:

```text
apps/BookingPlatform/local/
```

This scaffold is config-only and does not change runtime defaults unless you explicitly set:

```bash
APP_UNDER_TEST=BookingPlatform
APP_PROFILE=local
```

Reusable templates are centralized under:

```text
apps/example/local/
```

Copy templates from `apps/example/local/` into your real app profile path as needed.

## Multi-Role Credentials

Preferred option: JSON config file.

```bash
ROLES_CONFIG_FILE=./apps/BookingPlatform/local/roles.json
```

JSON format accepts either `identifierType` + `identifier`, or `email`/`username`:

```json
{
	"roles": [
		{
			"name": "admin",
			"identifierType": "email",
			"identifier": "admin@example.com",
			"password": "admin-password",
			"contextFile": "./apps/wlbooking/local/admin-context.md",
			"historicalBugReportsFile": "./apps/wlbooking/local/admin-historical-bugs.md"
		},
		{
			"name": "member",
			"username": "member01",
			"password": "member-password",
			"contextFile": "./apps/wlbooking/local/member-context.md",
			"historicalBugReportsFile": "./apps/wlbooking/local/member-historical-bugs.md"
		}
	]
}
```

Env fallback (used only when `ROLES_CONFIG_FILE` is not set):

```bash
ROLES=admin,member
ROLE_ADMIN_EMAIL=admin@example.com
ROLE_ADMIN_PASSWORD=admin-password
ROLE_ADMIN_CONTEXT_FILE=./apps/wlbooking/local/admin-context.md
ROLE_ADMIN_HISTORICAL_BUG_REPORTS_FILE=./apps/wlbooking/local/admin-historical-bugs.md
ROLE_MEMBER_USERNAME=member01
ROLE_MEMBER_PASSWORD=member-password
ROLE_MEMBER_CONTEXT_FILE=./apps/wlbooking/local/member-context.md
ROLE_MEMBER_HISTORICAL_BUG_REPORTS_FILE=./apps/wlbooking/local/member-historical-bugs.md
```

Legacy single-role fallback (used only when neither `ROLES_CONFIG_FILE` nor `ROLES` is set):

```bash
TEST_USER_EMAIL=tester@example.com
TEST_USER_PASSWORD=your-password
APP_CONTEXT_FILE=./apps/wlbooking/local/app-context.md
HISTORICAL_BUG_REPORTS_FILE=./apps/wlbooking/local/historical-bugs.md
```

Historical bug report behavior:
- If historical bug reports are provided, they are injected into the agent prompt as risk context.
- The tester prioritizes previously affected areas first to check for regressions.
- This context is optional and can be set globally or per role.

## Context Behavior

Context is resolved per role:
- If role context file exists, that file is injected.
- If no role context file exists, quick auto-research runs for that role.

Role context files are Markdown/text.

## Writing App Context Files

High-signal context files usually include:
- Key user journeys and critical workflows.
- Domain rules and business constraints.
- Known risk areas and historical bugs.
- Important pages, routes, and roles/permissions.
- Any environment-specific test data notes.

## Usage

Run against a website (defaults to one role if no role config is set):

```bash
npm start -- https://www.bbc.co.uk
```

Run against localhost:

```bash
npm start -- http://localhost:3000
```

Run with JSON multi-role config:

```bash
ROLES_CONFIG_FILE=./apps/wlbooking/local/roles.json npm start -- http://localhost:3000
```

Run with env fallback multi-role config:

```bash
ROLES=admin,member npm start -- http://localhost:3000
```

## Outputs

Each run produces:
- Per-role reports in `apps/<app>/<profile>/outputs/<host>/<timestamp>/role-reports/`.
- Combined summary in `apps/<app>/<profile>/outputs/<host>/<timestamp>/combined/`.

Failure behavior:
- A role failure does not stop other roles.
- Process exits non-zero only if all roles fail.
