local util = require("neocode.util")

local M = {}

M.default_db = nil

function M.path(db)
  if db then return db end
  if M.default_db then return M.default_db end
  local data = os.getenv("XDG_DATA_HOME") or (os.getenv("HOME") or "") .. "/.local/share"
  return data .. "/opencode/opencode.db"
end

local function clip(text, max)
  if vim.fn.strdisplaywidth(text) <= max then return text end
  return vim.fn.strcharpart(text, 0, max - 1) .. "…"
end

function M.recent_messages(session_id, n, db)
  local ok, lines = pcall(function()
    local path = M.path(db)
    if not vim.uv.fs_stat(path) then return {} end
    local sid = tostring(session_id):gsub("'", "''")
    local sql = "select json_extract(m.data, '$.role') as role,"
      .. " json_extract(p.data, '$.text') as text"
      .. " from message m join part p on p.message_id = m.id"
      .. " where m.session_id = '" .. sid .. "'"
      .. " and json_extract(p.data, '$.type') = 'text'"
      .. " order by m.time_created, m.id, p.time_created, p.id"
    local r = util.run({ "sqlite3", "-json", path, sql })
    if r.code ~= 0 or vim.trim(r.stdout) == "" then return {} end
    local ok_json, rows = pcall(vim.json.decode, r.stdout)
    if not ok_json or type(rows) ~= "table" then return {} end
    local out = {}
    for _, row in ipairs(rows) do
      if type(row.text) == "string" and vim.trim(row.text) ~= "" then
        out[#out + 1] = {
          role = row.role,
          text = vim.trim((row.text:gsub("%s+", " "))),
        }
      end
    end
    local limit = math.max(1, n or 20)
    local first = math.max(1, #out - limit + 1)
    local rendered = {}
    for i = first, #out do
      rendered[#rendered + 1] = (out[i].role == "user" and "you: " or "agent: ")
        .. clip(out[i].text, 160)
    end
    return rendered
  end)
  if not ok or type(lines) ~= "table" then return {} end
  return lines
end

return M
