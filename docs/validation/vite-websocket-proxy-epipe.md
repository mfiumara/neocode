# Vite WebSocket proxy EPIPE validation

Validated source commit: `b9e28bc4c20bac9e887faff4c3aa4a35aba388e2`

Validated against current main/base: `e825358a044796781db3da13dab95e47a6345427`

Canonical binary diff SHA-256 at validation: `7f8ca780ab00691b38de5dbe0d54faf197a0dbec5a30c8b1faadf4c54da5f46b`

## Literal worker commands and results

These commands were invoked literally in the assigned worker checkout after the
source commit above, not through a coordinator alias:

- `npm test` — exit 0. Server: 89 passed. Web proxy integration: 1 passed.
  Other web tests: 61 passed. Playwright: 2 passed. The intentional backend
  restart exposed one expected `ECONNREFUSED`; no EPIPE occurred in normal
  browser lifecycle coverage.
- `npm run check` — exit 0. Git packet validation and both workspace TypeScript
  checks passed with a clean candidate.
- `npm run build` — exit 0. Server and web builds passed. Vite emitted only the
  existing bundle-size advisory.
- `git diff --check main...HEAD` — exit 0.

Command logs from the worker run were captured as
`/tmp/neocode-npm-test-kernel-ports.log`,
`/tmp/neocode-check-kernel-ports.log`, and
`/tmp/neocode-build-kernel-ports.log`; this committed summary preserves their
review-relevant results after the ephemeral worker environment is removed.

## Git packet at validation

Author and committer: `Mattia Fiumara <mattia@schematik.io>`

Changed paths:

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
```

Both the candidate worktree and root checkout were clean. Root/main was
`e825358a044796781db3da13dab95e47a6345427`; the worker did not mutate it.
A static audit found no `14317`, `14318`, E2E port environment fallback, fixed
E2E listen port, or Playwright `baseURL` fallback.

## Diagnosis and coverage

React development StrictMode synchronously created and discarded a CONNECTING
WebSocket. Vite could complete the backend upgrade and proxy the immediate
snapshot after the downstream was gone, yielding paired `write EPIPE` logs.
The client now defers initial creation and disposes a post-timer CONNECTING
socket by waiting for `open`, then sending a close handshake on the next task.
A bounded fallback releases a handshake that never settles.

A synthetic raw-TCP reset separately reproduces the exact paired Vite EPIPE and
proves that genuine transport failures remain logged. Real Chromium coverage
proves delayed CONNECTING unmount, reload, Vite full-reload/HMR fallback, tab
close, and reconnect are quiet. Backend restart and genuine `ECONNREFUSED`
remain observable. Existing durable prompt IDs, queued acknowledgement,
settlement reconciliation, and deduplication tests remain intact.

Every E2E listener now receives its port from the kernel. The backend reports
its actual address when configured with port zero. Vite runs in middleware mode
on an owned HTTP server bound to port zero because Vite's normal numeric port
option treats zero as its default-port request. Restart reuses only the prior
kernel-assigned backend port after its owned child group has exited. Cleanup
closes or signals only handles and process groups created by the fixture.

## Residual risks

- A handshake still CONNECTING after five seconds is force-released as an
  abnormal transport failure; it is not silently suppressed.
- The synthetic EPIPE reproduction uses a bounded repeated reset because kernel
  scheduling controls the precise downstream-write timeslice. It is isolated
  and explicitly not treated as normal browser behavior.
- The expected brief `ECONNREFUSED` during an intentional backend restart stays
  visible by design; only normal lifecycle EPIPE noise is eliminated.
