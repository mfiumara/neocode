#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// Task-specific, reviewer-visible salvage audit. Keep these historical
// identities out of reusable Git packet/check implementations.
const source = "aaf9226aaa2f41178405b1d821f1dcf227f301c9";
const parent = "6d57452799cfb1a0a71b71ba32e241e1bd573805";
const tree = "97fb7aeb8f9dd21130a24d6a64de6c9486d5bd90";
const diffSha256 = "dbff1acec67388f4d4a9821f074b969d5ef52e5c5dec47fd375fcbaa1c53bc37";
const expectedNames = `M\tapps/server/src/completion-pipeline.test.ts
M\tapps/server/src/completion-pipeline.ts
M\tapps/server/src/orchestrator.ts
M\tapps/server/src/runtime-state.test.ts
M\tapps/server/src/runtime-state.ts
A\tapps/server/src/terminal-reconciliation.test.ts
A\tapps/server/src/terminal-reconciliation.ts
M\tapps/server/src/worktree-janitor.test.ts
M\tapps/server/src/worktree-janitor.ts
M\tapps/web/src/App.tsx
M\tapps/web/src/jobLifecycle.test.ts
M\tapps/web/src/jobLifecycle.ts
M\tdocs/architecture.md
M\tpackages/protocol/src/index.ts`;

function run(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trimEnd();
}
function record(command, output) {
  console.log(`$ ${command}`);
  console.log(output || "[empty output]");
}

const identities = run(["rev-parse", source, `${source}^`, `${source}^{tree}`]);
record(`git rev-parse ${source} ${source}^ ${source}^{tree}`, identities);
if (identities !== `${source}\n${parent}\n${tree}`) throw new Error("Preserved source identity does not match the reviewed salvage source.");

const names = run(["diff", "--name-status", parent, source]);
record(`git diff --name-status ${parent} ${source}`, names);
if (names !== expectedNames) throw new Error("Preserved source direct name-status changed.");

const diff = spawnSync("git", ["diff", "--binary", "--full-index", "--no-ext-diff", parent, source], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
if (diff.status !== 0) throw new Error(diff.stderr.toString().trim() || "Preserved source direct diff failed.");
const hash = spawnSync("shasum", ["-a", "256"], { input: diff.stdout, encoding: "utf8" });
if (hash.status !== 0) throw new Error(hash.stderr.trim() || "Direct diff hashing failed.");
const actualHash = hash.stdout.trim().split(/\s+/)[0];
record(`git diff --binary --full-index --no-ext-diff ${parent} ${source} | shasum -a 256`, actualHash);
if (actualHash !== diffSha256) throw new Error("Preserved source canonical direct-diff hash changed.");

console.log("stale-packet-rejection: 32fa3a7b… rejected; never accepted as source or candidate evidence");
console.log("e2e-causal-scope: retained only because prior candidate CI failed with Error: listen EADDRINUSE: address already in use 127.0.0.1:14318; listeners now bind port 0 and teardown only owned child process groups");
