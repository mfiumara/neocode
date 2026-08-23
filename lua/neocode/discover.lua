local config = require("neocode.config")
local util = require("neocode.util")
local store = require("neocode.store")

local M = {}

local function is_repo(path)
  return vim.uv.fs_stat(path .. "/.git") ~= nil
end

local function main_root(dir)
  local common = util.git({ "rev-parse", "--git-common-dir" }, dir)
  if common.code == 0 then
    local p = vim.trim(common.stdout)
    if p ~= "" and p ~= ".git" then
      if p:sub(1, 1) == "/" then
        return vim.fs.dirname(p)
      end
      return vim.fs.dirname(vim.fs.normalize(dir .. "/" .. p))
    end
  end
  local top = util.git({ "rev-parse", "--show-toplevel" }, dir)
  if top.code == 0 then
    return vim.trim(top.stdout)
  end
  return nil
end

local function repo_info(root)
  return {
    name = vim.fs.basename(root),
    path = root,
    identity = store.repo_identity(root),
  }
end

local function child_repos(dir)
  local repos = {}
  for name, fs_type in vim.fs.dir(dir) do
    if fs_type == "directory" and not name:match("^%.") and name ~= "node_modules" then
      local candidate = dir .. "/" .. name
      if is_repo(candidate) then
        table.insert(repos, repo_info(candidate))
      end
    end
  end
  table.sort(repos, function(a, b) return a.name < b.name end)
  return repos
end

function M.resolve(dir)
  dir = vim.fs.normalize(dir)
  local root = main_root(dir)
  if root then
    return { kind = "repo", root = root, repos = { repo_info(root) } }
  end
  local repos = child_repos(dir)
  util.json_write(dir .. "/" .. config.options.neocode_dir .. "/workspace.json", {
    version = 1,
    scanned_at = util.now_iso(),
    repos = vim.tbl_map(function(r)
      return { name = r.name, path_rel = r.name, identity = r.identity }
    end, repos),
  })
  return { kind = "folder", root = dir, repos = repos }
end

return M
