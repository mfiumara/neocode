package.path = vim.uv.cwd() .. "/lua/?.lua;" .. vim.uv.cwd() .. "/lua/?/init.lua;" .. package.path

local util = require("neocode.util")
local config = require("neocode.config")
local store = require("neocode.store")
local worktree = require("neocode.worktree")
local pipeline = require("neocode.pipeline")
local passed, failed = 0, 0
local function check(name, cond)
  if cond then passed = passed + 1; print("PASS " .. name)
  else failed = failed + 1; print("FAIL " .. name) end
end
local base = "/tmp/neocode-pipeline-" .. util.id()
local function sh(cmd, cwd) local r = util.run({ "sh", "-c", cmd }, { cwd = cwd }); assert(r.code == 0, r.stderr); return r end
local function repo(name)
  local root = base .. "/" .. name; vim.fn.mkdir(root, "p")
  sh("git init -q -b main && git config user.email t@t && git config user.name test && echo base > file && git add . && git commit -qm init", root)
  worktree.ensure_ignored(root)
  return root
end
local function job(root, name, text)
  local s = store.create(root, name); local wt = worktree.ensure(root, s)
  local f = assert(io.open(wt .. "/file", "w")); f:write(text); f:close()
  pipeline.complete(root, s.id, true)
  return s, wt
end
local approve = function(ctx)
  return { approved = true, summary = "meets requirements", requirements = { { requirement = ctx.requirements, met = true } },
    risks = { security = {}, data_loss = {}, architecture = {} }, session_id = ctx.run_id }
end
local reject = function()
  return { approved = false, summary = "incorrect", requirements = {},
    risks = { security = {}, data_loss = {}, architecture = { "bad boundary" } } }
end

config.setup({ pipeline = { commands = { { "sh", "-c", "test -f file" } }, main_branch = "main" } })
local r1 = repo("pass"); local s1, wt1 = job(r1, "pass", "changed\n")
local reviewed = pipeline.review(r1, s1.id, "change file", { judge = approve })
check("approval enters merge queue", reviewed.pipeline.state == "merge_ready" and reviewed.pipeline.ci.passed and reviewed.pipeline.judge.approved)
local merged, merge_err = pipeline.integrate(r1, s1.id)
check("approved change merged", merged and merged.pipeline.state == "merged" and merged.pipeline.merged_sha ~= nil and not worktree.exists(wt1), merge_err)
local again = pipeline.integrate(r1, s1.id)
check("merge is idempotent", again and again.pipeline.merged_sha == merged.pipeline.merged_sha)
check("integration commit is traceable", util.git({ "log", "-1", "--format=%B" }, r1).stdout:find("Neocode%-Job: " .. s1.id) ~= nil)

config.setup({ pipeline = { commands = { { "sh", "-c", "exit 7" } }, main_branch = "main" } })
local r2 = repo("ci"); local s2 = job(r2, "ci", "ci\n")
local ci_bad = pipeline.review(r2, s2.id, "x", { judge = approve })
check("CI failure requests changes", ci_bad.pipeline.state == "changes_requested" and ci_bad.pipeline.ci.commands[1].code == 7 and ci_bad.pipeline.judge == nil)

config.setup({ pipeline = { commands = { { "sh", "-c", "true" } }, main_branch = "main" } })
local r3 = repo("reject"); local s3 = job(r3, "reject", "reject\n")
local rejected = pipeline.review(r3, s3.id, "x", { judge = reject })
check("judge rejection requests changes", rejected.pipeline.state == "changes_requested" and rejected.pipeline.judge.approved == false)

local r4 = repo("dirty"); local s4 = job(r4, "dirty", "approved\n")
pipeline.review(r4, s4.id, "x", { judge = approve })
local f = assert(io.open(r4 .. "/root-dirty", "w")); f:write("do not overwrite"); f:close()
local no_merge, dirty_err = pipeline.integrate(r4, s4.id)
check("dirty root blocks merge", no_merge == nil and dirty_err:find("dirty") and vim.uv.fs_stat(r4 .. "/root-dirty") ~= nil)
os.remove(r4 .. "/root-dirty")

local r5 = repo("conflict"); local s5, wt5 = job(r5, "conflict", "worker\n")
pipeline.review(r5, s5.id, "x", { judge = approve })
sh("echo main > file && git add file && git commit -qm main-change", r5)
local no_conflict_merge = pipeline.integrate(r5, s5.id)
check("reconciliation conflict is persisted", no_conflict_merge == nil and store.get(r5, s5.id).pipeline.state == "conflict" and worktree.exists(wt5))
check("root is unchanged on conflict", vim.trim(io.open(r5 .. "/file"):read("*a")) == "main")

local r6 = repo("recover"); local s6 = job(r6, "recover", "recover\n")
pipeline.review(r6, s6.id, "x", { judge = approve })
store.update_meta(r6, s6.id, function(m) m.pipeline.state = "merging" end)
local recovered = pipeline.recover(r6, s6.id)
check("restart recovery does not guess success", recovered.pipeline.state == "merge_ready")

vim.fn.delete(base, "rf")
print(string.format("\n%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
