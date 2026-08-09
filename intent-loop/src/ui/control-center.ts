import * as vscode from "vscode";

import { IntentLoopConfiguration } from "../domain/configuration";
import { categoryFor, calculateReadiness, missingRecommendedCategories } from "../domain/quality-gates";
import { ObservationSnapshot } from "../domain/observation-state";

type WebviewMessage = { action?: unknown; id?: unknown };

export class ControlCenterProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly getSnapshot: () => ObservationSnapshot,
    private readonly getConfiguration: () => IntentLoopConfiguration,
    private readonly getConfigurationError: () => string | undefined,
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
        }
      : snapshot;
    void this.view.webview.postMessage({ type: "state", payload });
  }

  private async handle(message: WebviewMessage): Promise<void> {
    if (typeof message.action !== "string") return;
    const id = typeof message.id === "string" ? message.id : undefined;
    const simpleCommands: Record<string, string> = {
      "select-plan": "intentLoop.selectPlan",
      "open-plan": "intentLoop.openPlan",
      refresh: "intentLoop.refresh",
      pause: "intentLoop.pause",
      resume: "intentLoop.start",
      "run-all": "intentLoop.runAllVerification",
      "check-output-menu": "intentLoop.showVerificationOutput",
      "copy-prompt": "intentLoop.copyPrompt",
      export: "intentLoop.createReport",
      config: "intentLoop.openConfig",
      "install-codex": "intentLoop.installCodexAdapter",
      "install-claude": "intentLoop.installClaudeAdapter",
      "remove-adapter": "intentLoop.uninstallAgentAdapter",
      delete: "intentLoop.deleteData",
      start: "intentLoop.start",
    };
    const command = simpleCommands[message.action];
    if (command) {
      await vscode.commands.executeCommand(command);
      return;
    }

    const snapshot = this.getSnapshot();
    if (snapshot.kind !== "ready" || !id) return;
    if (message.action === "manage-agent-file") {
      await vscode.commands.executeCommand("intentLoop.manageAgentFile", id);
      return;
    }
    const finding = snapshot.state.findings.find((item) => item.id === id);
    if (finding) {
      const findingCommands: Record<string, string> = {
        "inspect-finding": "intentLoop.inspectFinding",
        "accept-finding": "intentLoop.acceptFinding",
        "dismiss-finding": "intentLoop.dismissFinding",
        "reopen-finding": "intentLoop.reopenFinding",
        "prompt-finding": "intentLoop.copyPrompt",
      };
      const findingCommand = findingCommands[message.action];
      if (findingCommand) await vscode.commands.executeCommand(findingCommand, finding);
      return;
    }
    if (message.action === "run-check") await vscode.commands.executeCommand("intentLoop.runVerification", id);
    if (message.action === "check-output") await vscode.commands.executeCommand("intentLoop.showVerificationOutput", id);
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
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 14px; color: var(--vscode-foreground); font: var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    button { font: inherit; cursor: pointer; }
    .shell { display: grid; gap: 12px; max-width: 760px; margin: 0 auto; }
    .hero, .card { border: 1px solid var(--vscode-widget-border); border-radius: 8px; background: var(--vscode-sideBar-background); }
    .hero { padding: 14px; background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-button-background) 14%, transparent), transparent 65%); }
    .hero-top, .row, .section-head, .item-head { display: flex; align-items: center; gap: 8px; }
    .hero-top, .section-head, .item-head { justify-content: space-between; }
    h1 { font-size: 17px; margin: 0; letter-spacing: -.2px; }
    h2 { font-size: 13px; margin: 0; }
    p { margin: 5px 0 0; color: var(--vscode-descriptionForeground); }
    .badge { border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .ready { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 13%, transparent); }
    .blocked { color: var(--vscode-testing-iconFailed); background: color-mix(in srgb, var(--vscode-testing-iconFailed) 13%, transparent); }
    .incomplete { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 13%, transparent); }
    .neutral { color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); }
    .plan { margin-top: 12px; padding: 10px; border-radius: 6px; background: var(--vscode-textBlockQuote-background); }
    .plan strong { display:block; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); }
    .plan span { display:block; margin-top:3px; }
    .actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; margin-top: 10px; }
    .btn { min-height: 30px; padding: 5px 9px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.ghost { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-widget-border); }
    .btn.small { min-height: 25px; padding: 2px 7px; font-size: 11px; }
    .card { overflow: hidden; }
    .section-head { padding: 10px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    .section-head span { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .content { padding: 10px 12px; display:grid; gap:8px; }
    .tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid var(--vscode-widget-border); }
    .tab { flex:1; padding:8px 6px 7px; border:0; border-bottom:2px solid transparent; color:var(--vscode-descriptionForeground); background:transparent; }
    .tab:hover { color:var(--vscode-foreground); background:var(--vscode-list-hoverBackground); }
    .tab[aria-selected="true"] { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder); }
    .tab-panel { padding-top:2px; }
    .item { padding: 9px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; }
    .item-title { font-weight: 600; overflow-wrap:anywhere; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; }
    .item-actions { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
    .dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--vscode-descriptionForeground); }
    .dot.passed { background:var(--vscode-testing-iconPassed); } .dot.failed { background:var(--vscode-testing-iconFailed); }
    .dot.stale, .dot.running { background:var(--vscode-editorWarning-foreground); }
    .empty { text-align:center; padding:12px; color:var(--vscode-descriptionForeground); }
    .callout { padding:9px; border-radius:6px; background:var(--vscode-textBlockQuote-background); color:var(--vscode-descriptionForeground); }
    .callout strong { color:var(--vscode-foreground); }
    .reason { margin:3px 0; }
    details { border-top: 1px solid var(--vscode-widget-border); }
    summary { padding:10px 12px; cursor:pointer; font-weight:600; }
    details .content { padding-top:0; }
    .danger { color:var(--vscode-errorForeground)!important; }
    .footer { text-align:center; font-size:11px; color:var(--vscode-descriptionForeground); padding:4px; }
    @media (max-width: 260px) { .actions { grid-template-columns:1fr; } }
  </style>
</head>
<body><main id="app" class="shell"><div class="empty">Loading local workspace state…</div></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const send = (action,id) => vscode.postMessage({action,id});
  const el = (tag, cls, text) => { const node=document.createElement(tag); if(cls) node.className=cls; if(text!==undefined) node.textContent=text; return node; };
  const button = (label,action,id,kind='secondary') => { const node=el('button','btn small '+kind,label); node.onclick=()=>send(action,id); return node; };
  const section = (title,count) => { const card=el('section','card'); const head=el('div','section-head'); head.append(el('h2','',title),el('span','',String(count))); const content=el('div','content'); card.append(head,content); return {card,content}; };
  const agentFileItem = f => { const item=el('div','item'),head=el('div','item-head'),owner=f.owner==='intent-loop'?'vibecheck':f.owner; head.append(el('span','item-title',f.title),el('span','badge '+(f.exists?'ready':'neutral'),f.exists?'present':'optional')); item.append(head,el('div','meta',owner+' · '+f.path+(f.localOnly?' · local only':'')),el('p','',f.description)); const a=el('div','item-actions'); a.append(button(f.exists?'Open':'Create','manage-agent-file',f.path,f.exists?'secondary':'ghost')); item.append(a); return item; };
  function render(data) {
    app.replaceChildren();
    if (data.kind !== 'ready') { const box=el('section','hero'); box.append(el('h1','', 'VibeCheck'),el('p','',data.reason)); box.append(button('Start observing','start',undefined,'primary')); app.append(box); return; }
    const s=data.state, open=s.findings.filter(f=>f.status==='open'), history=s.findings.filter(f=>f.status!=='open');
    const hero=el('section','hero'), top=el('div','hero-top');
    top.append(el('h1','', 'Engineering confidence'),el('span','badge '+data.readiness.status,data.readiness.label)); hero.append(top);
    hero.append(el('p','',s.changedFiles.length+' uncommitted file '+(s.changedFiles.length===1?'change':'changes')+' monitored against '+(s.headBranch||'current HEAD')+'. Use VS Code Source Control for files and diffs.'));
    const reasons=el('div',''); data.readiness.reasons.forEach(r=>reasons.append(el('p','reason','• '+r))); hero.append(reasons);
    const primary=el('div','actions'); primary.append(button('Run all checks','run-all',undefined,'primary'),button('Create evidence report','export',undefined,'primary'),button('Copy agent follow-up','copy-prompt'),button('Refresh confidence','refresh')); hero.append(primary); app.append(hero);

    const gates=section('Quality gates',s.verification.length);
    if(data.configurationError) gates.content.append(el('div','callout danger','Configuration error: '+data.configurationError));
    if(data.missingGates.length) { const c=el('div','callout'); c.append(el('strong','', 'Recommended setup missing'),el('p','',data.missingGates.join(', ')+' — add these checks so “ready” means more.')); c.append(button('Configure gates','config')); gates.content.append(c); }
    if(!s.verification.length) gates.content.append(el('div','empty','No checks configured yet. Add tests, coverage, and security checks.'));
    s.verification.forEach(v=>{ const item=el('div','item'), head=el('div','item-head'), title=el('div','row'); title.append(el('i','dot '+v.status),el('span','item-title',v.name)); head.append(title,el('span','badge '+(v.status==='passed'?'ready':v.status==='failed'?'blocked':'incomplete'),v.status)); item.append(head,el('div','meta',(data.categories[v.name]||'other')+(v.required===false?' · optional':' · required'))); const a=el('div','item-actions'); a.append(button(v.status==='running'?'Running…':'Run','run-check',v.name),button('Output','check-output',v.name,'ghost')); item.append(a); gates.content.append(item); });
    gates.content.append(button('Open quality-gate configuration','config',undefined,'ghost')); app.append(gates.card);

    const attention=section('Needs attention',open.length);
    if(!open.length) attention.content.append(el('div','empty','No unresolved findings.'));
    open.forEach(f=>{ const item=el('div','item'); const head=el('div','item-head'); head.append(el('span','item-title',f.title),el('span','badge '+(f.severity==='high'?'blocked':'incomplete'),f.severity)); item.append(head,el('div','meta',f.basis+' · '+f.explanation)); const a=el('div','item-actions'); a.append(button('Inspect','inspect-finding',f.id),button('Ask agent','prompt-finding',f.id),button('Intentional','accept-finding',f.id,'ghost'),button('Dismiss','dismiss-finding',f.id,'ghost')); item.append(a); attention.content.append(item); }); app.append(attention.card);

    const agents=section('Agent workspace',s.agentFiles.filter(f=>f.exists).length+' configured');
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
    const owners=[['codex','Codex'],['claude','Claude'],['intent-loop','VibeCheck']], tabs=el('div','tabs'), panel=el('div','content tab-panel');
    tabs.setAttribute('role','tablist'); tabs.setAttribute('aria-label','Agent workspace files'); panel.setAttribute('role','tabpanel');
    const savedOwner=(vscode.getState()||{}).agentFileOwner, initialOwner=owners.some(([owner])=>owner===savedOwner)?savedOwner:'codex';
    const showOwner=owner=>{ panel.replaceChildren(...s.agentFiles.filter(f=>f.owner===owner).map(agentFileItem)); panel.setAttribute('aria-labelledby','agent-tab-'+owner); tabs.querySelectorAll('[role="tab"]').forEach(tab=>{ const selected=tab.dataset.owner===owner; tab.setAttribute('aria-selected',String(selected)); tab.tabIndex=selected?0:-1; }); vscode.setState({...vscode.getState(),agentFileOwner:owner}); };
    owners.forEach(([owner,label],index)=>{ const files=s.agentFiles.filter(f=>f.owner===owner), tab=el('button','tab',label+' ('+files.length+')'); tab.type='button'; tab.dataset.owner=owner; tab.id='agent-tab-'+owner; tab.setAttribute('role','tab'); tab.setAttribute('aria-controls','agent-file-panel'); tab.onclick=()=>showOwner(owner); tab.onkeydown=event=>{ if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight') return; event.preventDefault(); const offset=event.key==='ArrowRight'?1:-1, next=owners[(index+offset+owners.length)%owners.length][0]; showOwner(next); tabs.querySelector('[data-owner="'+next+'"]').focus(); }; tabs.append(tab); });
    panel.id='agent-file-panel'; panel.setAttribute('aria-labelledby','agent-tab-'+initialOwner); agents.card.append(tabs,panel); showOwner(initialOwner);
    const adapter=el('div','item'); adapter.append(el('div','item-title','Local agent event adapters'),el('div','meta',s.agent.connectedAgents.length?s.agent.connectedAgents.join(', ')+' connected':'Optional lifecycle context; repository monitoring works without adapters.')); const aa=el('div','item-actions'); aa.append(button('Connect Codex','install-codex'),button('Connect Claude','install-claude'),button('Remove adapter','remove-adapter',undefined,'ghost')); adapter.append(aa); const agentFooter=el('div','content'); agentFooter.append(adapter); agents.card.append(agentFooter); app.append(agents.card);

    const evidence=section('Evidence & reporting','local');
    const summary=el('div','callout'); summary.append(el('strong','', 'Current evidence snapshot'),el('p','',(s.headSubject?s.headSubject+' · ':'')+s.verification.filter(v=>v.status==='passed').length+' checks passed · '+open.length+' findings open · updated '+new Date(s.lastUpdatedAt).toLocaleTimeString())); evidence.content.append(summary); const ea=el('div','actions'); ea.append(button('Create Markdown report','export'),button('Copy agent follow-up','copy-prompt'),button('Show check output','check-output-menu',undefined,'ghost'),button('Open quality config','config',undefined,'ghost')); evidence.content.append(ea); app.append(evidence.card);

    if(history.length){ const hist=section('Reviewed findings',history.length); history.forEach(f=>{ const item=el('div','item'); item.append(el('div','item-title',f.title),el('div','meta',f.status+' · '+f.severity)); item.append(button('Reopen','reopen-finding',f.id,'ghost')); hist.content.append(item); }); app.append(hist.card); }

    const tools=el('section','card'), details=el('details'); details.append(el('summary','', 'Monitoring & local data')); const tc=el('div','content'), row1=el('div','actions'); row1.append(button(s.paused?'Resume monitoring':'Pause monitoring',s.paused?'resume':'pause'),button('Refresh now','refresh'),button('Delete local data','delete',undefined,'ghost danger')); tc.append(row1); details.append(tc); tools.append(details); app.append(tools);
    app.append(el('div','footer','Local only · '+(s.headBranch||'detached HEAD')+' · '+s.baselineCommit.slice(0,12)));
  }
  window.addEventListener('message',event=>{ if(event.data.type==='state') render(event.data.payload); });
  vscode.postMessage({action:'refresh'});
</script></body></html>`;
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
