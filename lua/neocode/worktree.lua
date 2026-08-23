local config = require("neocode.config")
local util = require("neocode.util")

local M = {}

function M.path_for(repo_root, session)
  return repo_root .. "/" .. config.options.worktrees_dir .. "/" .. session.name
end

function M.exists(path)
  return vim.uv.fs_stat(path) ~= nil
end

function M.dirty(path)
  local r = util.git({ "status", "--porcelain" }, path)
  return r.code == 0 and vim.trim(r.stdout) ~= ""
end

local function branch_exists(repo_root, branch)
  local r = util.git({ "rev-parse", "--verify", "--quiet", branch }, repo_root)
  return r.code == 0
end

function M.ensure(repo_root, session)
  local path = M.path_for(repo_root, session)
  if M.exists(path) then
    return path
  end
  local branch = session.worktree.branch
  local args
  if branch_exists(repo_root, branch) then
    args = { "worktree", "add", path }
  else
    args = { "worktree", "add", "-b", branch, path, session.worktree.base_ref }
  end
  local r = util.git(args, repo_root)
  if r.code ~= 0 then
    error("worktree add failed: " .. vim.trim(r.stderr))
  end
  return path
end

function M.remove(repo_root, session, opts)
  opts = opts or {}
  local path = M.path_for(repo_root, session)
  if not M.exists(path) then
    return true, false
  end
  if M.dirty(path) and not opts.force then
    return nil, "worktree '" .. session.name .. "' has uncommitted changes"
  end
  local args = { "worktree", "remove" }
  if opts.force then table.insert(args, "--force") end
  table.insert(args, path)
  local r = util.git(args, repo_root)
  if r.code ~= 0 then
    return nil, vim.trim(r.stderr)
  end
  return true, false
end

function M.ensure_ignored(repo_root)
  local exclude = repo_root .. "/.git/info/exclude"
  local f = io.open(exclude, "r")
  local content = f and f:read("*a") or ""
  if f then f:close() end
  for _, entry in ipairs({ config.options.worktrees_dir .. "/", config.options.neocode_dir .. "/" }) do
    if not content:find(vim.pesc(entry), 1, true) then
      local w = io.open(exclude, "a")
      if w then
        w:write(entry .. "\n")
        w:close()
      end
    end
  end
end

return M
