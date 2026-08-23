local util = require("neocode.util")

local M = {}

local function db_path(override)
  if override then return override end
  local data = vim.env.XDG_DATA_HOME
  if not data or data == "" then
    data = vim.fn.expand("~/.local/share")
  end
  return data .. "/opencode/opencode.db"
end

local function sql_quote(value)
  return "'" .. value:gsub("'", "''") .. "'"
end

local function lookup(db, id)
  local r = util.run({ "sqlite3", "-json", db, "select title from session where id = " .. sql_quote(id) })
  if r.code ~= 0 then return nil end
  local ok, decoded = pcall(vim.json.decode, r.stdout)
  if not ok or type(decoded) ~= "table" or #decoded == 0 then return nil end
  local t = decoded[1].title
  if type(t) ~= "string" then return nil end
  t = vim.trim(t)
  if t == "" then return nil end
  return t
end

function M.resolve(meta, db)
  local name = (meta and meta.name) or ""
  local ok, res = pcall(function()
    local id = meta and meta.agent and meta.agent.backend_session_id
    if not id or id == "" then return nil end
    return lookup(db_path(db), id)
  end)
  if ok and res then return res end
  return name
end

return M
