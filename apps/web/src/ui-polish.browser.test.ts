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

test("sidebar, palette, composer, and terminal surfaces stay aligned at a narrow width", { skip: !chrome }, () => {
  const directory = mkdtempSync(join(tmpdir(), "neocode-ui-polish-"));
  try {
    const stylesheet = pathToFileURL(resolve("src/styles.css")).href;
    const file = join(directory, "polish.html");
    const output = "npm test\\n" + "an_unbroken_terminal_output_column_".repeat(30);
    writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}"></head><body style="width:680px;height:700px;padding:12px;overflow:auto">
      <aside class="rail" style="display:block;width:220px">
        <button id="idle" class="job-row"><span class="status-marker"><span class="job-glyph">!</span></span><span class="sidebar-row-copy"><strong>A long worker title remains aligned</strong><small>Needs attention</small></span></button>
        <button id="active" class="job-row active"><span class="status-marker"><span class="job-glyph">!</span></span><span class="sidebar-row-copy"><strong>A long worker title remains aligned</strong><small>Needs attention</small></span></button>
      </aside>
      <div cmdk-list style="width:310px;padding:4px"><div id="palette" cmdk-item data-selected="true" class="palette-entry"><span class="palette-entry-title">A very long command palette title that wraps over multiple lines</span><small class="palette-entry-meta">Actionable · Needs attention · /a/very/long/path</small></div></div>
      <div id="composer" class="composer" style="width:640px;margin-top:10px"><div class="attachment-previews"><div class="attachment-preview"><a></a><button id="close">×</button></div></div><textarea id="prompt"></textarea><div class="composer-actions"><div class="runtime-controls"><button class="runtime-chip">mode <strong>build</strong></button><button class="runtime-chip">effort <strong>high</strong></button></div><div class="action-buttons"><button>Attach images</button><button>Send</button></div></div></div>
      <article class="message tool" style="width:400px"><div id="terminal" class="message-body"><div class="message-markdown"><p>${output}</p></div></div></article>
      <output id="result"></output><script>
        const idle = document.getElementById("idle"), active = document.getElementById("active");
        const marker = active.querySelector(".status-marker"), copy = active.querySelector(".sidebar-row-copy");
        const palette = document.getElementById("palette"), title = palette.querySelector(".palette-entry-title"), meta = palette.querySelector(".palette-entry-meta");
        const composer = document.getElementById("composer"), prompt = document.getElementById("prompt"), close = document.getElementById("close");
        const actions = composer.querySelector(".composer-actions"), runtime = composer.querySelector(".runtime-controls"), buttons = composer.querySelector(".action-buttons");
        prompt.focus();
        const terminal = document.getElementById("terminal"), result = document.getElementById("result");
        const ir = idle.getBoundingClientRect(), ar = active.getBoundingClientRect(), mr = marker.getBoundingClientRect(), cr = copy.getBoundingClientRect(), pr = palette.getBoundingClientRect();
        result.dataset.rowsSame = String(ir.width === ar.width && ir.height === ar.height && getComputedStyle(active).borderRadius === getComputedStyle(idle).borderRadius);
        result.dataset.markerClear = String(mr.width >= 24 && mr.right <= cr.left + 0.5 && cr.right <= ar.right + 0.5);
        result.dataset.paletteContained = String(title.getBoundingClientRect().left >= pr.left && title.getBoundingClientRect().right <= pr.right && meta.getBoundingClientRect().right <= pr.right && palette.scrollWidth <= palette.clientWidth);
        result.dataset.paletteWrapped = String(palette.getBoundingClientRect().height > 30);
        result.dataset.focusContained = String(getComputedStyle(composer).boxShadow !== "none" && getComputedStyle(prompt).boxShadow === "none");
        result.dataset.closeTarget = String(close.getBoundingClientRect().width >= 24 && close.getBoundingClientRect().height >= 24);
        result.dataset.controlsContained = String(actions.scrollWidth <= actions.clientWidth && runtime.getBoundingClientRect().right <= composer.getBoundingClientRect().right && buttons.getBoundingClientRect().right <= composer.getBoundingClientRect().right);
        result.dataset.terminalCompact = String(parseFloat(getComputedStyle(terminal).fontSize) <= 10 && terminal.scrollWidth > terminal.clientWidth && getComputedStyle(terminal.querySelector(".message-markdown")).whiteSpace === "pre");
      </script></body></html>`);

    const run = spawnSync(chrome!, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
      "--virtual-time-budget=500", "--window-size=700,700", "--dump-dom", pathToFileURL(file).href,
    ], { encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    const result = run.stdout.match(/<output id="result"([^>]*)>/)?.[1] || "";
    for (const behavior of ["rows-same", "marker-clear", "palette-contained", "palette-wrapped", "focus-contained", "close-target", "controls-contained", "terminal-compact"]) {
      assert.match(result, new RegExp(`data-${behavior}="true"`), `${behavior} failed: ${result}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
