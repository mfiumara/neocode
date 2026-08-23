import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

function git(args, cwd = process.cwd(), encoding = "utf8") {
  return execFileSync("git", args, { cwd, encoding });
}

function printOutput(output) {
  process.stdout.write(output.length ? output : "[empty output]\n");
  if (output.length && !output.endsWith("\n")) process.stdout.write("\n");
}

const cwd = process.cwd();
const main = git(["rev-parse", "main"], cwd).trim();
const head = git(["rev-parse", "HEAD"], cwd).trim();
const parent = git(["rev-parse", "HEAD^"], cwd).trim();
const tree = git(["rev-parse", "HEAD^{tree}"], cwd).trim();
const mergeBase = git(["merge-base", "main", "HEAD"], cwd).trim();
const nameStatus = git(["diff", "--name-status", "main...HEAD"], cwd);
const identityFormat = "author-name=%an%nauthor-email=%ae%ncommitter-name=%cn%ncommitter-email=%ce";
const headIdentity = git(["show", "-s", `--format=${identityFormat}`, "HEAD"], cwd);
const binaryDiff = git(["diff", "--binary", "--no-ext-diff", mergeBase, "HEAD"], cwd, "buffer");
const diffSha256 = createHash("sha256").update(binaryDiff).digest("hex");
const candidateStatus = git(["status", "--short", "--untracked-files=all"], cwd);

const worktrees = git(["worktree", "list", "--porcelain"], cwd);
const mainRecord = worktrees.split("\n\n").find((record) => record.split("\n").includes("branch refs/heads/main"));
const root = mainRecord?.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
if (!root) throw new Error("Could not locate the main worktree for root porcelain evidence.");
const rootStatus = git(["status", "--short", "--untracked-files=all"], root);

console.log("Candidate Git packet");
console.log(`main=${main}`);
console.log(`HEAD=${head}`);
console.log(`parent=${parent}`);
console.log(`tree=${tree}`);
console.log(`merge-base=${mergeBase}`);
console.log(`canonical-binary-diff-sha256=${diffSha256}`);
console.log("$ git diff --name-status main...HEAD");
printOutput(nameStatus);
console.log(`$ git show -s --format='${identityFormat}' HEAD`);
printOutput(headIdentity);
console.log("$ git status --short --untracked-files=all  # candidate");
printOutput(candidateStatus);
console.log(`$ git -C ${root} status --short --untracked-files=all  # root`);
printOutput(rootStatus);

console.log("$ git diff --check main...HEAD");
const checked = spawnSync("git", ["diff", "--check", "main...HEAD"], { cwd, encoding: "utf8" });
printOutput(`${checked.stdout || ""}${checked.stderr || ""}`);
console.log(`exit code: ${checked.status ?? 1}`);

if (candidateStatus.length) throw new Error("Candidate worktree is dirty.");
if (rootStatus.length) throw new Error("Root/main worktree is dirty.");
if (checked.status !== 0) process.exit(checked.status ?? 1);
