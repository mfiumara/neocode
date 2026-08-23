local util = require("neocode.util")
local store = require("neocode.store")

local M = {}

local running = {}

local function db_path()
  local data = os.getenv("XDG_DATA_HOME") or (os.getenv("HOME") or "") .. "/.local/share"
  return data .. "/opencode/opencode.db"
end

local function backend_sessions(cwd)
  local db = db_path()
  if not vim.uv.fs_stat(db) then return nil end
  local dir = cwd:gsub("'", "''")
  local r = util.run({
    "sqlite3",
    "-json",
    db,
    "select id, time_created from session"
      .. " where directory = '" .. dir .. "' and parent_id is null"
      .. " order by time_created desc",
  })
  if r.code ~= 0 or vim.trim(r.stdout) == "" then return nil end
  local ok, decoded = pcall(vim.json.decode, r.stdout)
  if not ok or type(decoded) ~= "table" then return nil end
  return decoded
end

local function snapshot(cwd)
  local rows = backend_sessions(cwd)
  if not rows then return nil end
  local ids = {}
  for _, row in ipairs(rows) do
    ids[row.id] = true
  end
  return { ids = ids }
end

local function newest_backend_session(cwd, before, started_at)
  local rows = backend_sessions(cwd)
  if not rows then return nil end
  local best, best_time = nil, 0
  for _, row in ipairs(rows) do
    local created = row.time_created or 0
    local fresh = (before and not before.ids[row.id]) or (not before and created > started_at)
    if fresh and (not best or created > best_time) then
      best = row.id
      best_time = created
    end
  end
  return best
end

local function remember(session, ctx, cwd, before, started_at)
  local id = newest_backend_session(cwd, before, started_at)
  if not id then
    util.notify("could not discover opencode session id for '" .. session.name .. "'", vim.log.levels.WARN)
    return
  end
  session.agent.backend_session_id = id
  if ctx.repo_root then
    pcall(store.update_meta, ctx.repo_root, session.id, function(m)
      m.agent.backend_session_id = id
    end)
  end
end

local function focus(bufnr)
  local wins = vim.fn.win_findbuf(bufnr)
  if #wins > 0 then
    vim.api.nvim_set_current_win(wins[1])
  else
    vim.api.nvim_set_current_buf(bufnr)
  end
end

function M.is_running(session)
  local st = running[session.id]
  return st ~= nil and vim.api.nvim_buf_is_valid(st.bufnr) and vim.fn.bufexists(st.bufnr) == 1
end

function M.show(session)
  local st = running[session.id]
  if not st or not vim.api.nvim_buf_is_valid(st.bufnr) then
    return nil
  end
  focus(st.bufnr)
  if vim.bo[st.bufnr].buftype == "terminal" then
    vim.cmd("startinsert")
  end
  return st.bufnr
end

function M.start(session, ctx)
  ctx = ctx or {}
  if M.is_running(session) then
    return M.show(session)
  end
  local cwd = ctx.cwd or error("opencode adapter needs ctx.cwd")
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.bo[bufnr].bufhidden = "hide"
  local name = vim.fs.basename(cwd) .. " ~ opencode"
  vim.api.nvim_buf_set_name(bufnr, name)
  vim.api.nvim_set_current_buf(bufnr)
  local cmd = { "opencode" }
  local fresh = session.agent.backend_session_id == nil
  local before, started_at
  if not fresh then
    table.insert(cmd, "--session")
    table.insert(cmd, session.agent.backend_session_id)
  else
    before = snapshot(cwd)
    started_at = os.time() * 1000 - 5000
  end
  local job_id = vim.fn.jobstart(cmd, {
    cwd = cwd,
    term = true,
    on_exit = function(_, code)
      running[session.id] = nil
      if code ~= 0 and code ~= 143 then
        util.notify("opencode exited with code " .. code, vim.log.levels.WARN)
        return
      end
      if fresh then
        remember(session, ctx, cwd, before, started_at)
      end
    end,
  })
  if not job_id or job_id <= 0 then
    pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
    util.notify("failed to start opencode", vim.log.levels.ERROR)
    return nil
  end
  running[session.id] = { bufnr = bufnr }
  vim.cmd("startinsert")
  return bufnr
end

function M.stop(session)
  local st = running[session.id]
  if not st then return end
  if vim.api.nvim_buf_is_valid(st.bufnr) then
    local chan = vim.api.nvim_get_option_value("channel", { buf = st.bufnr })
    if chan and chan > 0 then
      pcall(vim.fn.jobstop, chan)
    end
    vim.api.nvim_buf_delete(st.bufnr, { force = true })
  end
  running[session.id] = nil
end

return M
