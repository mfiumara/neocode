import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

test("the real browser keeps the transcript endpoint above a resized composer", { skip: !chrome }, () => {
  const directory = mkdtempSync(join(tmpdir(), "neocode-transcript-layout-"));
  try {
    const stylesheet = pathToFileURL(resolve("src/styles.css")).href;
    const repeatedRows = Array.from({ length: 14 }, (_, index) =>
      `<article class="message"><div class="message-body">Earlier transcript row ${index}</div></article>`).join("");
    const longCode = "const_unbroken_streaming_identifier_".repeat(35);
    const chips = Array.from({ length: 18 }, (_, index) => `<button>context chip ${index}</button>`).join("");
    const file = join(directory, "layout.html");
    writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}"></head><body>
      <main class="app-shell"><header class="topbar">neocode</header><section class="workspace-grid">
        <aside class="rail"></aside><section class="main-panel" id="panel"><header class="view-header">Coordinator</header>
        <div class="transcript"><div class="transcript-viewport" id="viewport" style="width:100%;height:100%;overflow-y:auto">
          <div class="transcript-content">${repeatedRows}<article class="message" id="last-row"><div class="message-body"><div class="message-markdown"><pre id="code"><code>${longCode}</code></pre></div></div></article><div class="working-row" id="working-row"><span></span><span class="working-description">Coordinator is working</span></div><div class="transcript-end" id="end"></div></div>
        </div></div><div class="composer" id="composer"><div class="context-chips">${chips}</div><textarea rows="2"></textarea><div class="composer-actions">composer actions</div></div>
        </section></section></main><output id="result"></output>
      <script>
        const viewport = document.getElementById("viewport");
        const composer = document.getElementById("composer");
        const panel = document.getElementById("panel");
        const last = document.getElementById("last-row");
        const working = document.getElementById("working-row");
        const end = document.getElementById("end");
        const code = document.getElementById("code");
        viewport.scrollTop = viewport.scrollHeight;
        const viewportRect = viewport.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const result = document.getElementById("result");
        result.dataset.scrollable = String(viewport.scrollHeight > viewport.clientHeight);
        result.dataset.separate = String(viewportRect.bottom <= composerRect.top + 0.5);
        result.dataset.endpointVisible = String(end.getBoundingClientRect().bottom <= viewportRect.bottom + 0.5);
        result.dataset.finalRowsAboveEnd = String(last.getBoundingClientRect().bottom <= end.getBoundingClientRect().top && working.getBoundingClientRect().bottom <= end.getBoundingClientRect().top);
        result.dataset.codeContained = String(code.getBoundingClientRect().right <= last.getBoundingClientRect().right + 0.5 && code.scrollWidth > code.clientWidth);
        result.dataset.panelContained = String(panel.scrollWidth <= panel.clientWidth);
      </script></body></html>`);

    const run = spawnSync(chrome!, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
      "--virtual-time-budget=500", "--window-size=700,500", "--dump-dom", pathToFileURL(file).href,
    ], { encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    const output = run.stdout.match(/<output id="result"([^>]*)>/)?.[1] || "";
    for (const behavior of ["scrollable", "separate", "endpoint-visible", "final-rows-above-end", "code-contained", "panel-contained"]) {
      assert.match(output, new RegExp(`data-${behavior}="true"`), `${behavior} failed: ${output}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
