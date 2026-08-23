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

  async reconcile(jobs: AgentJob[]): Promise<number> {
    const target = await this.git(["rev-parse", this.targetRef]).catch(() => undefined);
    if (!target) return 0;
    const manifests = await this.readMappings();
    let changed = 0;
    for (const job of jobs) {
      if (job.terminalDisposition) continue;
      if (job.status === "cancelled") {
        this.set(job, "cancelled", { method: "explicit-cancellation", detail: "Persisted explicit cancellation." }); changed++; continue;
      }
      if (job.status === "failed") {
        this.set(job, "failed_terminal", { method: "process-failure", detail: job.error || "Worker process failed terminally." }); changed++; continue;
      }
      // A dirty registered checkout may contain evidence not represented by any
      // commit. It must remain actionable regardless of a manifest or ancestry.
      const dirty = await this.registeredCheckoutDirty(job);
      if (dirty !== false) continue; // true and unknown are both unsafe

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
      if (!commits.length) continue;

      const reviewedMerge = job.review?.mergeCommit;
      if (reviewedMerge && await this.isAncestor(reviewedMerge, target)
        && (await this.isAncestor(source, reviewedMerge) || job.integration?.completionHead === source)) {
        this.merged(job, source, target, reviewedMerge, "reviewed-integration", "Reviewed integration commit is reachable from the target."); changed++; continue;
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
    const candidate = job.completion?.head || job.integration?.completionHead || job.branch;
    return this.git(["rev-parse", `${candidate}^{commit}`]).catch(() => undefined);
  }

  private async registeredCheckoutDirty(job: AgentJob): Promise<boolean | undefined> {
    const exists = await stat(job.isolation.path).then(() => true, () => false);
    if (!exists) return false; // cleaned/missing checkout is independent; branch evidence remains usable
    const listing = await this.git(["worktree", "list", "--porcelain"]).catch(() => "");
    const expected = await realpath(job.isolation.path).catch(() => job.isolation.path);
    const listedPaths = listing.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    const normalized = await Promise.all(listedPaths.map((path) => realpath(path).catch(() => path)));
    if (!normalized.includes(expected)) return undefined;
    return this.gitAt(["status", "--porcelain=v1", "--untracked-files=all"], job.isolation.path)
      .then((value) => value.length > 0, () => undefined);
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
      const value = await readFile(path, "utf8").then(JSON.parse, () => undefined) as any;
      if (!value) continue;
      // A worker-authored inventory is not authority by itself. It becomes a
      // reviewed mapping only when explicitly marked reviewed or tied to an
      // integration commit that the Git checks below prove reached target.
      const reviewed = value.reviewed === true || typeof value.reviewedIntegrationCommit === "string" || typeof value.integrationCommit === "string";
      if (!reviewed) continue;
      for (const entry of Array.isArray(value.entries) ? value.entries : []) {
        const source = entry.sourceCommit || entry.source;
        const target = entry.integrationCommit || entry.targetCommit || entry.reconciledAs;
        const disposition = entry.disposition;
        if (typeof source === "string" && typeof target === "string" && (disposition === "merged_verified" || disposition === "superseded")) {
          result.push({ source, target, disposition, jobId: entry.jobId, supersededBy: entry.supersededBy, path: relative(this.root, path) });
        }
      }
      // Compatibility with the reviewed 4856566e/e50094b9 backlog manifest shape.
      for (const entry of Array.isArray(value.includedSources) ? value.includedSources : []) {
        if (typeof entry.source !== "string" || !/^[0-9a-f]{7,40}$/i.test(entry.source)) continue;
        const target = String(entry.reconciledAs || "").split("+")[0];
        if (/^[0-9a-f]{7,40}$/i.test(target)) result.push({ source: entry.source, target, disposition: "merged_verified", path: relative(this.root, path) });
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
