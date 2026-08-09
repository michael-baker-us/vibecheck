import * as vscode from "vscode";

import { VibeCheckConfiguration } from "../domain/configuration";
import { ChangeSummarySession } from "../domain/change-summary";
import { ConfigurationSetupSession } from "../domain/configuration-setup";
import { InstructionRefreshSession } from "../domain/instruction-refresh";
import { AgentAlignmentSnapshot } from "../agent-instructions/alignment-service";
import { categoryFor, calculateReadiness, missingRecommendedCategories } from "../domain/quality-gates";
import { ObservationSnapshot } from "../domain/observation-state";
import { ProviderUsageSnapshot } from "../usage/provider-usage-service";
import { DEFAULT_MODEL_ROUTING, MODEL_ROUTING_SETTINGS, normalizeModelRouting } from "../providers/model-routing";

type WebviewMessage = { action?: unknown; id?: unknown; options?: unknown };

export class ControlCenterProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly getSnapshot: () => ObservationSnapshot,
    private readonly getConfiguration: () => VibeCheckConfiguration,
    private readonly getConfigurationError: () => string | undefined,
    private readonly getReviewTranscript: () => Array<{ at: string; kind: string; label: string; content?: string }>,
    private readonly getChangeSummarySession: () => ChangeSummarySession | undefined,
    private readonly getConfigurationSetupSession: () => ConfigurationSetupSession | undefined,
    private readonly getInstructionRefreshSession: () => InstructionRefreshSession | undefined,
    private readonly getProviderUsage: () => ProviderUsageSnapshot,
    private readonly getAgentAlignment: () => AgentAlignmentSnapshot,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
    this.refresh();
  }

  public refresh(): void {
    if (!this.view) return;
    const snapshot = this.getSnapshot();
    const configuration = this.getConfiguration();
    const missingGates = missingRecommendedCategories(configuration.verification);
    const baseReadiness = snapshot.kind === "ready"
      ? calculateReadiness(snapshot.state.findings, snapshot.state.verification)
      : undefined;
    const readiness = baseReadiness && missingGates.length
      ? {
          status: baseReadiness.status === "ready" ? "incomplete" as const : baseReadiness.status,
          label: baseReadiness.status === "ready" ? "Setup incomplete" : baseReadiness.label,
          reasons: [...baseReadiness.reasons, `Missing recommended gates: ${missingGates.join(", ")}`],
        }
      : baseReadiness;
    const payload = snapshot.kind === "ready"
      ? {
          kind: "ready",
          state: snapshot.state,
          readiness,
          missingGates,
          categories: Object.fromEntries(
            configuration.verification.map((definition) => [definition.name, categoryFor(definition)]),
          ),
          configurationError: this.getConfigurationError(),
          reviewTranscript: this.getReviewTranscript(),
          changeSummarySession: this.getChangeSummarySession(),
          configurationSetupSession: this.getConfigurationSetupSession(),
          instructionRefreshSession: this.getInstructionRefreshSession(),
          providerUsage: this.getProviderUsage(),
          agentAlignment: this.getAgentAlignment(),
          modelRouting: readModelRouting(),
          alignAgentWorkspace: vscode.workspace.getConfiguration(
            "vibecheck",
            vscode.workspace.workspaceFolders?.[0]?.uri,
          ).get<boolean>("alignAgentWorkspace", false),
        }
      : snapshot;
    void this.view.webview.postMessage({ type: "state", payload });
  }

  private async handle(message: WebviewMessage): Promise<void> {
    if (typeof message.action !== "string") return;
    if (message.action === "summarize-changes" && message.options !== undefined) {
      await vscode.commands.executeCommand("vibecheck.summarizeChanges", message.options);
      return;
    }
    if (message.action === "set-agent-alignment" && typeof message.options === "boolean") {
      await vscode.commands.executeCommand("vibecheck.setAgentAlignment", message.options);
      return;
    }
    if (message.action === "resolve-agent-alignment" && typeof message.id === "string") {
      await vscode.commands.executeCommand("vibecheck.resolveAgentAlignment", message.id);
      return;
    }
    if (message.action === "set-model-routing") {
      await vscode.commands.executeCommand("vibecheck.setModelRouting", message.options);
      return;
    }
    const id = typeof message.id === "string" ? message.id : undefined;
    const simpleCommands: Record<string, string> = {
      "select-plan": "vibecheck.selectPlan",
      "open-plan": "vibecheck.openPlan",
      refresh: "vibecheck.refresh",
      "refresh-provider-usage": "vibecheck.refreshProviderUsage",
      pause: "vibecheck.pause",
      resume: "vibecheck.start",
      "run-all": "vibecheck.runAllVerification",
      "run-review": "vibecheck.runCodeReview",
      "clear-review": "vibecheck.clearCodeReview",
      "preview-review": "vibecheck.previewCodeReview",
      "summarize-changes": "vibecheck.summarizeChanges",
      "check-output-menu": "vibecheck.showVerificationOutput",
      "copy-prompt": "vibecheck.copyPrompt",
      export: "vibecheck.createReport",
      config: "vibecheck.openConfig",
      "setup-prompt": "vibecheck.createSetupPrompt",
      "install-codex": "vibecheck.installCodexAdapter",
      "install-claude": "vibecheck.installClaudeAdapter",
      "remove-adapter": "vibecheck.uninstallAgentAdapter",
      "initialize-agent-workspace": "vibecheck.initializeAgentWorkspace",
      "refresh-agent-instructions": "vibecheck.refreshAgentInstructions",
      "apply-agent-instructions": "vibecheck.applyAgentInstructionRefresh",
      "discard-agent-instructions": "vibecheck.discardAgentInstructionRefresh",
      "align-agent-instructions": "vibecheck.alignAgentInstructions",
      delete: "vibecheck.deleteData",
      start: "vibecheck.start",
    };
    const command = simpleCommands[message.action];
    if (command) {
      await vscode.commands.executeCommand(command);
      return;
    }

    const snapshot = this.getSnapshot();
    if (snapshot.kind !== "ready" || !id) return;
    if (message.action === "manage-agent-file") {
      await vscode.commands.executeCommand("vibecheck.manageAgentFile", id);
      return;
    }
    if (message.action === "preview-agent-instruction") {
      await vscode.commands.executeCommand("vibecheck.previewAgentInstruction", id);
      return;
    }
    if (message.action === "inspect-review") {
      await vscode.commands.executeCommand("vibecheck.inspectCodeReviewFinding", id);
      return;
    }
    const finding = snapshot.state.findings.find((item) => item.id === id);
    if (finding) {
      const findingCommands: Record<string, string> = {
        "inspect-finding": "vibecheck.inspectFinding",
        "accept-finding": "vibecheck.acceptFinding",
        "dismiss-finding": "vibecheck.dismissFinding",
        "reopen-finding": "vibecheck.reopenFinding",
        "prompt-finding": "vibecheck.copyPrompt",
      };
      const findingCommand = findingCommands[message.action];
      if (findingCommand) await vscode.commands.executeCommand(findingCommand, finding);
      return;
    }
    if (message.action === "run-check") await vscode.commands.executeCommand("vibecheck.runVerification", id);
    if (message.action === "check-output") await vscode.commands.executeCommand("vibecheck.showVerificationOutput", id);
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      color-scheme: light dark;
      --panel-background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --panel-surface: color-mix(in srgb, var(--vscode-foreground) 5%, var(--panel-background));
      --panel-surface-strong: color-mix(in srgb, var(--vscode-foreground) 9%, var(--panel-background));
      --panel-border: var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 22%, transparent));
      --panel-muted: color-mix(in srgb, var(--vscode-foreground) 72%, var(--panel-background));
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; color: var(--vscode-foreground); background:var(--panel-background); font: var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    button { font: inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity:.62; }
    button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
    .shell { display: grid; gap: 11px; max-width: 900px; margin: 0 auto; padding:12px; }
    .nav { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:3px; padding:3px; border:1px solid var(--panel-border); border-radius:8px; background:var(--panel-surface); position:sticky; top:0; z-index:5; box-shadow:0 5px 14px color-mix(in srgb,var(--panel-background) 72%,transparent); }
    .nav-btn { min-width:0; min-height:32px; padding:6px 4px; border:1px solid transparent; border-radius:5px; color:var(--panel-muted); background:transparent; font-size:11px; overflow:hidden; text-overflow:ellipsis; }
    .nav-btn:hover { color:var(--vscode-foreground); background:var(--vscode-list-hoverBackground); }
    .nav-btn[aria-current="page"] { color:var(--vscode-button-foreground); background:var(--vscode-button-background); font-weight:650; }
    .page { display:grid; gap:12px; min-width:0; }
    .page[hidden] { display:none; }
    .hero, .card { border: 1px solid var(--panel-border); border-radius: 8px; background: var(--panel-surface); }
    .hero { padding: 15px; border-color:color-mix(in srgb,var(--vscode-button-background) 55%,var(--panel-border)); background: linear-gradient(145deg, color-mix(in srgb, var(--vscode-button-background) 16%, var(--panel-background)), var(--panel-surface) 72%); box-shadow:0 4px 16px color-mix(in srgb,var(--panel-background) 68%,transparent); }
    .hero-top, .row, .section-head, .item-head { display: flex; align-items: center; gap: 8px; }
    .hero-top, .section-head, .item-head { justify-content: space-between; }
    .eyebrow { margin-bottom:4px; color:var(--panel-muted); font-size:10px; font-weight:700; letter-spacing:.7px; text-transform:uppercase; }
    h1 { font-size: 17px; margin: 0; letter-spacing: -.2px; }
    h2 { font-size: 13px; margin: 0; }
    p { margin: 5px 0 0; color: var(--panel-muted); }
    .badge { border:1px solid transparent; border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 650; white-space: nowrap; }
    .ready { color: var(--vscode-testing-iconPassed); }
    .blocked { color: var(--vscode-testing-iconFailed); }
    .incomplete { color: var(--vscode-editorWarning-foreground); }
    .neutral { color: var(--panel-muted); }
    .badge.ready { background:color-mix(in srgb,var(--vscode-testing-iconPassed) 16%,var(--panel-background)); border-color:color-mix(in srgb,var(--vscode-testing-iconPassed) 42%,var(--panel-border)); }
    .badge.blocked { background:color-mix(in srgb,var(--vscode-testing-iconFailed) 16%,var(--panel-background)); border-color:color-mix(in srgb,var(--vscode-testing-iconFailed) 42%,var(--panel-border)); }
    .badge.incomplete { background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 16%,var(--panel-background)); border-color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 42%,var(--panel-border)); }
    .badge.neutral { background:var(--panel-surface-strong); border-color:var(--panel-border); }
    .plan { margin-top: 12px; padding: 10px; border-radius: 6px; background: var(--panel-surface-strong); }
    .plan strong { display:block; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--panel-muted); }
    .plan span { display:block; margin-top:3px; }
    .next-action { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; margin-top:11px; padding:10px; border:1px solid color-mix(in srgb,var(--vscode-focusBorder) 45%,transparent); border-radius:7px; background:color-mix(in srgb,var(--vscode-focusBorder) 7%,transparent); }
    .next-action strong { display:block; font-size:12px; }
    .next-action span { display:block; margin-top:2px; color:var(--panel-muted); font-size:11px; }
    .actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; margin-top: 10px; }
    .actions.single-action { grid-template-columns: 1fr; }
    .btn { min-height: 30px; padding: 5px 9px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.ghost { color: var(--vscode-foreground); background: var(--panel-surface); border-color: var(--panel-border); }
    .btn.ghost:hover { background:var(--panel-surface-strong); }
    .btn.small { min-height: 30px; padding: 4px 8px; font-size: 11px; }
    .card { overflow: hidden; }
    .section-head { padding: 10px 12px; border-bottom: 1px solid var(--panel-border); }
    .section-head span { margin-left:auto; color: var(--panel-muted); font-size: 11px; }
    summary.section-head { list-style:none; }
    summary.section-head::-webkit-details-marker { display:none; }
    summary.section-head::after { content:'›'; color:var(--panel-muted); font-size:17px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
    details.card[open] > summary.section-head::after { transform:rotate(90deg); }
    details.card:not([open]) > summary.section-head { border-bottom:0; }
    .content { padding: 10px 12px; display:grid; gap:8px; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr)); gap:7px; }
    .metric { padding:9px; border:1px solid var(--panel-border); border-radius:6px; background:var(--panel-background); min-width:0; }
    .metric-label { color:var(--panel-muted); font-size:11px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; }
    .metric-value { margin-top:2px; font-size:18px; line-height:1.25; font-weight:700; overflow-wrap:anywhere; }
    .metric-detail { color:var(--panel-muted); font-size:11px; margin-top:2px; }
    .tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid var(--panel-border); }
    .tab { flex:1; min-width:0; padding:8px 6px 7px; border:0; border-bottom:2px solid transparent; color:var(--panel-muted); background:transparent; overflow-wrap:anywhere; }
    .tab:hover { color:var(--vscode-foreground); background:var(--vscode-list-hoverBackground); }
    .tab[aria-selected="true"] { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder); }
    .tab-panel { padding-top:2px; }
    .capability-group { display:grid; gap:7px; }
    .capability-group + .capability-group { margin-top:5px; }
    .capability-label { color:var(--panel-muted); font-size:11px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; }
    .item { padding: 9px; border: 1px solid var(--panel-border); border-radius: 6px; background:var(--panel-background); }
    .item-title { font-weight: 600; overflow-wrap:anywhere; }
    .meta { color: var(--panel-muted); font-size: 11px; margin-top: 3px; overflow-wrap:anywhere; }
    .item-actions { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
    .dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--panel-muted); }
    .dot.passed { background:var(--vscode-testing-iconPassed); } .dot.failed { background:var(--vscode-testing-iconFailed); }
    .dot.stale, .dot.running { background:var(--vscode-editorWarning-foreground); }
    .empty { text-align:center; padding:12px; color:var(--panel-muted); }
    .callout { padding:9px; border:1px solid var(--panel-border); border-radius:6px; background:var(--panel-surface-strong); color:var(--panel-muted); }
    .callout strong { color:var(--vscode-foreground); }
    .reason { margin:3px 0; }
    details { border-top: 1px solid var(--panel-border); }
    summary { padding:10px 12px; cursor:pointer; font-weight:600; }
    details .content { padding-top:0; }
    .danger { color:var(--vscode-errorForeground)!important; }
    .footer { text-align:center; font-size:11px; color:var(--panel-muted); padding:4px; overflow-wrap:anywhere; }
    .section-intro { color:var(--panel-muted); font-size:11px; padding:0 1px; }
    .form-grid { display:grid; gap:9px; }
    .form-field { display:grid; gap:4px; color:var(--panel-muted); font-size:11px; }
    .form-field > span { font-weight:600; color:var(--vscode-foreground); }
    .form-field input, .form-field select { width:100%; min-width:0; box-sizing:border-box; padding:6px 7px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,var(--panel-border)); border-radius:3px; font:inherit; }
    .form-field input:focus, .form-field select:focus { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
    .check-field { display:flex; align-items:flex-start; gap:7px; color:var(--vscode-foreground); font-size:11px; }
    .check-field input { margin:1px 0 0; }
    .review-preview { display:grid; gap:7px; padding:9px; border:1px solid var(--panel-border); border-radius:6px; background:var(--panel-background); }
    .review-preview-head { display:flex; align-items:center; gap:7px; font-weight:650; }
    .review-pulse { width:8px; height:8px; border-radius:50%; background:var(--vscode-progressBar-background); box-shadow:0 0 0 0 color-mix(in srgb,var(--vscode-progressBar-background) 55%,transparent); animation:review-pulse 1.6s infinite; }
    .review-activity { display:grid; gap:5px; margin:0; padding:0; list-style:none; }
    .review-activity li { display:grid; grid-template-columns:auto minmax(0,1fr); gap:7px; color:var(--panel-muted); font-size:11px; }
    .review-activity time { font-variant-numeric:tabular-nums; }
    .review-activity strong { color:var(--vscode-foreground); font-weight:550; }
    .review-activity span { overflow-wrap:anywhere; }
    .review-terminal { max-height:420px; overflow:auto; border:1px solid var(--panel-border); border-radius:6px; background:var(--vscode-textCodeBlock-background,var(--vscode-editor-background)); color:var(--vscode-editor-foreground,var(--vscode-foreground)); }
    .review-terminal-head { position:sticky; top:0; z-index:1; display:flex; justify-content:space-between; gap:8px; padding:7px 9px; border-bottom:1px solid var(--panel-border); background:var(--panel-surface-strong); font-size:11px; }
    .review-terminal-head span:last-child { color:var(--panel-muted); }
    .review-terminal-entry { padding:8px 9px; border-bottom:1px solid color-mix(in srgb,var(--panel-border) 65%,transparent); }
    .review-terminal-entry:last-child { border-bottom:0; }
    .review-terminal-meta { display:flex; align-items:center; gap:7px; color:var(--panel-muted); font:11px/1.35 var(--vscode-editor-font-family,var(--vscode-font-family)); }
    .review-terminal-kind { color:var(--vscode-symbolIcon-functionForeground,var(--vscode-focusBorder)); text-transform:uppercase; font-weight:700; }
    .review-terminal-entry.tool .review-terminal-kind { color:var(--vscode-symbolIcon-methodForeground,var(--vscode-testing-iconPassed)); }
    .review-terminal-entry.output .review-terminal-kind { color:var(--panel-muted); }
    .review-terminal-entry.error .review-terminal-kind { color:var(--vscode-errorForeground); }
    .review-terminal-entry pre { margin:6px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; color:inherit; font:11px/1.45 var(--vscode-editor-font-family,monospace); }
    .usage-window { display:grid; gap:5px; }
    .usage-window-head { display:flex; justify-content:space-between; gap:8px; font-size:11px; }
    .usage-track { height:7px; overflow:hidden; border-radius:999px; background:var(--panel-surface-strong); border:1px solid var(--panel-border); }
    .usage-fill { height:100%; border-radius:inherit; background:var(--vscode-testing-iconPassed); }
    .usage-fill.warning { background:var(--vscode-editorWarning-foreground); }
    .usage-fill.danger { background:var(--vscode-testing-iconFailed); }
    @keyframes review-pulse { 70% { box-shadow:0 0 0 5px transparent; } 100% { box-shadow:0 0 0 0 transparent; } }
    .action-drawer { margin-top:10px; border:1px solid var(--panel-border); border-radius:6px; background:color-mix(in srgb,var(--panel-surface) 76%,transparent); }
    .action-drawer summary { padding:8px 10px; color:var(--panel-muted); font-size:11px; }
    .action-drawer .actions { margin:0; padding:0 9px 9px; }
    @media (max-width: 360px) {
      .shell { gap:9px; padding:8px; }
      .hero, .content { padding:10px; }
      .section-head { padding:9px 10px; }
      .actions, .metrics, .next-action { grid-template-columns:1fr; }
      .next-action .btn, .actions .btn { width:100%; }
      .hero-top, .item-head { align-items:flex-start; flex-wrap:wrap; }
      .item-head > :first-child { min-width:0; }
      .badge { white-space:normal; }
    }
    @media (max-width: 240px) {
      .shell { padding:6px; }
      .tabs { padding:0 6px; }
      .item-actions .btn { flex:1 1 100%; }
    }
    body.vscode-reduce-motion .review-pulse { animation:none; }
    body.vscode-reduce-motion summary.section-head::after { transition:none; }
    @media (prefers-reduced-motion: reduce) { .review-pulse { animation:none; } summary.section-head::after { transition:none; } }
  </style>
</head>
<body><main id="app" class="shell"><div class="empty" role="status" aria-live="polite">Loading local workspace state…</div></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const send = (action,id) => vscode.postMessage({action,id});
  const el = (tag, cls, text) => { const node=document.createElement(tag); if(cls) node.className=cls; if(text!==undefined) node.textContent=text; return node; };
  let buttonSequence=0;
  const button = (label,action,id,kind='secondary') => { const node=el('button','btn small '+kind,label); node.dataset.focusKey='action:'+action+':'+(id||'')+':'+buttonSequence++; node.onclick=()=>send(action,id); return node; };
  const section = (title,count,stateKey,defaultOpen=true) => { const card=el('details','card'); card.dataset.stateKey=stateKey; const saved=vscode.getState()?.expandedSections; card.open=Array.isArray(saved)?saved.includes(stateKey):defaultOpen; const head=el('summary','section-head'); head.append(el('h2','',title),el('span','',String(count))); const content=el('div','content'); card.append(head,content); card.ontoggle=()=>{ const expanded=[...document.querySelectorAll('details.card[data-state-key][open]')].map(node=>node.dataset.stateKey); vscode.setState({...vscode.getState(),expandedSections:expanded}); }; return {card,content}; };
  const percent = value => Number(value).toFixed(2)+'%';
  const signed = value => (value>0?'+':'')+Number(value).toFixed(2)+' pp';
  const summaryText = summary => { if(!summary)return 'No structured metrics detected.'; if(summary.kind==='tests'){ const failures=summary.failed?summary.failed+' failed':'no failures',skipped=summary.skipped?' · '+summary.skipped+' skipped':''; return summary.passed+' of '+summary.total+' tests passed · '+failures+skipped; } if(summary.kind==='coverage'){ const dimensions=[percent(summary.lines)+' lines',summary.branches===undefined?undefined:percent(summary.branches)+' branches',summary.functions===undefined?undefined:percent(summary.functions)+' functions',summary.statements===undefined?undefined:percent(summary.statements)+' statements'].filter(Boolean).join(' · '); return dimensions+(summary.change?' · '+signed(summary.change)+' since last run':''); } const severity=[summary.critical?summary.critical+' critical':undefined,summary.high?summary.high+' high':undefined,summary.moderate?summary.moderate+' moderate':undefined,summary.low?summary.low+' low':undefined].filter(Boolean).join(' · '),movement=[summary.newIssues?summary.newIssues+' new':undefined,summary.fixedIssues?summary.fixedIssues+' fixed':undefined].filter(Boolean).join(' · '); return summary.total?summary.total+' vulnerabilities'+(severity?' · '+severity:'')+(movement?' · '+movement:''):'No known vulnerabilities'+(movement?' · '+movement:''); };
  const gateOutcome = gate => { if(gate.summary)return summaryText(gate.summary); if(gate.status==='passed')return 'Completed successfully. Open the report for command details and raw output.'; if(gate.status==='failed')return 'Failed'+(gate.exitCode===undefined?'':' with exit code '+gate.exitCode)+'. Open the report for diagnostic highlights and raw output.'; if(gate.status==='stale')return 'This result is stale because relevant repository inputs changed. Run the gate again.'; if(gate.status==='running')return 'Running now. Results will appear when the command finishes.'; return 'Not run yet. Run this gate to collect evidence.'; };
  const metric = (label,value,detail,tone='neutral') => { const node=el('div','metric'); node.append(el('div','metric-label',label),el('div','metric-value '+tone,value),el('div','metric-detail',detail)); return node; };
  const kindLabels={instructions:'Instructions',skills:'Skills',prompts:'Prompts & commands',agents:'Subagents',settings:'Settings',rules:'Rules',hooks:'Hooks',mcp:'MCP servers',plugins:'Plugins','output-styles':'Output styles'};
  const kindOrder=['instructions','skills','prompts','agents','settings','rules','hooks','mcp','plugins','output-styles'];
  const agentFileItem = f => { const item=el('div','item'),head=el('div','item-head'),owner=f.owner==='vibecheck'?'VibeCheck':f.owner; head.append(el('span','item-title',f.title),el('span','badge '+(f.exists?'ready':'neutral'),f.exists?'present':'optional')); item.append(head,el('div','meta',owner+' · '+(kindLabels[f.kind]||f.kind)+' · '+f.path+(f.localOnly?' · local only':'')),el('p','',f.description)); const a=el('div','item-actions'); a.append(button(f.exists?'Open':'Create','manage-agent-file',f.path,f.exists?'secondary':'ghost')); item.append(a); return item; };
  function render(data) {
    const focusedKey=document.activeElement?.dataset?.focusKey;
    const previousScroll=window.scrollY;
    const previousTerminal=document.querySelector('.review-terminal');
    const transcriptPinned=!previousTerminal||previousTerminal.scrollTop+previousTerminal.clientHeight>=previousTerminal.scrollHeight-24;
    const actionDrawerOpen=document.querySelector('.action-drawer')?.open===true;
    buttonSequence=0;
    app.replaceChildren();
    if (data.kind !== 'ready') { const box=el('section','hero'); box.append(el('h1','', 'VibeCheck'),el('p','',data.reason)); box.append(button('Start observing','start',undefined,'primary')); app.append(box); return; }
    const s=data.state, open=s.findings.filter(f=>f.status==='open'), history=s.findings.filter(f=>f.status!=='open');
    const latest=category=>s.verification.filter(v=>(data.categories[v.name]||'other')===category&&v.summary).sort((a,b)=>(b.finishedAt||'').localeCompare(a.finishedAt||''))[0];
    const testGate=latest('tests'), coverageGate=latest('coverage'), securityGate=latest('security');
    const gateTone=gate=>!gate?'neutral':gate.status==='passed'?'ready':gate.status==='failed'?'blocked':'incomplete';
    const qualityMetrics=(includeChanges=false)=>{ const metrics=el('div','metrics'); metrics.append(
      metric('Tests',testGate?testGate.summary.passed+'/'+testGate.summary.total:'—',testGate?testGate.summary.failed+' failed · '+testGate.status:'No result yet',gateTone(testGate)),
      metric('Line coverage',coverageGate?percent(coverageGate.summary.lines):'—',coverageGate?(coverageGate.summary.change?signed(coverageGate.summary.change)+' · ':'')+coverageGate.status:'No result yet',gateTone(coverageGate)),
      metric('Security',securityGate?String(securityGate.summary.total):'—',securityGate?securityGate.summary.newIssues+' new · '+securityGate.summary.fixedIssues+' fixed':'No result yet',securityGate&&securityGate.status==='passed'&&securityGate.summary.total?'incomplete':gateTone(securityGate))
    ); if(includeChanges)metrics.append(metric('Changed files',String(s.changedFiles.length),s.headBranch||'detached HEAD','neutral')); return metrics; };

    const pages={status:el('section','page'),review:el('section','page'),quality:el('section','page'),tools:el('section','page')};
    const nav=el('nav','nav'), navItems=[['status','Status'+(open.length?' · '+open.length:'')],['review','Review'],['quality','Quality'],['tools','Tools']];
    nav.setAttribute('aria-label','VibeCheck sections');
    const savedView=(vscode.getState()||{}).activeView, migratedView={overview:'status',attention:'status',summarize:'tools',usage:'tools',workspace:'tools'}[savedView]||savedView, initialView=pages[migratedView]?migratedView:'status';
    const showView=view=>{ Object.entries(pages).forEach(([key,page])=>page.hidden=key!==view); nav.querySelectorAll('.nav-btn').forEach(item=>{ if(item.dataset.view===view)item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current'); }); vscode.setState({...vscode.getState(),activeView:view}); };
    navItems.forEach(([view,label])=>{ const item=el('button','nav-btn',label); item.type='button'; item.dataset.view=view; item.dataset.focusKey='nav:'+view; item.onclick=()=>{ showView(view); window.scrollTo(0,0); }; nav.append(item); }); app.append(nav);

    const hero=el('section','hero'), top=el('div','hero-top');
    hero.append(el('div','eyebrow','Change confidence'));
    const readinessTitle=data.readiness.status==='ready'?'Ready for human review':data.readiness.status==='blocked'?'Needs action':'Checks needed';
    top.append(el('h1','',readinessTitle),el('span','badge '+data.readiness.status,data.readiness.label)); hero.append(top);
    hero.append(el('p','',s.changedFiles.length+' uncommitted '+(s.changedFiles.length===1?'change':'changes')+' on '+(s.headBranch||'the current branch')+'.'));
    const reasons=el('div',''); data.readiness.reasons.forEach(r=>reasons.append(el('p','reason','• '+r))); hero.append(reasons);
    const failed=s.verification.find(v=>v.required!==false&&v.status==='failed'), highFinding=open.find(f=>f.severity==='high'), unfinished=s.verification.find(v=>v.required!==false&&v.status!=='passed');
    const next=el('div','next-action'),nextCopy=el('div','');
    if(failed){ nextCopy.append(el('strong','','Inspect '+failed.name),el('span','','A required quality gate is failing.')); next.append(nextCopy,button('View report','check-output',failed.name,'primary')); }
    else if(highFinding){ nextCopy.append(el('strong','','Review '+highFinding.title),el('span','','Resolve or acknowledge the highest-risk finding.')); next.append(nextCopy,button('Inspect','inspect-finding',highFinding.id,'primary')); }
    else if(unfinished){ nextCopy.append(el('strong','','Refresh required evidence'),el('span','','Run pending or stale checks against the current files.')); next.append(nextCopy,button('Run all checks','run-all',undefined,'primary')); }
    else { nextCopy.append(el('strong','','Capture the evidence'),el('span','','All required checks are current. Export a review snapshot.')); next.append(nextCopy,button('Create report','export',undefined,'primary')); }
    hero.append(next);
    const actionDrawer=el('details','action-drawer'),actionSummary=el('summary','','More actions'),primary=el('div','actions'),summaryNav=button('Summarize changes','summarize-changes'); actionDrawer.open=actionDrawerOpen; actionSummary.dataset.focusKey='status:more-actions'; summaryNav.onclick=()=>{ showView('tools'); window.scrollTo(0,0); }; primary.append(button('Run code review','run-review',undefined,'primary'),summaryNav,button('Run all checks','run-all'),button('Create report','export'),button('Copy agent follow-up','copy-prompt'),button('Open active plan','open-plan',undefined,'ghost')); actionDrawer.append(actionSummary,primary); hero.append(actionDrawer);
    const currentEvidence=section('Current evidence','4 signals','status:evidence',true); currentEvidence.content.append(qualityMetrics(true)); pages.status.append(hero,currentEvidence.card);

    pages.review.append(el('div','section-intro','Ask Codex or Claude to review the current uncommitted diff for concrete, actionable defects.'));
    const review=section('Code review',s.codeReview?s.codeReview.findings.length:'not run','review:code-review',true);
    const reviewState=s.codeReview;
      if(!reviewState){ const c=el('div','callout'),routes=data.modelRouting; c.append(el('strong','','No semantic review yet'),el('p','','Balanced: Codex '+routes.codexBalanced+' or Claude '+routes.claudeBalanced+' at medium effort.'),el('p','','Deep: Codex '+routes.codexDeep+' or Claude '+routes.claudeDeep+' at high effort.')); review.content.append(c,button('Choose model and run review','run-review',undefined,'primary')); }
    else {
      const tone=reviewState.status==='completed'?'ready':reviewState.status==='failed'?'blocked':'incomplete';
      const head=el('div','item-head'); head.append(el('span','item-title',(reviewState.provider==='codex'?'Codex':'Claude')+' · '+reviewState.profile+' review'),el('span','badge '+tone,reviewState.status));
      const reviewMeta=el('div','meta',reviewState.model+' · '+reviewState.effort+' effort · started '+new Date(reviewState.startedAt).toLocaleString()+(reviewState.finishedAt?' · finished '+new Date(reviewState.finishedAt).toLocaleTimeString():''));
      if(reviewState.status==='running'){ reviewMeta.dataset.reviewStarted=reviewState.startedAt; }
      const overview=el('div','item'); overview.append(head,reviewMeta);
      if(reviewState.summary) overview.append(el('p','',reviewState.summary));
      if(reviewState.error) overview.append(el('div','callout danger',reviewState.error));
      const reviewActions=el('div','item-actions'),rerun=button(reviewState.status==='running'?'Review running…':'Run another review','run-review',undefined,reviewState.status==='running'?'secondary':'primary'); rerun.disabled=reviewState.status==='running'; reviewActions.append(rerun); if(reviewState.status!=='running')reviewActions.append(button('Open Markdown preview','preview-review',undefined,'ghost'),button('Clear review','clear-review',undefined,'ghost')); overview.append(reviewActions);
      review.content.append(overview);
      const transcript=data.reviewTranscript||[]; if(transcript.length){ const terminal=el('div','review-terminal'),terminalHead=el('div','review-terminal-head'); terminalHead.append(el('strong','',reviewState.status==='running'?'Live CLI review':'CLI review transcript'),el('span','',reviewState.status==='running'?'streaming · memory only':'memory only')); terminal.append(terminalHead); transcript.forEach(entry=>{ const row=el('div','review-terminal-entry '+entry.kind),meta=el('div','review-terminal-meta'); meta.append(el('span','review-terminal-kind',entry.kind),el('time','',new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})),el('strong','',entry.label)); row.append(meta); if(entry.content)row.append(el('pre','',entry.content)); terminal.append(row); }); review.content.append(terminal); if(transcriptPinned)requestAnimationFrame(()=>{ terminal.scrollTop=terminal.scrollHeight; }); }
      if(!transcript.length&&reviewState.activity&&reviewState.activity.length){ const preview=el('div','review-preview'),previewHead=el('div','review-preview-head'); if(reviewState.status==='running')previewHead.append(el('i','review-pulse')); previewHead.append(el('span','',reviewState.status==='running'?'Review activity':'Activity summary')); const activity=el('ol','review-activity'); reviewState.activity.slice(-8).forEach(entry=>{ const row=el('li'),time=el('time','',new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})),copy=el('span'); copy.append(el('strong','',entry.label)); if(entry.detail)copy.append(document.createTextNode(' · '+entry.detail)); row.append(time,copy); activity.append(row); }); preview.append(previewHead,activity); review.content.append(preview); }
      if(reviewState.status==='stale') review.content.append(el('div','callout','The working-tree diff changed after this review. Run it again before relying on these findings.'));
      if(!reviewState.findings.length&&reviewState.status==='completed') review.content.append(el('div','empty','No actionable defects reported.'));
      reviewState.findings.forEach(f=>{ const item=el('div','item'),h=el('div','item-head'); h.append(el('span','item-title',f.title),el('span','badge '+(f.severity==='high'?'blocked':f.severity==='medium'?'incomplete':'neutral'),f.severity)); item.append(h,el('div','meta',(f.path||'Repository-level')+(f.line?':'+f.line:'')),el('p','',f.explanation)); if(f.path){ const a=el('div','item-actions'); a.append(button('Inspect','inspect-review',f.id,'secondary')); item.append(a); } review.content.append(item); });
    }
    pages.review.append(review.card);
    const routing=data.modelRouting,modelRoutes=section('Model routing','Balanced + Deep','tools:model-routing',false),routingIntro=el('div','section-intro','Choose the exact provider model used by both semantic reviews and change summaries. Effort stays profile-based: Balanced uses medium; Deep uses high.'),routingForm=el('div','form-grid');
    const routeFields={}; [['codexBalanced','Codex · Balanced'],['codexDeep','Codex · Deep'],['claudeBalanced','Claude · Balanced'],['claudeDeep','Claude · Deep']].forEach(([key,label])=>{ const field=el('label','form-field'),caption=el('span','',label),input=el('input',''); input.type='text'; input.value=routing[key]; input.dataset.routeKey=key; input.dataset.focusKey='model-route:'+key; input.spellcheck=false; field.append(caption,input); routingForm.append(field); routeFields[key]=input; });
    const saveRoutes=button('Save model routes','',undefined,'primary'); saveRoutes.onclick=()=>vscode.postMessage({action:'set-model-routing',options:Object.fromEntries(Object.entries(routeFields).map(([key,input])=>[key,input.value]))}); routingForm.append(saveRoutes); modelRoutes.content.append(routingIntro,routingForm); pages.tools.append(modelRoutes.card);
    pages.tools.append(el('div','eyebrow','Change communication'),el('div','section-intro','Create a plain-language Markdown summary for working-tree, branch, or revision changes.'));
    const changeSummary=section('Change summary','Markdown','tools:change-summary',true);
    const summaryCallout=el('div','callout'); summaryCallout.append(el('strong','','Plain-language merge summary'),el('p','',s.changedFiles.length+' uncommitted file change'+(s.changedFiles.length===1?' is':'s are')+' available. Choose exactly what should be compared.'));
    const savedSummary=(vscode.getState()||{}).summaryOptions||{},form=el('div','form-grid'),modeField=el('label','form-field'),modeLabel=el('span','','Compare'),mode=el('select','');
    mode.dataset.focusKey='summary:mode'; [['working-tree','Working tree changes vs HEAD'],['branches','Source branch → target branch'],['commits','Two commits or refs']].forEach(([value,label])=>{ const option=el('option','',label); option.value=value; mode.append(option); }); mode.value=savedSummary.mode||(s.changedFiles.length?'working-tree':'branches'); modeField.append(modeLabel,mode);
    const sourceField=el('label','form-field'),sourceLabel=el('span','','Source branch'),source=el('input',''); source.type='text'; source.dataset.focusKey='summary:source'; source.value=savedSummary.source||s.headBranch||'HEAD'; source.placeholder='feature/my-change'; sourceField.append(sourceLabel,source);
    const targetField=el('label','form-field'),targetLabel=el('span','','Target branch'),target=el('input',''); target.type='text'; target.dataset.focusKey='summary:target'; target.value=savedSummary.target||'main'; target.placeholder='main'; targetField.append(targetLabel,target);
    const fetchField=el('label','check-field'),fetchLatest=el('input',''); fetchLatest.type='checkbox'; fetchLatest.dataset.focusKey='summary:fetch'; fetchLatest.checked=savedSummary.fetchLatest===true; fetchField.append(fetchLatest,el('span','','Fetch the latest target branch from its remote before comparing'));
    const remoteField=el('label','form-field'),remoteLabel=el('span','','Remote'),remote=el('input',''); remote.type='text'; remote.dataset.focusKey='summary:remote'; remote.value=savedSummary.remote||'origin'; remote.placeholder='origin'; remoteField.append(remoteLabel,remote);
    const modelField=el('label','form-field'),modelLabel=el('span','','Provider and model'),model=el('select','');
    model.dataset.focusKey='summary:model'; [['codex-balanced','Codex · '+routing.codexBalanced+' · medium effort (Recommended)'],['codex-deep','Codex · '+routing.codexDeep+' · high effort'],['claude-balanced','Claude · '+routing.claudeBalanced+' · medium effort (Recommended)'],['claude-deep','Claude · '+routing.claudeDeep+' · high effort']].forEach(([value,label])=>{ const option=el('option','',label); option.value=value; model.append(option); }); model.value=savedSummary.model||'codex-balanced'; modelField.append(modelLabel,model);
    const summaryOptions=()=>({mode:mode.value,source:source.value,target:target.value,fetchLatest:fetchLatest.checked,remote:remote.value,model:model.value});
    const saveSummaryOptions=()=>vscode.setState({...vscode.getState(),summaryOptions:summaryOptions()});
    const updateSummaryForm=()=>{ const working=mode.value==='working-tree',branches=mode.value==='branches'; sourceField.hidden=working; targetField.hidden=working; fetchField.hidden=!branches; remoteField.hidden=!branches||!fetchLatest.checked; sourceLabel.textContent=branches?'Source branch':'From commit or ref'; targetLabel.textContent=branches?'Target branch':'To commit or ref'; source.placeholder=branches?'feature/my-change':'older commit hash or ref'; target.placeholder=branches?'main':'newer commit hash or ref'; };
    mode.onchange=()=>{ updateSummaryForm(); saveSummaryOptions(); }; fetchLatest.onchange=()=>{ updateSummaryForm(); saveSummaryOptions(); }; [source,target,remote].forEach(input=>input.oninput=saveSummaryOptions); model.onchange=saveSummaryOptions; updateSummaryForm();
    const summarySession=data.changeSummarySession,summaryRunning=summarySession?.status==='running';
    const createSummary=button(summaryRunning?'Summary running…':'Create Markdown summary','',undefined,'primary'); createSummary.disabled=summaryRunning; createSummary.onclick=()=>{ saveSummaryOptions(); vscode.postMessage({action:'summarize-changes',options:summaryOptions()}); };
    form.append(modeField,sourceField,targetField,fetchField,remoteField,modelField,createSummary);
    changeSummary.content.append(summaryCallout,form);
    if(summarySession){ const tone=summarySession.status==='completed'?'ready':summarySession.status==='failed'?'blocked':'incomplete',head=el('div','item-head'); head.append(el('span','item-title',(summarySession.provider==='codex'?'Codex':'Claude')+' · '+summarySession.profile+' summary'),el('span','badge '+tone,summarySession.status)); const session=el('div','item'); session.append(head,el('div','meta',summarySession.baseLabel+' → '+summarySession.targetLabel+' · '+summarySession.model+' · started '+new Date(summarySession.startedAt).toLocaleString())); if(summarySession.error)session.append(el('div','callout danger',summarySession.error)); changeSummary.content.append(session); const transcript=summarySession.transcript||[]; if(transcript.length){ const terminal=el('div','review-terminal'),terminalHead=el('div','review-terminal-head'); terminalHead.append(el('strong','',summaryRunning?'Live CLI summary':'CLI summary transcript'),el('span','',summaryRunning?'streaming · memory only':'memory only')); terminal.append(terminalHead); transcript.forEach(entry=>{ const row=el('div','review-terminal-entry '+entry.kind),meta=el('div','review-terminal-meta'); meta.append(el('span','review-terminal-kind',entry.kind),el('time','',new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})),el('strong','',entry.label)); row.append(meta); if(entry.content)row.append(el('pre','',entry.content)); terminal.append(row); }); changeSummary.content.append(terminal); if(transcriptPinned)requestAnimationFrame(()=>{ terminal.scrollTop=terminal.scrollHeight; }); } }
    pages.tools.append(changeSummary.card);

    const usageState=data.providerUsage,usage=section('Claude & Codex usage',usageState.status==='loading'?'refreshing':'provider reported','tools:usage',false);
    usage.content.append(el('div','section-intro','Account usage reported directly by Codex /status and Claude /usage. Results stay in memory and refresh on demand.'));
    if(usageState.status==='idle')usage.content.append(el('div','empty','Usage has not been loaded yet.'));
    usageState.providers.forEach(provider=>{ const label=provider.provider==='codex'?'Codex':'Claude',item=el('div','item'),head=el('div','item-head'); head.append(el('span','item-title',label+' '+provider.source),el('span','badge '+(provider.status==='ready'?'ready':'blocked'),provider.status)); item.append(head); if(provider.summary)item.append(el('div','meta',provider.summary)); if(provider.detail)item.append(el('div','callout danger',provider.detail)); provider.windows.forEach(window=>{ const row=el('div','usage-window'),rowHead=el('div','usage-window-head'),percentUsed=Math.max(0,Math.min(100,Number(window.usedPercent))); rowHead.append(el('span','',window.label),el('strong','',Number(window.usedPercent).toFixed(0)+'% used')); const track=el('div','usage-track'),fill=el('div','usage-fill '+(percentUsed>=90?'danger':percentUsed>=70?'warning':'')); fill.style.width=percentUsed+'%'; track.append(fill); row.append(rowHead,track); if(window.resetText){ const iso=/^\d{4}-\d{2}-\d{2}T/.test(window.resetText); row.append(el('div','meta','Resets '+(iso?new Date(window.resetText).toLocaleString():window.resetText))); } item.append(row); }); usage.content.append(item); });
    const usageActions=el('div','item-actions'),refreshUsage=button(usageState.status==='loading'?'Refreshing usage…':'Refresh usage','refresh-provider-usage',undefined,'secondary'); refreshUsage.disabled=usageState.status==='loading'; usageActions.append(refreshUsage); usage.content.append(usageActions); if(usageState.updatedAt)usage.content.append(el('div','meta','Updated '+new Date(usageState.updatedAt).toLocaleString())); pages.tools.append(usage.card);

    const gates=section('Quality gates',s.verification.length,'quality:gates',true);
    pages.quality.append(el('div','section-intro','Run, inspect, and compare repository-owned checks. Passing evidence becomes stale when relevant inputs change.'));
    if(data.configurationError) gates.content.append(el('div','callout danger','Configuration error: '+data.configurationError));
    if(data.missingGates.length) { const c=el('div','callout'); c.append(el('strong','', 'Recommended setup missing'),el('p','',data.missingGates.join(', ')+' — add these checks so “ready” means more.')); c.append(button('Configure gates','config')); gates.content.append(c); }
    gates.content.append(qualityMetrics());
    const qualityActions=el('div','actions single-action'); qualityActions.append(button('Run all checks','run-all',undefined,'primary')); gates.content.append(qualityActions);
    if(!s.verification.length) gates.content.append(el('div','empty','No checks configured yet. Add tests, coverage, and security checks.'));
    s.verification.forEach(v=>{ const item=el('div','item'), head=el('div','item-head'), title=el('div','row'); title.append(el('i','dot '+v.status),el('span','item-title',v.name)); head.append(title,el('span','badge '+(v.status==='passed'?'ready':v.status==='failed'?'blocked':'incomplete'),v.status)); item.append(head,el('div','meta',(data.categories[v.name]||'other')+(v.required===false?' · optional':' · required')+(v.finishedAt?' · '+new Date(v.finishedAt).toLocaleString():'')+(v.durationMs!==undefined?' · '+(v.durationMs/1000).toFixed(1)+'s':'')),el('div','callout'+(v.status==='failed'?' danger':''),gateOutcome(v))); const a=el('div','item-actions'); a.append(button(v.status==='running'?'Running…':'Run','run-check',v.name),button('View report','check-output',v.name,'ghost')); item.append(a); gates.content.append(item); });
    const setupSession=data.configurationSetupSession,setupRunning=setupSession?.status==='running',setupConfig=el('div','callout'); setupConfig.append(el('strong','','Agent-assisted setup and updates'),el('p','','Choose a Balanced or Deep Codex/Claude model. VibeCheck runs the provider as a managed, cancellable CLI session and validates the resulting .vibecheck files.')); const gateActions=el('div','item-actions'),runSetup=button(setupRunning?'Configuration running…':'Choose model and configure','setup-prompt',undefined,'primary'); runSetup.disabled=setupRunning; gateActions.append(runSetup,button('Open configuration file','config',undefined,'ghost')); setupConfig.append(gateActions); gates.content.append(setupConfig);
    if(setupSession){ const tone=setupSession.status==='completed'?'ready':setupSession.status==='failed'?'blocked':'incomplete',head=el('div','item-head'); head.append(el('span','item-title',(setupSession.provider==='codex'?'Codex':'Claude')+' · '+setupSession.profile+' configuration '+setupSession.mode),el('span','badge '+tone,setupSession.status)); const item=el('div','item'),changed=setupSession.changedFiles?.length?' · '+setupSession.changedFiles.join(', '):''; item.append(head,el('div','meta',setupSession.model+' · '+setupSession.effort+' effort · started '+new Date(setupSession.startedAt).toLocaleString()+changed)); if(setupSession.error)item.append(el('div','callout danger',setupSession.error)); gates.content.append(item); const transcript=setupSession.transcript||[]; if(transcript.length){ const terminal=el('div','review-terminal'),terminalHead=el('div','review-terminal-head'); terminalHead.append(el('strong','',setupRunning?'Live CLI configuration':'CLI configuration transcript'),el('span','',setupRunning?'streaming · memory only':'memory only')); terminal.append(terminalHead); transcript.forEach(entry=>{ const row=el('div','review-terminal-entry '+entry.kind),meta=el('div','review-terminal-meta'); meta.append(el('span','review-terminal-kind',entry.kind),el('time','',new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})),el('strong','',entry.label)); row.append(meta); if(entry.content)row.append(el('pre','',entry.content)); terminal.append(row); }); gates.content.append(terminal); if(transcriptPinned)requestAnimationFrame(()=>{ terminal.scrollTop=terminal.scrollHeight; }); } }
    pages.quality.append(gates.card);

    const attention=section('Needs attention',open.length,'status:attention',open.length>0);
    pages.status.append(el('div','eyebrow','Findings'),el('div','section-intro','Review high-signal findings, record intentional changes, and keep the readiness decision explainable.'));
    if(!open.length) attention.content.append(el('div','empty','No unresolved findings.'));
    open.forEach(f=>{ const item=el('div','item'); const head=el('div','item-head'); head.append(el('span','item-title',f.title),el('span','badge '+(f.severity==='high'?'blocked':'incomplete'),f.severity)); item.append(head,el('div','meta',f.basis+' · '+f.explanation)); const a=el('div','item-actions'); a.append(button('Inspect','inspect-finding',f.id),button('Ask agent','prompt-finding',f.id),button('Intentional','accept-finding',f.id,'ghost'),button('Dismiss','dismiss-finding',f.id,'ghost')); item.append(a); attention.content.append(item); }); pages.status.append(attention.card);

    const agents=section('Agent workspace',s.agentFiles.filter(f=>f.exists).length+' configured','tools:agents',false);
    const plan=el('div','item');
    if(s.activePlan){
      const ph=el('div','item-head'); ph.append(el('span','item-title',s.activePlan.title),el('span','badge ready','active plan')); plan.append(ph,el('div','meta',s.activePlan.path));
      if(s.activePlan.excerpt) plan.append(el('p','',s.activePlan.excerpt));
      if(s.activePlan.tasks.length){ const done=s.activePlan.tasks.filter(t=>t.status==='completed').length; plan.append(el('div','meta',done+'/'+s.activePlan.tasks.length+' steps complete')); }
      const pa=el('div','item-actions'); pa.append(button('Open plan','open-plan'),button('Choose another','select-plan',undefined,'ghost')); plan.append(pa);
    } else {
      plan.append(el('div','item-title','No repository plan detected'),el('div','meta','Choose an existing Markdown plan; VibeCheck will not create a competing intent.'));
      plan.append(button('Choose plan','select-plan'));
    }
    agents.content.append(plan);
    const alignment=el('div','item'),alignmentHead=el('div','item-head'),alignmentDrift=data.agentAlignment?.driftCount||0;
    alignmentHead.append(el('span','item-title','Claude ↔ Codex compatibility'),el('span','badge '+(alignmentDrift?'incomplete':'ready'),alignmentDrift?alignmentDrift+' need review':'aligned'));
    alignment.append(alignmentHead,el('p','','VibeCheck shares provider-neutral plans, imports canonical AGENTS.md guidance into CLAUDE.md, and mirrors one-sided open-standard skills. Provider-specific schemas are flagged with the newer side instead of being overwritten.'));
    const alignmentToggle=el('label','check-field'),alignmentCheckbox=el('input',''); alignmentCheckbox.type='checkbox'; alignmentCheckbox.checked=data.alignAgentWorkspace===true; alignmentCheckbox.dataset.focusKey='agents:alignment'; alignmentCheckbox.onchange=()=>vscode.postMessage({action:'set-agent-alignment',options:alignmentCheckbox.checked}); alignmentToggle.append(alignmentCheckbox,el('span','','Continuously align safe, portable files in this workspace'));
    const instructionSession=data.instructionRefreshSession,instructionRunning=instructionSession?.status==='running',instructionPreview=instructionSession?.status==='preview';
    const alignmentActions=el('div','item-actions'),refreshInstructions=button(instructionRunning?'Analyzing instructions…':'Update from repository','refresh-agent-instructions',undefined,'primary'); refreshInstructions.disabled=instructionRunning; alignmentActions.append(refreshInstructions,button('Initialize both','initialize-agent-workspace'),button('Align safe changes now','align-agent-instructions',undefined,'secondary')); alignment.append(alignmentToggle,alignmentActions);
    if(instructionSession){ const tone=instructionSession.status==='applied'?'ready':instructionSession.status==='failed'?'blocked':instructionSession.status==='preview'?'incomplete':'neutral',sessionItem=el('div','callout'),sessionHead=el('div','item-head'); sessionHead.append(el('strong','',(instructionSession.provider==='codex'?'Codex':'Claude')+' · '+instructionSession.profile+' instruction update'),el('span','badge '+tone,instructionSession.status)); sessionItem.append(sessionHead,el('div','meta',instructionSession.model+' · '+instructionSession.effort+' effort · started '+new Date(instructionSession.startedAt).toLocaleString())); if(instructionSession.summary)sessionItem.append(el('p','',instructionSession.summary)); if(instructionSession.error)sessionItem.append(el('p','danger',instructionSession.error)); (instructionSession.files||[]).forEach(file=>{ const fileRow=el('div','item'),head=el('div','item-head'); head.append(el('span','item-title',file.path),el('span','badge '+(file.status==='unchanged'?'ready':'incomplete'),file.status)); fileRow.append(head); if(instructionPreview&&file.status!=='unchanged'){ const actions=el('div','item-actions'); actions.append(button('Preview diff','preview-agent-instruction',file.path,'secondary')); fileRow.append(actions); } sessionItem.append(fileRow); }); if(instructionPreview){ const proposalActions=el('div','item-actions'); proposalActions.append(button('Apply proposed updates','apply-agent-instructions',undefined,'primary'),button('Discard','discard-agent-instructions',undefined,'ghost')); sessionItem.append(proposalActions); } alignment.append(sessionItem); const transcript=instructionSession.transcript||[]; if(transcript.length){ const terminal=el('div','review-terminal'),terminalHead=el('div','review-terminal-head'); terminalHead.append(el('strong','',instructionRunning?'Live CLI instruction audit':'CLI instruction audit transcript'),el('span','',instructionRunning?'streaming · memory only':'memory only')); terminal.append(terminalHead); transcript.forEach(entry=>{ const row=el('div','review-terminal-entry '+entry.kind),meta=el('div','review-terminal-meta'); meta.append(el('span','review-terminal-kind',entry.kind),el('time','',new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})),el('strong','',entry.label)); row.append(meta); if(entry.content)row.append(el('pre','',entry.content)); terminal.append(row); }); alignment.append(terminal); if(transcriptPinned)requestAnimationFrame(()=>{ terminal.scrollTop=terminal.scrollHeight; }); } }
    const alignmentItems=(data.agentAlignment?.items||[]).filter(item=>item.status!=='not-configured');
    alignmentItems.forEach(entry=>{ const row=el('div','callout'),head=el('div','item-head'),tone=entry.status==='aligned'||entry.status==='shared'?'ready':entry.status==='conflict'?'blocked':'incomplete'; head.append(el('strong','',entry.label),el('span','badge '+tone,entry.status)); row.append(head,el('div','meta',entry.surface+(entry.newer?' · '+entry.newer+' changed more recently':'')),el('p','',entry.detail)); const actions=el('div','item-actions'); if(entry.codexPath&&/\.[^/]+$/.test(entry.codexPath))actions.append(button('Open Codex file','manage-agent-file',entry.codexPath,'ghost')); if(entry.claudePath&&entry.claudePath!==entry.codexPath&&/\.[^/]+$/.test(entry.claudePath))actions.append(button('Open Claude file','manage-agent-file',entry.claudePath,'ghost')); if(entry.surface==='skills'&&entry.status==='conflict'){ actions.append(button('Use Codex version','resolve-agent-alignment',entry.id+'|codex','ghost'),button('Use Claude version','resolve-agent-alignment',entry.id+'|claude','ghost')); } if(actions.childElementCount)row.append(actions); alignment.append(row); });
    agents.content.append(alignment);
    const owners=[['codex','Codex'],['claude','Claude'],['vibecheck','VibeCheck']], tabs=el('div','tabs'), panel=el('div','content tab-panel');
    tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','Agent workspace files'); panel.setAttribute('role','tabpanel');
    const savedOwner=(vscode.getState()||{}).agentFileOwner, initialOwner=owners.some(([owner])=>owner===savedOwner)?savedOwner:'codex';
    const showOwner=owner=>{ const ownerFiles=s.agentFiles.filter(f=>f.owner===owner),groups=[]; kindOrder.forEach(kind=>{ const files=ownerFiles.filter(f=>f.kind===kind); if(!files.length)return; const group=el('div','capability-group'); group.append(el('div','capability-label',(kindLabels[kind]||kind)+' · '+files.filter(f=>f.exists).length+'/'+files.length+' present'),...files.map(agentFileItem)); groups.push(group); }); panel.replaceChildren(...groups); panel.setAttribute('aria-labelledby','agent-tab-'+owner); tabs.querySelectorAll('[role="tab"]').forEach(tab=>{ const selected=tab.dataset.owner===owner; tab.setAttribute('aria-selected',String(selected)); tab.tabIndex=selected?0:-1; }); vscode.setState({...vscode.getState(),agentFileOwner:owner}); };
    owners.forEach(([owner,label],index)=>{ const files=s.agentFiles.filter(f=>f.owner===owner), tab=el('button','tab',label+' ('+files.length+')'); tab.type='button'; tab.dataset.owner=owner; tab.dataset.focusKey='agent-tab:'+owner; tab.id='agent-tab-'+owner; tab.setAttribute('role','tab'); tab.setAttribute('aria-controls','agent-file-panel'); tab.onclick=()=>showOwner(owner); tab.onkeydown=event=>{ if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight') return; event.preventDefault(); const offset=event.key==='ArrowRight'?1:-1, next=owners[(index+offset+owners.length)%owners.length][0]; showOwner(next); tabs.querySelector('[data-owner="'+next+'"]').focus(); }; tabs.append(tab); });
    panel.id='agent-file-panel'; panel.setAttribute('aria-labelledby','agent-tab-'+initialOwner); agents.card.append(tabs,panel); showOwner(initialOwner);
    const adapter=el('div','item'); adapter.append(el('div','item-title','Local agent event adapters'),el('div','meta',s.agent.connectedAgents.length?s.agent.connectedAgents.join(', ')+' connected':'Optional lifecycle context; repository monitoring works without adapters.')); const aa=el('div','item-actions'); aa.append(button('Connect Codex','install-codex'),button('Connect Claude','install-claude'),button('Remove adapter','remove-adapter',undefined,'ghost')); adapter.append(aa); const agentFooter=el('div','content'); agentFooter.append(adapter); agents.card.append(agentFooter); pages.tools.append(agents.card);

    const evidence=section('Evidence & reporting','local','status:reporting',false);
    const summary=el('div','callout'); summary.append(el('strong','', 'Current evidence snapshot'),el('p','',(s.headSubject?s.headSubject+' · ':'')+s.verification.filter(v=>v.status==='passed').length+' checks passed · '+open.length+' findings open · updated '+new Date(s.lastUpdatedAt).toLocaleTimeString())); evidence.content.append(summary); const ea=el('div','actions'); ea.append(button('Create Markdown report','export'),button('Copy agent follow-up','copy-prompt'),button('View check report','check-output-menu',undefined,'ghost'),button('Open quality config','config',undefined,'ghost')); evidence.content.append(ea); pages.status.append(evidence.card);

    if(history.length){ const hist=section('Reviewed findings',history.length,'status:history',false); history.forEach(f=>{ const item=el('div','item'); item.append(el('div','item-title',f.title),el('div','meta',f.status+' · '+f.severity)); item.append(button('Reopen','reopen-finding',f.id,'ghost')); hist.content.append(item); }); pages.status.append(hist.card); }

    const localTools=section('Monitoring & local data','local','tools:local-data',false),row1=el('div','actions'); row1.append(button(s.paused?'Resume monitoring':'Pause monitoring',s.paused?'resume':'pause'),button('Refresh now','refresh'),button('Delete local data','delete',undefined,'ghost danger')); localTools.content.append(row1); pages.tools.append(localTools.card);
    Object.values(pages).forEach(page=>app.append(page)); showView(initialView);
    requestAnimationFrame(()=>{ if(focusedKey)document.querySelector('[data-focus-key="'+CSS.escape(focusedKey)+'"]')?.focus({preventScroll:true}); window.scrollTo(0,previousScroll); });
    app.append(el('div','footer','Local only · '+(s.headBranch||'detached HEAD')+' · '+s.baselineCommit.slice(0,12)));
  }
  window.addEventListener('message',event=>{ if(event.data.type==='state') render(event.data.payload); });
  setInterval(()=>{ document.querySelectorAll('[data-review-started]').forEach(node=>{ const elapsed=Math.max(0,Date.now()-Date.parse(node.dataset.reviewStarted)),seconds=Math.floor(elapsed/1000),minutes=Math.floor(seconds/60); node.textContent='Running · '+(minutes?minutes+'m ':'')+(seconds%60)+'s'; }); },1000);
  vscode.postMessage({action:'refresh'});
</script></body></html>`;
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function readModelRouting() {
  const configuration = vscode.workspace.getConfiguration("vibecheck", vscode.workspace.workspaceFolders?.[0]?.uri);
  return normalizeModelRouting({
    codexBalanced: configuration.get<string>(MODEL_ROUTING_SETTINGS.codexBalanced, DEFAULT_MODEL_ROUTING.codexBalanced),
    codexDeep: configuration.get<string>(MODEL_ROUTING_SETTINGS.codexDeep, DEFAULT_MODEL_ROUTING.codexDeep),
    claudeBalanced: configuration.get<string>(MODEL_ROUTING_SETTINGS.claudeBalanced, DEFAULT_MODEL_ROUTING.claudeBalanced),
    claudeDeep: configuration.get<string>(MODEL_ROUTING_SETTINGS.claudeDeep, DEFAULT_MODEL_ROUTING.claudeDeep),
  });
}
