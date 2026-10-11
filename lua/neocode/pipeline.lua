local config = require("neocode.config")
local store = require("neocode.store")
local util = require("neocode.util")
local worktree = require("neocode.worktree")

local M = {}

M.states = {
  completed = true, reviewing = true, changes_requested = true,
  merge_ready = true, merging = true, merged = true, conflict = true,
}

local function path_exists(path)
  return vim.uv.fs_stat(path) ~= nil
end

local function transition(repo, id, state, fields)
  assert(M.states[state], "invalid pipeline state: " .. tostring(state))
  local meta = store.update_meta(repo, id, function(m)
    m.pipeline = m.pipeline or { attempts = 0 }
    m.pipeline.state = state
    m.pipeline.updated_at = util.now_iso()
    for k, v in pairs(fields or {}) do m.pipeline[k] = v end
  end)
  store.append_event(repo, id, { type = "pipeline_transition", state = state, evidence = fields })
  return meta
end

local function read_config(repo)
  local defaults = config.options.pipeline or {}
  local local_cfg = util.json_read(repo .. "/.neocode-pipeline.json")
    or util.json_read(repo .. "/neocode.pipeline.json") or {}
  return vim.tbl_deep_extend("force", vim.deepcopy(defaults), local_cfg)
end

local function has_script(pkg, name)
  return type(pkg) == "table" and type(pkg.scripts) == "table" and type(pkg.scripts[name]) == "string"
end

function M.detect_commands(repo)
  local cfg = read_config(repo)
  if type(cfg.commands) == "table" and #cfg.commands > 0 then return cfg.commands, cfg end
  local out = {}
  local pkg = util.json_read(repo .. "/package.json")
  if pkg then
    local runner = path_exists(repo .. "/pnpm-lock.yaml") and "pnpm"
      or (path_exists(repo .. "/yarn.lock") and "yarn" or "npm")
    for _, name in ipairs({ "format:check", "lint", "typecheck", "test", "build" }) do
      if has_script(pkg, name) then
        if runner == "npm" then out[#out + 1] = { "npm", "run", name }
        else out[#out + 1] = { runner, name } end
      end
    end
  elseif path_exists(repo .. "/Cargo.toml") then
    out = { { "cargo", "fmt", "--", "--check" }, { "cargo", "test" }, { "cargo", "build" } }
  elseif path_exists(repo .. "/go.mod") then
    out = { { "sh", "-c", "test -z \"$(gofmt -l .)\"" }, { "go", "test", "./..." }, { "go", "build", "./..." } }
  elseif path_exists(repo .. "/pyproject.toml") then
    -- Python tooling is not universal; only select tools explicitly present in PATH.
    if vim.fn.executable("ruff") == 1 then out[#out + 1] = { "ruff", "check", "." } end
    if vim.fn.executable("pytest") == 1 then out[#out + 1] = { "pytest", "-q" } end
  end
  return out, cfg
end

local function normalize_command(c)
  if type(c) == "string" then return { "sh", "-c", c } end
  if type(c) == "table" and type(c.cmd) == "table" then return c.cmd end
  return c
end

function M.run_ci(repo, cwd, phase)
  local commands, cfg = M.detect_commands(repo)
  local evidence = { phase = phase, started_at = util.now_iso(), commands = {}, passed = true }
  if #commands == 0 and cfg.require_commands ~= false then
    evidence.passed = false
    evidence.error = "no CI commands configured or safely detected"
    evidence.finished_at = util.now_iso()
    return evidence
  end
  for _, spec in ipairs(commands) do
    local cmd = normalize_command(spec)
    local timeout = (type(spec) == "table" and spec.timeout_ms) or cfg.timeout_ms or 300000
    local r = util.run(cmd, { cwd = cwd, timeout = timeout, output_limit = cfg.output_limit or 262144 })
    evidence.commands[#evidence.commands + 1] = {
      command = cmd, code = r.code, stdout = r.stdout, stderr = r.stderr,
      timed_out = r.timed_out, truncated = r.truncated,
    }
    if r.code ~= 0 then evidence.passed = false; break end
  end
  evidence.finished_at = util.now_iso()
  return evidence
end

local function valid_report(report)
  if type(report) ~= "table" or type(report.approved) ~= "boolean" then
    return false, "judge did not return structured approval"
  end
  if type(report.summary) ~= "string" or type(report.requirements) ~= "table" or type(report.risks) ~= "table" then
    return false, "judge report is missing summary, requirements, or risks"
  end
  for _, k in ipairs({ "security", "data_loss", "architecture" }) do
    if type(report.risks[k]) ~= "table" then return false, "judge must explicitly report " .. k .. " risks" end
  end
  if report.approved then
    if #report.requirements == 0 then return false, "approval did not assess any requirements" end
    for _, assessment in ipairs(report.requirements) do
      if type(assessment) ~= "table" or assessment.met ~= true then
        return false, "approval contains an unmet or unstructured requirement"
      end
    end
  end
  return true
end

local function render_prompt(meta, requirements, diff)
  return table.concat({
    "You are a fresh independent code-review judge. Do not modify the worktree.",
    "Evaluate the diff against every requirement and identify security, data-loss, and architecture risks.",
    "Return JSON only: {approved:boolean,summary:string,requirements:[],risks:{security:[],data_loss:[],architecture:[]}}.",
    "JOB: " .. meta.id,
    "REQUIREMENTS:\n" .. (requirements or "(not supplied)"),
    "DIFF:\n" .. diff,
  }, "\n\n")
end

local function replace(s, token, value)
  return (s:gsub(token:gsub("([^%w])", "%%%1"), function() return value end))
end

local function run_judge(repo, meta, cwd, requirements, diff, opts, cfg)
  local run_id = "judge-" .. util.id()
  local ctx = { repo_root = repo, worktree = cwd, job = meta, requirements = requirements,
    diff = diff, prompt = render_prompt(meta, requirements, diff), run_id = run_id }
  local report
  if opts and opts.judge then
    report = opts.judge(ctx)
  elseif type(cfg.judge_command) == "table" and #cfg.judge_command > 0 then
    local dir = repo .. "/" .. config.options.neocode_dir .. "/sessions/" .. meta.id .. "/judges/" .. run_id
    vim.fn.mkdir(dir, "p")
    local prompt_path, report_path = dir .. "/prompt.txt", dir .. "/report.json"
    local f = assert(io.open(prompt_path, "w")); f:write(ctx.prompt); f:close()
    local cmd = {}
    for _, arg in ipairs(cfg.judge_command) do
      arg = replace(arg, "{prompt}", prompt_path)
      arg = replace(arg, "{report}", report_path)
      arg = replace(arg, "{worktree}", cwd)
      cmd[#cmd + 1] = arg
    end
    local r = util.run(cmd, { cwd = cwd, timeout = cfg.judge_timeout_ms or 600000,
      output_limit = cfg.output_limit or 262144 })
    if r.code ~= 0 then return nil, run_id, "judge command failed: " .. r.stderr end
    report = util.json_read(report_path)
    if not report and vim.trim(r.stdout) ~= "" then
      local ok, decoded = pcall(vim.json.decode, r.stdout); if ok then report = decoded end
    end
  else
    return nil, run_id, "no independent judge command configured"
  end
  if report and report.session_id and report.session_id == (meta.agent and meta.agent.backend_session_id) then
    return nil, run_id, "judge reused the worker session"
  end
  local ok, err = valid_report(report)
  if not ok then return nil, run_id, err end
  report.run_id = run_id
  report.finished_at = util.now_iso()
  return report, run_id
end

local function diff_for(cwd, base)
  local valid = util.git({ "rev-parse", "--is-inside-work-tree" }, cwd)
  if valid.code ~= 0 then return nil, "worker worktree is not a valid git checkout" end
  local d = util.git({ "diff", "--binary", base }, cwd)
  if d.code ~= 0 then return nil, d.stderr end
  local untracked = util.git({ "ls-files", "--others", "--exclude-standard" }, cwd)
  local text = d.stdout
  for file in untracked.stdout:gmatch("[^\r\n]+") do
    local r = util.git({ "diff", "--no-index", "--binary", "/dev/null", file }, cwd)
    text = text .. "\n" .. r.stdout
  end
  if vim.trim(text) == "" then return nil, "worker produced no diff" end
  return text
end

function M.complete(repo, id, succeeded, detail)
  if not succeeded then
    return transition(repo, id, "changes_requested", { failure = detail or "worker failed" })
  end
  return transition(repo, id, "completed", { worker = { succeeded = true, detail = detail } })
end

-- Completion hook used by coordinators: persistence happens before any review work,
-- then CI and a newly spawned judge run automatically.
function M.worker_finished(repo, id, succeeded, requirements, opts)
  local meta = M.complete(repo, id, succeeded, requirements)
  if not succeeded then return meta end
  return M.review(repo, id, requirements, opts)
end

function M.review(repo, id, requirements, opts)
  local meta = assert(store.get(repo, id), "no such job")
  local p = meta.pipeline or {}
  if p.state ~= "completed" and p.state ~= "changes_requested" then
    error("job is not completed/retryable (state " .. tostring(p.state) .. ")")
  end
  if not (p.worker and p.worker.succeeded) then error("worker did not complete successfully") end
  local cwd = worktree.path_for(repo, meta)
  if meta.worktree.mode ~= "worktree" or not path_exists(cwd) then error("delegated worktree is missing") end
  local diff, diff_err = diff_for(cwd, meta.worktree.base_ref)
  if not diff then return transition(repo, id, "changes_requested", { failure = diff_err }) end
  local cfg = read_config(repo)
  if #diff > (cfg.diff_limit or 2097152) then
    return transition(repo, id, "changes_requested", { failure = "diff exceeds configured review limit" })
  end
  transition(repo, id, "reviewing", {
    failure = vim.NIL, attempts = (p.attempts or 0) + 1, requirements = requirements,
  })
  local ci = M.run_ci(repo, cwd, "pre_review")
  if not ci.passed then return transition(repo, id, "changes_requested", { ci = ci, failure = "local CI failed" }) end
  local report, run_id, err = run_judge(repo, meta, cwd, requirements, diff, opts, cfg)
  if not report then
    return transition(repo, id, "changes_requested", { ci = ci, judge_run_id = run_id, failure = err })
  end
  if not report.approved then
    return transition(repo, id, "changes_requested", { ci = ci, judge = report, failure = "judge rejected changes" })
  end
  return transition(repo, id, "merge_ready", { ci = ci, judge = report, requirements = requirements, failure = vim.NIL })
end

local function integration_lock_path(repo)
  local gitdir = vim.trim(util.git({ "rev-parse", "--git-common-dir" }, repo).stdout)
  if not gitdir:match("^/") then gitdir = repo .. "/" .. gitdir end
  return gitdir .. "/neocode-integration.lock"
end

local function acquire(repo, id)
  local lock = integration_lock_path(repo)
  local ok = vim.uv.fs_mkdir(lock, 448)
  if not ok then return nil, "another integration is active" end
  util.json_write(lock .. "/owner.json", {
    job_id = id, pid = vim.uv.os_getpid(), started_at = util.now_iso(),
  })
  return lock
end

local function release(lock)
  if lock then vim.fn.delete(lock, "rf") end
end

local function root_guard(repo, main)
  local branch = util.git({ "symbolic-ref", "--short", "HEAD" }, repo)
  if branch.code ~= 0 or vim.trim(branch.stdout) ~= main then return nil, "root checkout is not on " .. main end
  local status = util.git({ "status", "--porcelain" }, repo)
  if status.code ~= 0 or vim.trim(status.stdout) ~= "" then return nil, "root checkout is dirty" end
  return true
end

function M.integrate(repo, id, opts)
  opts = opts or {}
  local meta = assert(store.get(repo, id), "no such job")
  if meta.pipeline and meta.pipeline.state == "merged" then return meta end
  if not meta.pipeline or meta.pipeline.state ~= "merge_ready" then error("job is not merge ready") end
  local cfg = read_config(repo)
  local main = cfg.main_branch or meta.worktree.base_ref or "main"
  local lock, lock_err = acquire(repo, id)
  if not lock then return nil, lock_err end
  local function finish(value, err) release(lock); return value, err end
  local ok, guard_err = root_guard(repo, main)
  if not ok then transition(repo, id, "merge_ready", { failure = guard_err }); return finish(nil, guard_err) end
  local cwd = worktree.path_for(repo, meta)
  if not path_exists(cwd) then return finish(nil, "approved worktree is missing") end
  transition(repo, id, "merging", { failure = vim.NIL })

  -- Capture approved uncommitted worker output in a traceable commit, never in root.
  local add = util.git({ "add", "-A" }, cwd)
  if add.code ~= 0 then transition(repo, id, "merge_ready", { failure = add.stderr }); return finish(nil, add.stderr) end
  local staged = util.git({ "diff", "--cached", "--quiet" }, cwd)
  if staged.code == 1 then
    local message = ("neocode: integrate %s\n\nNeocode-Job: %s\nNeocode-Judge: %s")
      :format(meta.name, meta.id, meta.pipeline.judge.run_id)
    local commit = util.git({ "-c", "user.name=Neocode Integration", "-c", "user.email=neocode@local",
      "commit", "-m", message }, cwd)
    if commit.code ~= 0 then transition(repo, id, "merge_ready", { failure = commit.stderr }); return finish(nil, commit.stderr) end
  elseif staged.code ~= 0 then
    transition(repo, id, "merge_ready", { failure = staged.stderr }); return finish(nil, staged.stderr)
  end

  local reconcile = util.git({ "merge", "--no-edit", main }, cwd)
  if reconcile.code ~= 0 then
    util.git({ "merge", "--abort" }, cwd)
    transition(repo, id, "conflict", { failure = reconcile.stderr })
    return finish(nil, "integration conflict")
  end
  local ci = M.run_ci(repo, cwd, "post_reconcile")
  if not ci.passed then
    transition(repo, id, "changes_requested", { post_reconcile_ci = ci, failure = "post-reconciliation CI failed" })
    return finish(nil, "post-reconciliation CI failed")
  end
  ok, guard_err = root_guard(repo, main)
  if not ok then transition(repo, id, "merge_ready", { failure = guard_err }); return finish(nil, guard_err) end
  local head = vim.trim(util.git({ "rev-parse", "HEAD" }, cwd).stdout)
  local current = vim.trim(util.git({ "rev-parse", "HEAD" }, repo).stdout)
  if current ~= head then
    local merge = util.git({ "merge", "--ff-only", head }, repo)
    if merge.code ~= 0 then transition(repo, id, "conflict", { failure = merge.stderr }); return finish(nil, merge.stderr) end
  end
  local verified = vim.trim(util.git({ "rev-parse", "HEAD" }, repo).stdout) == head
  ok, guard_err = root_guard(repo, main)
  if not verified or not ok then
    transition(repo, id, "conflict", { failure = guard_err or "merged HEAD could not be verified" })
    return finish(nil, guard_err or "merge verification failed")
  end
  transition(repo, id, "merged", { post_reconcile_ci = ci, merged_sha = head, merged_at = util.now_iso() })
  local removed, remove_err = worktree.remove(repo, meta)
  if not removed then
    -- Merge remains verified; retain the worktree and expose cleanup failure for safe retry.
    transition(repo, id, "merged", { cleanup_error = remove_err })
  end
  return finish(store.get(repo, id))
end

function M.process_queue(repo, opts)
  local ready = {}
  for _, meta in ipairs(store.list(repo)) do
    if meta.pipeline and meta.pipeline.state == "merge_ready" then ready[#ready + 1] = meta end
  end
  table.sort(ready, function(a, b)
    return (a.pipeline.updated_at or a.updated_at or "") < (b.pipeline.updated_at or b.updated_at or "")
  end)
  local results = {}
  for _, meta in ipairs(ready) do
    local merged, err = M.integrate(repo, meta.id, opts)
    results[#results + 1] = { id = meta.id, merged = merged ~= nil, error = err }
    if not merged then break end -- preserve queue ordering after a blocked head job
  end
  return results
end

function M.manual_approve(repo, id, reason)
  assert(type(reason) == "string" and vim.trim(reason) ~= "", "manual approval requires a reason")
  local meta = assert(store.get(repo, id), "no such job")
  local cfg = read_config(repo)
  if cfg.allow_manual_approval ~= true then error("manual approval is disabled by repository policy") end
  if not meta.pipeline or meta.pipeline.state ~= "changes_requested" then error("job has no rejected review") end
  return transition(repo, id, "merge_ready", { manual_approval = { reason = reason, at = util.now_iso() }, failure = vim.NIL })
end

-- Safe restart recovery: persisted merge-ready jobs can be retried; merging is never
-- guessed successful. A verified root HEAD permits cleanup/finalization only.
function M.recover(repo, id)
  local meta = assert(store.get(repo, id), "no such job")
  if not meta.pipeline or meta.pipeline.state ~= "merging" then return meta end
  local root_head = vim.trim(util.git({ "rev-parse", "HEAD" }, repo).stdout)
  local head = meta.pipeline.merged_sha
  local cwd = worktree.path_for(repo, meta)
  if not head and path_exists(cwd) then
    -- Covers a crash after fast-forward but before the final state write.
    head = vim.trim(util.git({ "rev-parse", "HEAD" }, cwd).stdout)
  end
  if head ~= "" and root_head == head and path_exists(cwd) and not worktree.dirty(cwd) then
    transition(repo, id, "merged", { merged_sha = head, recovered_at = util.now_iso() })
    worktree.remove(repo, meta)
  else
    transition(repo, id, "merge_ready", { failure = "integration interrupted; retry required" })
  end
  -- Explicit recovery may remove only this job's abandoned lock. Never steal a
  -- lock owned by another queued integration.
  local lock = integration_lock_path(repo)
  local owner = util.json_read(lock .. "/owner.json")
  if owner and owner.job_id == id then vim.fn.delete(lock, "rf") end
  return store.get(repo, id)
end

return M
