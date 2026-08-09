# Control Center screenshots

`npm run screenshots` regenerates every image in [`docs/images/`](../images/) that the root
README embeds. It renders the real panel rather than photographing a running window, so the
captures stay consistent in width, theme, and content between runs.

## How it works

The Control Center is a webview: static HTML from
[`src/ui/control-center-view.ts`](../../src/ui/control-center-view.ts) that renders itself when
the extension posts a `state` message. The harness reuses that exact markup, CSS, and render
code, and substitutes only the two things a browser cannot provide:

- the `--vscode-*` theme tokens (VS Code "Dark Modern" values, in `capture.cjs`),
- the `acquireVsCodeApi()` bridge, seeded with the webview state that selects the active tab
  and decides which sections start expanded.

`fixtures.cjs` holds one deterministic repository state — fixed commits, timestamps, gate
results, findings, and a completed review — so reruns produce comparable images. It is sample
data, not a capture of anyone's repository.

Headless Chrome renders each tab twice: once with `--dump-dom` to read the content height the
page publishes into its `<title>`, then once at exactly that height. Sizing the window to the
content is what keeps every capture free of dead space below the panel.

## Requirements

Google Chrome, Chromium, or Microsoft Edge. Set `CHROME` to override the detected binary.
Run `npm run compile` first if `dist/` is stale; the harness loads the compiled view module.

## Options

```bash
npm run screenshots              # 560 CSS px wide, captured at 2x for retina displays
npm run screenshots -- --width 480
```

Width is the simulated sidebar width. Below roughly 500 px the evidence tiles wrap to two
columns and the panel's narrow-layout rules start to apply, which is worth checking when
changing panel CSS.

## Adding a capture

Append an entry to `CAPTURES` in `fixtures.cjs` with a `name`, output `file`, the
`webviewState` that selects the tab, and a payload. Then embed the new image in the root
README.
