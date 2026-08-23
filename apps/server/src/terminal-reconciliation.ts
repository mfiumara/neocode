import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { AgentJob, JobTerminalDisposition } from "@neocode/protocol";

const execFileAsync = promisify(execFile);

interface ManifestMapping {
  source: string;
  target: string;
  jobId?: string;
  disposition: "merged_verified" | "superseded";
  supersededBy?: string;
  path: string;
}

/** Keep reconciliation and cleanup as separate passes: newly classified jobs are never cleanup inputs immediately. */
export function cleanupCandidates(
  jobs: AgentJob[], newlyReconciled: ReadonlySet<string>, startupHold: ReadonlySet<string>, startup: boolean,
): AgentJob[] {
  return jobs.filter((job) => !newlyReconciled.has(job.id) && !(startup && startupHold.has(job.id)));
}

/**
 * Backfills old runtime records using Git facts, never worker prose or a stale
 * process status. It only adds metadata; checkout removal belongs to janitor.
 */
export class TerminalReconciler {
  constructor(private readonly root: string, private readonly targetRef = "main", private readonly now = Date.now) {}

  async reconcile(jobs: AgentJob[], activeJobIds: ReadonlySet<string> = new Set()): Promise<number> {
    const target = await this.git(["rev-parse", this.targetRef]).catch(() => undefined);
    if (!target) return 0;
    const manifests = await this.readMappings();
    let changed = 0;
    for (const job of jobs) {
      if (job.terminalDisposition || this.hasUnresolvedLifecycle(job, activeJobIds)) continue;
      if (job.status === "cancelled") {
        this.set(job, "cancelled", { method: "explicit-cancellation", detail: "Persisted explicit cancellation." }); changed++; continue;
      }
      if (job.status === "failed") {
        this.set(job, "failed_terminal", { method: "process-failure", detail: job.error || "Worker process failed terminally." }); changed++; continue;
      }
      // Supersession is a coordinator-owned product decision. Schema migration
      // accepts complete prior evidence; reconciliation must not invent or
      // replace an incomplete superseded record from Git similarity alone.
      if (job.integration?.status === "superseded") continue;
      // Classification requires exact durable checkout identity as well as a
      // clean tree. Unknown registration, branch, path, or moved HEAD is unsafe.
      if (!await this.registeredCheckoutMatches(job)) continue;

      // Shared-root jobs cannot own target commits, so ancestry must never call
      // them merged. A reviewed manifest may only resolve them as superseded.
      if (job.isolation.mode === "root") {
        const mapping = manifests.find((entry) => entry.jobId === job.id && entry.disposition === "superseded" && entry.supersededBy);
        const source = mapping && await this.git(["rev-parse", `${mapping.source}^{commit}`]).catch(() => undefined);
        if (mapping && source && await this.isAncestor(source, target) && await this.isAncestor(mapping.target, target)) {
          this.set(job, "superseded", {
            method: "migration-manifest", detail: `Reviewed manifest resolves this shared-root record in favor of ${mapping.supersededBy}.`,
            sourceCommit: source, targetRef: this.targetRef, targetCommit: mapping.target, manifestPath: mapping.path,
          }, mapping.supersededBy);
          changed++;
        }
        continue;
      }

      const source = await this.sourceCommit(job);
      if (!source) continue;
      const commits = await this.git(["rev-list", `${job.baseRef}..${source}`]).then(lines, () => []);
      if (!commits.length) {
        const base = await this.git(["rev-parse", `${job.baseRef}^{commit}`]).catch(() => undefined);
        if (base && source === base && await this.isAncestor(base, target)) {
          this.merged(job, source, target, target, "no-changes", "Exact checkout identity confirms this wrapper has no unique commits.");
          changed++;
        }
        continue;
      }

      const reviewedMerge = job.review?.mergeCommit;
      // Persisted integration fields can be stale or lifecycle-corrupted. A
      // matching completionHead is not Git proof that reviewedMerge contains
      // the source; require ancestry here and leave rewritten commits to the
      // manifest or patch-equivalence checks below.
      if (reviewedMerge && await this.isAncestor(reviewedMerge, target)
        && await this.isAncestor(source, reviewedMerge)) {
        this.merged(job, source, target, reviewedMerge, "reviewed-integration", "Reviewed integration commit is reachable from the target and contains the source."); changed++; continue;
      }

      if ((await Promise.all(commits.map((commit) => this.isAncestor(commit, target)))).every(Boolean)) {
        this.merged(job, source, target, target, "commit-ancestry", "Every intended commit is reachable from the target."); changed++; continue;
      }

      const mapping = manifests.find((entry) => (!entry.jobId || entry.jobId === job.id) && entry.source === source);
      if (mapping && await this.isAncestor(mapping.target, target)) {
        if (mapping.disposition === "superseded" && mapping.supersededBy) {
          this.set(job, "superseded", {
            method: "migration-manifest", detail: `Reviewed manifest maps this source to replacement ${mapping.target}.`,
            sourceCommit: source, targetRef: this.targetRef, targetCommit: mapping.target, manifestPath: mapping.path,
          }, mapping.supersededBy);
        } else {
          this.merged(job, source, target, mapping.target, "migration-manifest", "Reviewed manifest maps this source to integrated target content.", mapping.path);
        }
        changed++; continue;
      }

      // `git cherry` compares stable patch ids. Require every source-side commit
      // to have an equivalent target patch; mixed/merge/ambiguous output stays actionable.
      const cherry = await this.git(["cherry", this.targetRef, source, job.baseRef]).then(lines, () => []);
      if (cherry.length === commits.length && cherry.every((line) => line.startsWith("- "))) {
        this.merged(job, source, target, target, "patch-equivalence", "Every intended commit has a stable patch-id equivalent in the target."); changed++;
      }
    }
    return changed;
  }

  private async sourceCommit(job: AgentJob): Promise<string | undefined> {
    const candidate = job.completion?.head || job.integration?.completionHead
      || (job.isolation.mode === "root" ? job.branch : undefined);
    return candidate ? this.git(["rev-parse", `${candidate}^{commit}`]).catch(() => undefined) : undefined;
  }

  private hasUnresolvedLifecycle(job: AgentJob, activeJobIds: ReadonlySet<string>): boolean {
    if (activeJobIds.has(job.id) || job.status === "queued" || job.status === "running" || job.status === "interrupted") return true;
    if (job.integration && ["reviewing", "integrating", "conflicted"].includes(job.integration.status)) return true;
    if (job.review?.status && job.review.status !== "merged") return true;
    const actions = job.review?.remediation?.actions || [];
    return actions.some((action) => action.state !== "resolved");
  }

  private async registeredCheckoutMatches(job: AgentJob): Promise<boolean> {
    if (!await stat(job.isolation.path).then(() => true, () => false)) return false;
    const expectedPath = await realpath(job.isolation.path).catch(() => undefined);
    if (!expectedPath) return false;
    if (job.isolation.mode === "worktree" && !job.worktreeIdentity) return false;
    if (job.worktreeIdentity) {
      const identityPath = await realpath(job.worktreeIdentity.path).catch(() => undefined);
      if (identityPath !== expectedPath || job.worktreeIdentity.branch !== job.branch
        || job.worktreeIdentity.baseRef !== job.baseRef) return false;
    }

    const listing = await this.git(["worktree", "list", "--porcelain"]).catch(() => "");
    const records = listing.split(/\n\n+/).map((record) => record.split("\n"));
    let registeredBranch: string | undefined;
    for (const record of records) {
      const listed = record.find((line) => line.startsWith("worktree "))?.slice(9);
      if (!listed) continue;
      const normalized = await realpath(listed).catch(() => undefined);
      if (normalized !== expectedPath) continue;
      registeredBranch = record.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
      break;
    }
    if (registeredBranch !== job.branch) return false;
    const [branch, porcelain] = await Promise.all([
      this.gitAt(["branch", "--show-current"], job.isolation.path).catch(() => ""),
      this.gitAt(["status", "--porcelain=v1", "--untracked-files=all"], job.isolation.path).catch(() => "unsafe"),
    ]);
    if (branch !== job.branch || porcelain.length > 0) return false;

    // Shared-root provenance naturally advances with main and can only be
    // settled by an explicit reviewed supersession manifest. Isolated workers
    // must still be exactly at their durable completion/source commit.
    if (job.isolation.mode === "root") return true;
    const [head, source] = await Promise.all([
      this.gitAt(["rev-parse", "HEAD"], job.isolation.path).catch(() => undefined),
      this.sourceCommit(job),
    ]);
    return !!head && !!source && head === source;
  }

  private merged(job: AgentJob, source: string, target: string, mapped: string,
    method: JobTerminalDisposition["evidence"]["method"], detail: string, manifestPath?: string): void {
    this.set(job, "merged_verified", { method, detail, sourceCommit: source, targetRef: this.targetRef, targetCommit: mapped, manifestPath });
    job.integration = { status: "merged", targetRef: this.targetRef, verifiedAt: this.now(), targetHead: target, completionHead: source };
  }

  private set(job: AgentJob, kind: JobTerminalDisposition["kind"], evidence: JobTerminalDisposition["evidence"], supersededBy?: string): void {
    job.terminalDisposition = { kind, recordedAt: this.now(), evidence, ...(supersededBy ? { supersededBy } : {}) };
    job.updatedAt = this.now();
    job.recoverable = false;
    if (kind === "superseded" && !supersededBy) throw new Error("Superseded jobs require supersededBy evidence.");
    if (kind === "superseded") job.recoveryIssue = `Resolved as superseded by ${supersededBy}.`;
  }

  private async readMappings(): Promise<ManifestMapping[]> {
    const runtime = join(this.root, ".neocode", "runtime");
    const files = await walk(runtime).catch(() => []);
    const candidates = files.filter((path) => /(?:manifest|integration-reports).*\.json$/i.test(path));
    const result: ManifestMapping[] = [];
    for (const path of candidates) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const value = parsed as Record<string, unknown>;
        // Authority is explicit in the canonical manifest shape. A commit-like
        // top-level field is data, not proof that a coordinator reviewed it.
        if (value.reviewed !== true && value.verified !== true) continue;
        for (const raw of Array.isArray(value.entries) ? value.entries : []) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const entry = raw as Record<string, unknown>;
          const source = entry.sourceCommit || entry.source;
          const target = entry.integrationCommit || entry.targetCommit || entry.reconciledAs;
          const disposition = entry.disposition;
          if (typeof source === "string" && typeof target === "string" && (disposition === "merged_verified" || disposition === "superseded")) {
            result.push({
              source, target, disposition,
              jobId: typeof entry.jobId === "string" ? entry.jobId : undefined,
              supersededBy: typeof entry.supersededBy === "string" ? entry.supersededBy : undefined,
              path: relative(this.root, path),
            });
          }
        }
        // Compatibility with an explicitly reviewed backlog manifest shape.
        for (const raw of Array.isArray(value.includedSources) ? value.includedSources : []) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const entry = raw as Record<string, unknown>;
          if (typeof entry.source !== "string" || !/^[0-9a-f]{7,40}$/i.test(entry.source)) continue;
          const target = String(entry.reconciledAs || "").split("+")[0];
          if (/^[0-9a-f]{7,40}$/i.test(target)) result.push({ source: entry.source, target, disposition: "merged_verified", path: relative(this.root, path) });
        }
      } catch {
        // One malformed or concurrently replaced manifest must not abort
        // startup or discard independently valid reviewed mappings.
        continue;
      }
    }
    return result;
  }

  private isAncestor(commit: string, target: string): Promise<boolean> {
    return execFileAsync("git", ["merge-base", "--is-ancestor", commit, target], { cwd: this.root }).then(() => true, () => false);
  }
  private async git(args: string[]): Promise<string> { return this.gitAt(args, this.root); }
  private async gitAt(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }); return stdout.trim();
  }
}

function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)]));
  return nested.flat();
}
