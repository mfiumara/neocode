# Vite WebSocket proxy EPIPE — rebased raw validation evidence

## Identity boundary

The **tested rebased implementation identity** is:

- commit: `51d4ed6bc39f623d13ef05fb0ff6cb0f93cce50d`
- tree: `de77e9a9bc613857418805c4daa332e14d5adf84`
- current main/base/merge-base: `5de5fbfa10b17cf165bf157bc0281c8183fc197b`
- canonical binary diff SHA-256: `d708b187e176057f1820eaf9be37fa81176f4dea1e0bf115f764b02b6ada080a`

The commit containing this document and refreshed captures is an
**evidence-only aggregate follow-up**. Its commit, tree, and aggregate diff
necessarily differ because the evidence files themselves change. Reviewers
must use the containing commit or final handoff for that aggregate identity and
must not confuse it with the tested implementation identity above. The
follow-up changes no product source or executable test behavior.

## Checkout-portable committed captures

Each raw file records UTC start/end timestamps, the actual worker checkout for
traceability, the portable location `<assigned-checkout>`, exact shell
invocation, complete merged stdout/stderr, and exit status. A reviewer may read
them from any checkout without relying on `/tmp` or another external artifact.

| Capture | SHA-256 |
| --- | --- |
| [`npm-test.raw.txt`](vite-websocket-proxy-epipe/npm-test.raw.txt) | `8e6d45ffc98c5b411a241440362272a5fde168b6bf97c18daaf58800feb761a7` |
| [`npm-run-check.raw.txt`](vite-websocket-proxy-epipe/npm-run-check.raw.txt) | `88b5f84750966732eda8cb69fcf9b92c543582ba732e7166e9d480fc329dc724` |
| [`npm-run-build.raw.txt`](vite-websocket-proxy-epipe/npm-run-build.raw.txt) | `4fa013f9a50eb3ab073ddbb05db0c5babccff83dd49ef9957c506277a3f2abf9` |
| [`implementation-git-packet.raw.txt`](vite-websocket-proxy-epipe/implementation-git-packet.raw.txt) | `cf458c019ca9b97bac814d55ea17a788e9c00f15544dcd725d6d08ad375d03ea` |

The command captures visibly include:

```text
$ cd <assigned-checkout>
$ npm test
$ npm run check
$ npm run build
```

All exited 0. Literal `npm test` reports server **115 passed**, proxy
integration 1 passed, other web tests **64 passed**, and Playwright **3 passed**.
The build has only the existing Vite bundle-size advisory.

## Exact rebased Git packet

The committed
[`implementation-git-packet.raw.txt`](vite-websocket-proxy-epipe/implementation-git-packet.raw.txt)
contains exact commands and output for implementation HEAD/tree, current main,
merge-base, author/committer, name-status, canonical binary diff, separate
candidate/root porcelain, and `git diff --check main...HEAD`. Both porcelain
outputs are empty and diff-check exits 0.

Rebased implementation name-status:

```text
M apps/server/src/index.ts
M apps/web/e2e/image-paste.spec.ts
A apps/web/e2e/vite-harness.ts
A apps/web/e2e/websocket-lifecycle.spec.ts
M apps/web/package.json
M apps/web/playwright.config.ts
M apps/web/src/App.tsx
M apps/web/src/image-paste.browser.test.tsx
A apps/web/src/vite-websocket-proxy.integration.ts
A docs/validation/vite-websocket-proxy-epipe.md
A docs/validation/vite-websocket-proxy-epipe/implementation-git-packet.raw.txt
A docs/validation/vite-websocket-proxy-epipe/npm-run-build.raw.txt
A docs/validation/vite-websocket-proxy-epipe/npm-run-check.raw.txt
A docs/validation/vite-websocket-proxy-epipe/npm-test.raw.txt
```

## Superseded identities

All evidence tied to old base `e825358a…`, tested implementation `7b6331a…`,
tree `8719dda…`, implementation diff `7d921685…`, evidence aggregate
`b592ea1…`, or aggregate diff `09ff5f1a…` is **obsolete after the semantic
rebase**. Earlier still, `b9e28bc4…`, `7f8ca780…`, and server count 89 were
already obsolete. None is presented as current or final evidence.

## Semantic rebase reconciliation

New main added context/compaction browser coverage and additional status roles.
The dynamic-port image fixture now navigates that new test to its actual
kernel-assigned Vite URL, and WebSocket lifecycle assertions select the local
connection status without colliding with newer context/compaction status
regions. The accepted WebSocket fix, genuine-error observability, durable
prompt/reconnect semantics, and kernel-assigned/owned-cleanup behavior remain
unchanged.

React development StrictMode could discard a CONNECTING WebSocket while Vite
finished the backend upgrade and proxied an immediate snapshot, producing
paired EPIPE logs. The client defers creation and lets post-timer CONNECTING
sockets finish opening before sending a close handshake on the next task, with
a bounded fallback. Synthetic reset coverage reproduces abnormal EPIPE. Real
Chromium/Vite coverage proves CONNECTING unmount, reload, Vite full-reload/HMR
fallback, tab close, and reconnect are quiet. Backend restart and genuine
`ECONNREFUSED` remain observable.

## Residual risks

- A handshake still CONNECTING after five seconds is force-released as an
  abnormal, observable transport failure.
- Synthetic EPIPE reproduction uses bounded repeated resets because kernel
  scheduling controls the exact downstream-write timeslice.
- Brief backend-restart `ECONNREFUSED` remains visible by design; normal
  lifecycle EPIPE noise is what is eliminated.
