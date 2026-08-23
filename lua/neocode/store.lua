local config = require("neocode.config")
local util = require("neocode.util")

local M = {}

local function sessions_root(repo_root)
  return repo_root .. "/" .. config.options.neocode_dir .. "/sessions"
end

local function meta_path(repo_root, id)
  return sessions_root(repo_root) .. "/" .. id .. "/meta.json"
end

local function transcript_path(repo_root, id)
  return sessions_root(repo_root) .. "/" .. id .. "/transcript.jsonl"
end

function M.repo_identity(repo_root)
  local origin = util.git({ "remote", "get-url", "origin" }, repo_root)
  local sha = util.git({ "rev-list", "--max-parents=0", "HEAD" }, repo_root)
  local first_sha = nil
  if sha.code == 0 and vim.trim(sha.stdout) ~= "" then
    first_sha = vim.split(vim.trim(sha.stdout), "\n")[1]
  end
  return {
    name = vim.fs.basename(repo_root),
    origin = origin.code == 0 and vim.trim(origin.stdout) or nil,
    root_sha = first_sha,
  }
end

local function base_ref(repo_root)
  local r = util.git({ "symbolic-ref", "--short", "HEAD" }, repo_root)
  if r.code == 0 and vim.trim(r.stdout) ~= "" then
    return vim.trim(r.stdout)
  end
  return "main"
end

function M.create(repo_root, name, opts)
  opts = opts or {}
  local id = util.id()
  local mode = opts.local_mode and "local" or "worktree"
  local base = base_ref(repo_root)
  local meta = {
    version = 1,
    id = id,
    name = name,
    created_at = util.now_iso(),
    updated_at = util.now_iso(),
    status = "active",
    repo = M.repo_identity(repo_root),
    worktree = {
      mode = mode,
      branch = mode == "local" and base or (config.options.branch_prefix .. name),
      base_ref = base,
      path_hint = mode == "local" and "." or (config.options.worktrees_dir .. "/" .. name),
      head_sha = nil,
      dirty_at_detach = false,
      removed_on_archive = false,
    },
    agent = {
      kind = opts.agent_kind or config.options.default_agent,
      backend_session_id = nil,
      model = nil,
      runs_on = "local",
    },
  }
  util.json_write(meta_path(repo_root, id), meta)
  vim.fn.mkdir(vim.fs.dirname(transcript_path(repo_root, id)), "p")
  local f = io.open(transcript_path(repo_root, id), "a")
  f:close()
  return meta
end

function M.get(repo_root, id)
  return util.json_read(meta_path(repo_root, id))
end

function M.find_by_name(repo_root, name)
  for _, meta in ipairs(M.list(repo_root)) do
    if meta.name == name then return meta end
  end
  return nil
end

function M.list(repo_root, status)
  local root = sessions_root(repo_root)
  local out = {}
  if not vim.uv.fs_stat(root) then return out end
  for entry, fs_type in vim.fs.dir(root) do
    if fs_type == "directory" then
      local meta = util.json_read(meta_path(repo_root, entry))
      if meta and (not status or meta.status == status) then
        table.insert(out, meta)
      end
    end
  end
  table.sort(out, function(a, b) return (a.updated_at or "") > (b.updated_at or "") end)
  return out
end

function M.update_meta(repo_root, id, fn)
  local meta = M.get(repo_root, id)
  if not meta then error("no such session: " .. tostring(id)) end
  fn(meta)
  meta.updated_at = util.now_iso()
  util.json_write(meta_path(repo_root, id), meta)
  return meta
end

function M.archive(repo_root, id)
  return M.update_meta(repo_root, id, function(m)
    m.status = "archived"
  end)
end

function M.unarchive(repo_root, id)
  return M.update_meta(repo_root, id, function(m)
    m.status = "active"
  end)
end

function M.append_event(repo_root, id, event)
  event.v = event.v or 1
  event.ts = event.ts or util.now_iso()
  util.append_line(transcript_path(repo_root, id), vim.json.encode(event))
end

function M.events(repo_root, id)
  local path = transcript_path(repo_root, id)
  local f = io.open(path, "r")
  if not f then return {} end
  local out = {}
  for line in f:lines() do
    local ok, decoded = pcall(vim.json.decode, line)
    if ok and decoded then table.insert(out, decoded) end
  end
  f:close()
  return out
end

return M
