"use strict";

/**
 * Renders the Control Center webview outside the extension host and captures one PNG per tab.
 *
 * The panel is plain HTML driven by a `state` message, so the real markup, CSS, and render
 * code from `src/ui/control-center-view.ts` are used here. Only the two host-provided pieces
 * are substituted: the `--vscode-*` theme tokens and the `acquireVsCodeApi()` bridge.
 *
 * Usage: npm run screenshots [-- --width 560]
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CAPTURES } = require("./fixtures.cjs");
const { controlCenterHtml } = require("../../dist/ui/control-center-view.js");

const OUTPUT_DIRECTORY = path.join(__dirname, "..", "images");
const DEFAULT_WIDTH = 560;
const DEVICE_SCALE_FACTOR = 2;

/** VS Code "Dark Modern" token values for every `--vscode-*` variable the panel reads. */
const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-sideBar-background: #181818;
  --vscode-textCodeBlock-background: #2c2c2c;
  --vscode-focusBorder: #0078d4;
  --vscode-errorForeground: #f85149;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-testing-iconPassed: #73c991;
  --vscode-testing-iconFailed: #f14c4c;
  --vscode-progressBar-background: #0078d4;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-border: transparent;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-symbolIcon-functionForeground: #b180d7;
  --vscode-symbolIcon-methodForeground: #4ec9b0;
}
`;

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function resolveChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "No Chrome/Chromium binary found. Install Google Chrome or set CHROME to an executable path.",
    );
  }
  return found;
}

function parseWidth(argv) {
  const index = argv.indexOf("--width");
  if (index === -1) return DEFAULT_WIDTH;
  const width = Number(argv[index + 1]);
  if (!Number.isInteger(width) || width < 240 || width > 1200) {
    throw new Error(`--width must be an integer between 240 and 1200, received "${argv[index + 1]}"`);
  }
  return width;
}

/** Wraps the production webview markup with the host pieces a browser does not provide. */
function buildPage(capture) {
  const html = controlCenterHtml("'self'");
  const nonce = html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
  if (!nonce) throw new Error("Could not read the content-security-policy nonce from the webview markup.");

  const shim = `<style>${THEME}</style>
<script nonce="${nonce}">
  const __state = ${JSON.stringify(capture.webviewState)};
  window.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => __state,
    setState: (value) => Object.assign(__state, value),
  });
  document.body.classList.add('vscode-reduce-motion');
</script>
`;

  // The height is published synchronously so it is always present in the `--dump-dom` output,
  // which Chrome emits at the load event.
  const dispatch = `<script nonce="${nonce}">
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', payload: ${JSON.stringify(capture.payload)} } }));
  document.title = String(document.documentElement.scrollHeight);
</script>
`;

  return html
    .replace("<script nonce=", `${shim}<script nonce=`)
    .replace("</script></body></html>", `</script>${dispatch}</body></html>`);
}

const RUN_TIMEOUT_MS = 30_000;

/**
 * Headless Chrome writes its artifact quickly but does not always exit on macOS, so the
 * process is stopped as soon as `isComplete` sees the output it was launched to produce.
 */
async function runChrome(chrome, userDataDirectory, extraArguments, pageUrl, isComplete) {
  const child = spawn(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--disable-lcd-text",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-crash-reporter",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--lang=en-US",
      `--force-device-scale-factor=${DEVICE_SCALE_FACTOR}`,
      `--user-data-dir=${userDataDirectory}`,
      ...extraArguments,
      pageUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: "UTC" } },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let exited = false;
  child.once("exit", () => { exited = true; });

  while (!exited && Date.now() < deadline && !isComplete(stdout)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!exited) child.kill("SIGKILL");

  if (!isComplete(stdout)) {
    throw new Error(
      `Chrome did not produce its output within ${RUN_TIMEOUT_MS / 1000}s: ${extraArguments.join(" ")}\n` +
      `stdout (${stdout.length} bytes): ${stdout.slice(0, 400)}\n` +
      `stderr: ${stderr.slice(-800)}`,
    );
  }
  return stdout;
}

/**
 * Two passes: the first reads the rendered content height so the second can size the window
 * to it exactly, which keeps every capture free of dead space below the content.
 */
/** True once the PNG exists and its size has stopped growing, so it is never read mid-write. */
function settledFile(target) {
  let previousSize = -1;
  return () => {
    if (!fs.existsSync(target)) return false;
    const size = fs.statSync(target).size;
    const settled = size > 0 && size === previousSize;
    previousSize = size;
    return settled;
  };
}

async function capture(chrome, workingDirectory, item, width) {
  const pageFile = path.join(workingDirectory, `${item.name}.html`);
  const userDataDirectory = path.join(workingDirectory, "chrome-profile");
  fs.writeFileSync(pageFile, buildPage(item));
  const pageUrl = `file://${pageFile}`;

  const dom = await runChrome(
    chrome,
    userDataDirectory,
    ["--dump-dom", `--window-size=${width},200`],
    pageUrl,
    (stdout) => /<title>\d+<\/title>/.test(stdout) && stdout.includes("</html>"),
  );
  const height = Number(dom.match(/<title>(\d+)<\/title>/)?.[1]);
  if (!Number.isInteger(height) || height < 100) {
    throw new Error(`Could not measure the rendered height for the ${item.name} tab.`);
  }

  const target = path.join(OUTPUT_DIRECTORY, item.file);
  fs.rmSync(target, { force: true });
  await runChrome(
    chrome,
    userDataDirectory,
    [`--window-size=${width},${height}`, `--screenshot=${target}`],
    pageUrl,
    settledFile(target),
  );
  return { target, width: width * DEVICE_SCALE_FACTOR, height: height * DEVICE_SCALE_FACTOR };
}

async function main() {
  const width = parseWidth(process.argv.slice(2));
  const chrome = resolveChrome();
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vibecheck-screenshots-"));
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

  try {
    for (const item of CAPTURES) {
      const result = await capture(chrome, workingDirectory, item, width);
      console.log(`${item.name.padEnd(8)} ${result.width}x${result.height}  ${path.relative(process.cwd(), result.target)}`);
    }
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildPage };
