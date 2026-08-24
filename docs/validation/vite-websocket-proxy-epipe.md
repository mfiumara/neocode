# Vite WebSocket proxy EPIPE — raw validation evidence

## Identity boundary

The **tested implementation identity** is:

- commit: `7b6331a79866eb621f926b36ba1b12f5ee140cc8`
- tree: `8719dda70b27f0fbfc03a4b9bfb6110da8fc0109`
- current main/base/merge-base: `e825358a044796781db3da13dab95e47a6345427`
- canonical binary diff SHA-256: `7d9216856d0910d07a7fbce674d690c99e7fb8072a51a36a8484fcb263d29de4`

The commit containing this replacement document and the raw captures is an
**evidence-only aggregate follow-up**. It necessarily has a different commit,
tree, and aggregate diff because the evidence itself is committed. Reviewers
must obtain that aggregate identity from the containing commit and the final
handoff; it must not be confused with the tested implementation identity above.
No product source or test behavior changes in the evidence-only follow-up.

## Committed raw captures

The following files contain UTC start/end timestamps, the exact working
directory, a visibly literal shell invocation, complete merged stdout/stderr,
and the exit status:

| Capture | SHA-256 |
| --- | --- |
| [`npm-test.raw.txt`](vite-websocket-proxy-epipe/npm-test.raw.txt) | `4df5bcc1e2fce5cd00342a485aefbcd662b3714fe1218b94e28a0e7f83d0c835` |
| [`npm-run-check.raw.txt`](vite-websocket-proxy-epipe/npm-run-check.raw.txt) | `38b3bc6ddbc57685b828aa68c71bc4ac4710014c90b0b3bec4366d8afd878f59` |
| [`npm-run-build.raw.txt`](vite-websocket-proxy-epipe/npm-run-build.raw.txt) | `709dbf18f2dd10696748dd0047b10272f0a96266ee3861d63384a12880a401ed` |
| [`implementation-git-packet.raw.txt`](vite-websocket-proxy-epipe/implementation-git-packet.raw.txt) | `c6c47b6cbc3b20502dc7fa397b1d84384c0824698d7dd58dbaa3403f6021f159` |

The captures visibly include:

```text
$ npm test
$ npm run check
$ npm run build
```

All three exited 0. The literal `npm test` capture reports server **90 passed**,
proxy integration 1 passed, other web tests 61 passed, and Playwright 2 passed.
The build contains only the existing Vite bundle-size advisory. The check
capture includes successful TypeScript checks and a clean Git packet.

## Reviewer-verifiable implementation Git packet

The complete raw packet is committed in
[`implementation-git-packet.raw.txt`](vite-websocket-proxy-epipe/implementation-git-packet.raw.txt).
It includes exact invocations and outputs for implementation HEAD and tree,
main, merge-base, author/committer, name-status, canonical binary diff hash,
separate candidate and root porcelain, and `git diff --check main...HEAD`.
Both porcelain outputs are empty and diff-check exits 0.

Implementation name-status:

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
```

## Corrections to obsolete evidence

The replaced prose previously cited source commit `b9e28bc4…`, diff
`7f8ca780…`, server total 89, and a changed-path list that omitted its own
validation artifact. Those values are **obsolete and are not final evidence**.
The tested implementation values and complete path list above supersede them.
The final evidence-only aggregate identity is reported separately in the final
handoff rather than misrepresented as the tested implementation.

## Diagnosis and accepted behavior

React development StrictMode could synchronously create and discard a
CONNECTING WebSocket. Vite could then finish the backend upgrade and proxy the
immediate snapshot after the downstream disappeared, producing paired EPIPE
logs. The client defers initial creation and lets post-timer CONNECTING sockets
finish opening before sending a close handshake on the following task, with a
bounded fallback for a handshake that never settles.

Synthetic raw-TCP reset coverage reproduces the paired EPIPE without treating
that fault as normal browser behavior. Real Chromium/Vite coverage proves
CONNECTING unmount, reload, Vite full-reload/HMR fallback, tab close, and
reconnect are quiet. Backend restart and genuine `ECONNREFUSED` remain
observable. Durable queued-prompt IDs, acknowledgment, settlement
reconciliation, and deduplication remain intact. All E2E HTTP, Vite, WebSocket,
and initial backend listeners use kernel-assigned ports and clean up only owned
handles or child groups.

## Residual risks

- A handshake still CONNECTING after five seconds is force-released as an
  abnormal, observable transport failure.
- Synthetic EPIPE reproduction uses bounded repeated resets because kernel
  scheduling controls the exact downstream-write timeslice.
- The brief `ECONNREFUSED` during intentional backend restart remains visible by
  design; normal lifecycle EPIPE noise is what is eliminated.
