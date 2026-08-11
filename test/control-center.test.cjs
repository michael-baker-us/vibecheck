const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const uiSource = (file) => readFileSync(join(__dirname, "..", "src", "ui", file), "utf8");
const extensionSource = () => readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");

test("ships a syntactically valid task-oriented Control Center", () => {
  const source = `${uiSource("control-center.ts")}\n${uiSource("control-center-view.ts")}`;
  const script = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, "expected an embedded webview script");
  assert.doesNotThrow(() => new Function(script));
  for (const view of ["Status", "Review", "Quality", "Team", "Settings"]) {
    assert.match(source, new RegExp(`'${view}'`));
  }
  assert.match(source, /Change confidence/);
  assert.match(source, /Ready for human review/);
  assert.match(source, /next-action/);
  assert.match(source, /More actions/);
  assert.match(source, /Run code review/);
  assert.match(source, /Summarize changes/);
  assert.match(source, /README maintenance/);
  assert.match(source, /Choose model and update README/);
  assert.match(source, /vibecheck\.maintainReadme/);
  assert.match(
    source,
    /const qualityActions=el\('div','actions single-action'\).*button\('Run all checks','run-all',undefined,'primary'\).*gates\.content\.append\(qualityActions\)/,
    "expected Quality to expose a full-width shared run-all action",
  );
  assert.match(source, /\.actions\.single-action \{ grid-template-columns: 1fr; \}/);
  const runAllLabels = [...source.matchAll(/button\('([^']+)','run-all'/g)].map((match) => match[1]);
  assert.deepEqual(runAllLabels, ["Run all checks", "Run all checks", "Run all checks"]);
  const checkReportLabels = [...source.matchAll(/button\('([^']+)','check-output'/g)].map((match) => match[1]);
  assert.deepEqual(checkReportLabels, ["View report", "View report"]);
  assert.match(source, /button\('View check report','check-output-menu'/);
  assert.match(source, /const gateOutcome = gate =>/);
  assert.match(source, /VibeCheck .\+\(data\.version\|\|.unknown.\)/);
  assert.match(source, /version: this\.version/);
  assert.match(source, /const adapterInstallation = this\.getAdapterInstallation\(\)/);
  assert.match(source, /adapterInstallation,/);
  assert.match(source, /summaryUnrecognized/);
  assert.match(source, /format: or report_path:/);
  assert.match(source, /Ran · format not recognised/);
  assert.match(source, /const noMetrics=category=>/);
  assert.match(source, /const otherGateTiles=\(\)=>/);
  assert.match(source, /METRIC_CATEGORIES=\[.tests.,.coverage.,.security.\]/);
  assert.match(source, /metrics\.append\(\.\.\.otherGateTiles\(\)\)/);
  assert.match(source, /v\.summaryFormat/);
  assert.match(source, /showView\('review'\)/);
  assert.match(source, /pages\.review\.append\(changeSummary\.card\)/);
  assert.match(source, /pages\.review\.append\(readme\.card\)/);
  assert.match(source, /navItems=\[\['status'.*\['quality','Quality'\],\['review','Review'\],\['team','Team'\],\['settings','Settings'\]\]/);
  // Five labels ellipsize to nothing in a narrow sidebar, so the nav must rewrap below 360px.
  assert.match(source, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(source, /\.nav \{ grid-template-columns:repeat\(3,minmax\(0,1fr\)\); \}/);
  assert.match(source, /pages\.team\.append\(roster\.card\)/);
  assert.match(source, /pages\.team\.append\(activity\.card\)/);
  // Transcript detail is ephemeral: the activity view must state the persistence boundary.
  assert.match(source, /Live view, held in memory only/);
  assert.match(source, /Nothing shown here is written to workspace state/);
  assert.match(source, /lifecycleSessions=act\.sessions\.filter/, "Codex activity must remain visible beside Claude transcripts");
  assert.match(source, /elapsed\(d\.startedAt,d\.finishedAt\)/, "completed delegation duration must stop at finish time");
  // The Team panel must keep stating that VibeCheck maintains the roster but never runs the agents.
  assert.match(source, /never launches these agents/);
  assert.match(source, /installed · awaiting Codex approval/);
  assert.match(source, /observed · active/);
  assert.match(source, /observed · idle/);
  assert.match(source, /adapterConnectionState\(adapterInstallation\.codex, snapshot\.state\.teamActivity\.sessions, "codex"\)/);
  assert.match(source, /state\.kind==='active'\|\|state\.kind==='observed-idle'/);
  assert.match(source, /not installed/);
  assert.match(source, /Codex keeps the final hook trust decision in its native review screen/);
  assert.match(source, /tools:'settings'/, "an existing saved Tools selection must migrate");
  assert.doesNotMatch(source, /pages\.tools\b/);
  assert.match(source, /section\('Change summary','Markdown','review:change-summary'/);
  assert.match(source, /Working tree changes vs HEAD/);
  assert.match(source, /Source branch → target branch/);
  assert.match(source, /Fetch the latest target branch from its remote/);
  assert.match(source, /Clear review/);
  assert.match(source, /vibecheck\.clearCodeReview/);
  assert.match(source, /Claude & Codex usage/);
  assert.match(source, /pages\.settings\.append\(usage\.card\)/);
  assert.match(source, /Codex \/status and Claude \/usage/);
  assert.match(source, /Refresh usage/);
  assert.match(source, /usage-track/);
  assert.match(source, /Live CLI review/);
  assert.match(source, /review-terminal/);
  assert.match(source, /const cliTranscript =/);
  assert.match(source, /transcriptViews/);
  assert.match(source, /transcriptPins/);
  assert.match(source, /Minimize/);
  assert.match(source, /Clear preview/);
  assert.match(source, /Show CLI preview/);
  assert.match(source, /reviewState\.status==='completed'\?'minimized':'expanded'/);
  assert.match(source, /summarySession\.status==='completed'\?'minimized':'expanded'/);
  assert.match(source, /setupSession\.status==='completed'\?'minimized':'expanded'/);
  assert.match(source, /instructionSession\.status==='applied'\?'minimized':'expanded'/);
  assert.match(source, /focus\(\{preventScroll:true\}\)/);
  assert.match(source, /vscode-reduce-motion/);
  assert.match(source, /aria-current/);
  assert.match(source, /expandedSections/);
  assert.match(source, /summary\.section-head/);
  assert.match(source, /Claude ↔ Codex compatibility/);
  assert.match(source, /Continuously align safe, portable files in this workspace/);
  assert.match(
    source,
    /entry\.surface==='plans'\)actions\.append\(button\('Open plan','open-plan',undefined,'ghost'\)\)/,
    "expected the shared plan alignment action to use the active-plan command",
  );
  assert.match(source, /Model routing/);
  assert.match(source, /Save model routes/);
  assert.match(source, /set-model-routing/);
  assert.match(source, /Choose model and configure/);
  assert.match(source, /Agent-assisted setup and updates/);
  assert.match(source, /Live CLI configuration/);
  assert.match(source, /configurationSetupSession/);
  assert.match(source, /Generate instruction files/);
  assert.match(source, /Generate supporting files/);
  assert.match(source, /Templates and examples/);
  assert.match(source, /const tab=el\('button','tab',label\)/);
  assert.doesNotMatch(source, /label\+' \('\+files\.length\+'\)'/);
  assert.match(source, /Open template/);
  assert.match(source, /open-agent-capability-template/);
  assert.match(source, /vibecheck\.openAgentCapabilityTemplate/);
  assert.doesNotMatch(source, /generate-agent-capability|generateAgentCapability/);
  assert.match(source, /Clear agent workspace/);
  assert.match(source, /Apply all proposed files/);
  assert.match(source, /Preview all changes/);
  assert.match(source, /Live CLI workspace scan/);
  assert.match(source, /instructionRefreshSession/);
  assert.doesNotMatch(source, /product-bar|brand-mark|brand-context/);
  assert.doesNotMatch(source, /button\('Refresh','refresh'/);
  assert.doesNotMatch(source, /f\.exists\?'Open':'Create'/);

  for (const action of [
    "select-plan", "open-plan", "refresh", "refresh-provider-usage", "pause", "resume",
    "run-all", "run-review", "clear-review", "preview-review", "summarize-changes", "maintain-readme",
    "check-output-menu", "copy-prompt", "export", "config", "setup-prompt", "install-codex",
    "install-claude", "remove-adapter", "delete", "start", "manage-agent-file",
    "generate-agent-instructions", "refresh-agent-instructions", "open-agent-capability-template", "preview-agent-workspace", "preview-agent-instruction",
    "apply-agent-instructions", "discard-agent-instructions", "align-agent-instructions",
    "set-agent-alignment", "resolve-agent-alignment", "clear-agent-workspace",
    "inspect-review", "inspect-finding", "accept-finding", "dismiss-finding",
    "reopen-finding", "prompt-finding", "run-check", "check-output",
    "install-default-team", "preview-team", "apply-team", "add-team-member",
    "open-team-roster", "open-team-member", "toggle-team-member", "delete-team-member",
  ]) {
    assert.match(source, new RegExp(`['"]${action}['"]`), `expected ${action} to remain reachable`);
  }
});

test("keeps regex escapes intact through the webview template literal", () => {
  const { controlCenterHtml } = require("../dist/ui/control-center-view");
  const html = controlCenterHtml("vscode-webview://test");

  // `\d` and `\.` inside a template literal silently lose their backslash unless doubled,
  // which previously shipped `/^d{4}-d{2}-d{2}T/` and never matched an ISO timestamp.
  assert.match(html, /const iso=\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\//);
  assert.equal(html.split("/\\.[^/]+$/").length - 1, 2, "expected both file-extension tests to keep their escape");

  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "expected an embedded webview script");
  assert.doesNotThrow(() => new Function(script));
});

test("offers a revision range for code review, matching the change summary form", () => {
  const source = uiSource("control-center-view.ts");

  assert.match(source, /section\('Review scope','Working tree','review:scope'/);
  assert.match(source, /reviewOptions=\(\)=>\(\{mode:rvMode\.value/);
  assert.match(source, /action:'run-review',options:reviewOptions\(\)/);
  for (const mode of ["working-tree", "branches", "commits"]) {
    assert.match(source, new RegExp(`'${mode}'`), `review scope must offer ${mode}`);
  }
  // A completed review has to say what it actually covered.
  assert.match(source, /const scopeLabel=reviewState\.range/);
  assert.match(uiSource("control-center.ts"), /message\.action === "run-review" && message\.options !== undefined/);
});

test("mirrors the Status page readiness onto the view badge", () => {
  const source = uiSource("control-center.ts");

  assert.match(source, /readinessBadge/);
  assert.match(source, /this\.view\.badge = readinessBadge\(readiness\)/);
});

test("opens Codex in the repository for its native hook trust decision", () => {
  const source = extensionSource();

  assert.match(source, /name: "VibeCheck Codex Hook Review"/);
  assert.match(source, /cwd: workspaceFolder\.uri/);
  assert.match(source, /terminal\.sendText\("codex"\)/);
  assert.match(source, /must make the final hook trust decision/);
  assert.match(source, /active only after it observes a local Codex event/);
  assert.doesNotMatch(source, /Codex adapter installed/);
});
