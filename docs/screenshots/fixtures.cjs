"use strict";

/**
 * Deterministic Control Center state used to render documentation screenshots.
 *
 * The payloads mirror what `ControlCenterProvider.refresh()` posts to the webview, so the
 * captures exercise the real rendering code rather than a mock of it. Timestamps are fixed
 * so repeated runs produce byte-comparable images.
 */

const AT = (time) => `2026-08-09T${time}Z`;

const VERIFICATION = [
  {
    name: "typecheck",
    command: "npm run check",
    invalidatedBy: ["src/**", "tsconfig.json"],
    category: "quality",
    required: true,
    status: "passed",
    finishedAt: AT("17:12:04.000"),
    durationMs: 900,
    exitCode: 0,
  },
  {
    name: "tests",
    command: "npm run test",
    invalidatedBy: ["src/**", "test/**"],
    category: "tests",
    required: true,
    status: "passed",
    finishedAt: AT("17:12:06.000"),
    durationMs: 1800,
    exitCode: 0,
    summary: { kind: "tests", total: 128, passed: 128, failed: 0, skipped: 0 },
  },
  {
    name: "core coverage",
    command: "npm run coverage",
    invalidatedBy: ["src/**", "test/**"],
    category: "coverage",
    required: true,
    status: "stale",
    finishedAt: AT("16:48:31.000"),
    durationMs: 2100,
    exitCode: 0,
    summary: { kind: "coverage", lines: 87.53, statements: 87.53, branches: 70.58, functions: 90.96, change: 1.24 },
  },
  {
    name: "dependency security",
    command: "npm run security",
    invalidatedBy: ["package.json", "package-lock.json"],
    category: "security",
    required: true,
    status: "passed",
    finishedAt: AT("17:12:09.000"),
    durationMs: 1400,
    exitCode: 0,
    summary: {
      kind: "security",
      total: 0,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      info: 0,
      newIssues: 0,
      fixedIssues: 2,
    },
  },
];

const FINDINGS = [
  {
    id: "finding-dependency-added",
    fingerprint: "dependency:fast-glob",
    ruleId: "runtime-dependency-change",
    title: "Runtime dependency added",
    explanation: "fast-glob@^3.3.3 was added to dependencies in package.json.",
    severity: "high",
    basis: "fact",
    evidence: [{ path: "package.json", line: 34, detail: "+    \"fast-glob\": \"^3.3.3\"" }],
    status: "open",
    firstObservedAt: AT("17:04:52.000"),
    lastObservedAt: AT("17:12:31.000"),
  },
  {
    id: "finding-assertions-removed",
    fingerprint: "assertions:test/verification.test.cjs",
    ruleId: "reduced-assertions",
    title: "Test assertions removed",
    explanation: "test/verification.test.cjs kept its test count but lost 3 recognizable assertions.",
    severity: "medium",
    basis: "fact",
    evidence: [{ path: "test/verification.test.cjs", detail: "12 assertions before · 9 after" }],
    status: "open",
    firstObservedAt: AT("17:06:18.000"),
    lastObservedAt: AT("17:12:31.000"),
  },
  {
    id: "finding-import-boundary",
    fingerprint: "boundary:src/ui/control-center.ts",
    ruleId: "architecture-boundary",
    title: "Import crosses a configured boundary",
    explanation: "src/ui/control-center.ts imports ../verification/verification-service, which ui-does-not-read-repository-directly forbids.",
    severity: "medium",
    basis: "configured-rule",
    evidence: [{ path: "src/ui/control-center.ts", line: 14, detail: "ui-does-not-read-repository-directly" }],
    status: "open",
    firstObservedAt: AT("17:09:44.000"),
    lastObservedAt: AT("17:12:31.000"),
  },
  {
    id: "finding-workflow-changed",
    fingerprint: "sensitive:.github/workflows/release.yml",
    ruleId: "sensitive-file-change",
    title: "GitHub workflow changed",
    explanation: ".github/workflows/release.yml was modified alongside application code.",
    severity: "medium",
    basis: "fact",
    evidence: [{ path: ".github/workflows/release.yml", detail: "modified" }],
    status: "accepted",
    firstObservedAt: AT("16:51:02.000"),
    lastObservedAt: AT("17:12:31.000"),
  },
];

const CODE_REVIEW = {
  provider: "claude",
  profile: "deep",
  model: "claude-opus-5",
  effort: "high",
  status: "completed",
  baselineCommit: "6a9c5f67b9403f1c8d2ab41f0d5c7e19a2f3b884",
  changeFingerprint: "3f9c1ad2",
  startedAt: AT("17:13:02.000"),
  finishedAt: AT("17:14:47.000"),
  summary:
    "Reviewed 9 changed files against HEAD. Two defects are worth fixing before merge; the remaining changes stay consistent with the existing verification flow.",
  findings: [
    {
      id: "review-stale-coverage",
      title: "Stale coverage is counted as current evidence",
      explanation:
        "readinessFor() filters on status !== \"failed\", so a stale coverage result still satisfies the required-gate check. A run from before the last edit will report the branch as ready.",
      severity: "high",
      path: "src/verification/verification-service.ts",
      line: 142,
    },
    {
      id: "review-unclamped-percent",
      title: "Usage percentage is formatted before it is clamped",
      explanation:
        "A provider reporting above 100% renders a bar wider than its track. Clamp usedPercent where it is parsed rather than at render time.",
      severity: "medium",
      path: "src/usage/provider-usage-service.ts",
      line: 88,
    },
    {
      id: "review-duplicate-normalization",
      title: "Model routing is normalized twice",
      explanation:
        "normalizeModelRouting() runs in both readModelRouting() and the settings writer. Harmless today, but the two paths can drift apart.",
      severity: "info",
      path: "src/providers/model-routing.ts",
      line: 22,
    },
  ],
  activity: [
    { at: AT("17:13:02.000"), label: "Review started", detail: "claude · deep · high effort" },
    { at: AT("17:13:05.000"), label: "Collected diff", detail: "9 files · 412 added · 96 removed" },
    { at: AT("17:13:28.000"), label: "Read file", detail: "src/verification/verification-service.ts" },
    { at: AT("17:13:51.000"), label: "Read file", detail: "src/usage/provider-usage-service.ts" },
    { at: AT("17:14:19.000"), label: "Read file", detail: "src/providers/model-routing.ts" },
    { at: AT("17:14:44.000"), label: "Validated structured evidence", detail: "3 findings · 3 resolved to changed lines" },
    { at: AT("17:14:47.000"), label: "Review completed", detail: "1 high · 1 medium · 1 info" },
  ],
};

const CHANGED_FILES = [
  ["src/verification/verification-service.ts", "modified"],
  ["src/usage/provider-usage-service.ts", "modified"],
  ["src/providers/model-routing.ts", "modified"],
  ["src/ui/control-center.ts", "modified"],
  ["src/domain/quality-gates.ts", "modified"],
  ["src/usage/usage-window.ts", "added"],
  ["test/verification.test.cjs", "modified"],
  ["test/usage.test.cjs", "added"],
  ["package.json", "modified"],
].map(([path, status]) => ({ path, status, binary: false }));

const AGENT_FILES = [
  {
    path: "AGENTS.md",
    title: "AGENTS.md",
    owner: "codex",
    kind: "instructions",
    exists: true,
    localOnly: false,
    description: "Shared repository guidance imported by CLAUDE.md.",
  },
  {
    path: ".codex/skills/verify-change/SKILL.md",
    title: "verify-change",
    owner: "codex",
    kind: "skills",
    exists: true,
    localOnly: false,
    description: "Runs the configured quality gates and reports which evidence went stale.",
  },
  {
    path: ".codex/config.toml",
    title: "Codex project settings",
    owner: "codex",
    kind: "settings",
    exists: true,
    localOnly: false,
    description: "Repository-scoped Codex configuration.",
  },
  {
    path: "CLAUDE.md",
    title: "CLAUDE.md",
    owner: "claude",
    kind: "instructions",
    exists: true,
    localOnly: false,
    description: "Imports AGENTS.md so both CLIs read the same guidance.",
  },
  {
    path: ".claude/skills/verify-change/SKILL.md",
    title: "verify-change",
    owner: "claude",
    kind: "skills",
    exists: true,
    localOnly: false,
    description: "Portable skill mirrored from the Codex workspace.",
  },
  {
    path: ".vibecheck/config.yaml",
    title: "Quality gates",
    owner: "vibecheck",
    kind: "settings",
    exists: true,
    localOnly: false,
    description: "Verification commands, invalidation paths, and plan discovery.",
  },
];

const BASE_STATE = {
  version: 7,
  workspaceRoot: "/Users/dev/repos/vibecheck",
  repositoryRoot: "/Users/dev/repos/vibecheck",
  baselineCommit: "6a9c5f67b9403f1c8d2ab41f0d5c7e19a2f3b884",
  headBranch: "feature/usage-windows",
  headSubject: "feat: report provider usage windows in the Control Center",
  startedAt: AT("16:44:10.000"),
  lastUpdatedAt: AT("17:14:52.000"),
  paused: false,
  selectedPlanPath: "PLAN.md",
  activePlan: {
    path: "PLAN.md",
    title: "VibeCheck implementation plan",
    modifiedAt: AT("15:39:07.000"),
    excerpt: "Local repository mode, deterministic findings, verification freshness, and provider-backed review.",
    tasks: [
      { text: "Verification freshness", status: "completed", line: 42 },
      { text: "Provider usage windows", status: "in-progress", line: 58 },
      { text: "Multi-root workspace support", status: "pending", line: 63 },
    ],
  },
  planCandidates: [],
  agentFiles: AGENT_FILES,
  changedFiles: CHANGED_FILES,
  findings: FINDINGS,
  codeReview: CODE_REVIEW,
  verification: VERIFICATION,
  trustedCommandHashes: [],
  agent: {
    connectedAgents: ["codex", "claude"],
    lastEventAt: AT("17:12:28.000"),
    lastEventType: "turn-stop",
  },
};

const BASE_PAYLOAD = {
  kind: "ready",
  state: BASE_STATE,
  readiness: {
    status: "incomplete",
    label: "Checks needed",
    reasons: [
      "core coverage is stale after the latest edits",
      "3 findings are still open",
    ],
  },
  missingGates: [],
  categories: {
    typecheck: "quality",
    tests: "tests",
    "core coverage": "coverage",
    "dependency security": "security",
  },
  configurationError: undefined,
  reviewTranscript: [],
  changeSummarySession: undefined,
  readmeMaintenanceSession: undefined,
  configurationSetupSession: undefined,
  instructionRefreshSession: undefined,
  providerUsage: {
    status: "ready",
    updatedAt: AT("17:10:00.000"),
    providers: [
      {
        provider: "codex",
        status: "ready",
        source: "/status",
        summary: "Plus plan · resets weekly",
        windows: [
          { label: "5h window", usedPercent: 34, resetText: AT("21:00:00.000") },
          { label: "Weekly", usedPercent: 62, resetText: "in 3 days" },
        ],
        fetchedAt: AT("17:10:00.000"),
      },
      {
        provider: "claude",
        status: "ready",
        source: "/usage",
        summary: "Max plan · resets weekly",
        windows: [
          { label: "Session", usedPercent: 18, resetText: AT("19:30:00.000") },
          { label: "Weekly (all models)", usedPercent: 71, resetText: "in 4 days" },
        ],
        fetchedAt: AT("17:10:00.000"),
      },
    ],
  },
  agentAlignment: {
    driftCount: 1,
    updatedAt: AT("17:12:31.000"),
    items: [
      {
        id: "alignment-instructions",
        surface: "instructions",
        label: "Shared instructions",
        status: "aligned",
        detail: "CLAUDE.md imports AGENTS.md, so both CLIs read the same guidance.",
        automatic: true,
        codexPath: "AGENTS.md",
        claudePath: "CLAUDE.md",
      },
      {
        id: "alignment-skills",
        surface: "skills",
        label: "verify-change skill",
        status: "conflict",
        detail: "Both copies changed since the last alignment. Choose which version should win.",
        automatic: false,
        codexPath: ".codex/skills/verify-change/SKILL.md",
        claudePath: ".claude/skills/verify-change/SKILL.md",
        newer: "claude",
      },
    ],
  },
  modelRouting: {
    codexBalanced: "gpt-5.6-terra",
    codexDeep: "gpt-5.6-sol",
    claudeBalanced: "claude-sonnet-5",
    claudeDeep: "claude-opus-5",
  },
  alignAgentWorkspace: false,
  // Read from the manifest so documentation never advertises a stale version.
  version: require("../../package.json").version,
};

/**
 * One capture per Control Center tab. `webviewState` seeds the shim behind
 * `acquireVsCodeApi().getState()`, which is how the panel decides the active tab and
 * which collapsible sections start open.
 */
const CAPTURES = [
  {
    name: "status",
    file: "vibecheck-status.png",
    webviewState: {
      activeView: "status",
      expandedSections: ["status:evidence", "status:attention"],
    },
    payload: BASE_PAYLOAD,
  },
  {
    name: "review",
    file: "vibecheck-review.png",
    webviewState: {
      activeView: "review",
      expandedSections: ["review:code-review"],
    },
    payload: BASE_PAYLOAD,
  },
  {
    name: "quality",
    file: "vibecheck-quality.png",
    webviewState: {
      activeView: "quality",
      expandedSections: ["quality:gates"],
    },
    payload: BASE_PAYLOAD,
  },
  {
    name: "tools",
    file: "vibecheck-tools.png",
    webviewState: {
      activeView: "tools",
      expandedSections: ["tools:change-summary", "tools:usage"],
      agentFileOwner: "claude",
    },
    payload: BASE_PAYLOAD,
  },
];

module.exports = { CAPTURES };
