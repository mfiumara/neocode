local config = require("neocode.config")
local util = require("neocode.util")
local store = require("neocode.store")
local worktree = require("neocode.worktree")
local discover = require("neocode.discover")
local agents = require("neocode.agents")
local ui = require("neocode.ui")
local title = require("neocode.title")
local opencode_db = require("neocode.opencode_db")
local pipeline = require("neocode.pipeline")

local M = {}

function M.setup(opts)
  config.setup(opts)
  return M
end

function M.workspace(dir)
  M.last_workspace = discover.resolve(dir or vim.fn.getcwd())
  return M.last_workspace
end

local function pick_repo(ws, cb)
  if ws.kind == "repo" or #ws.repos == 1 then
    return cb(ws.repos[1])
  end
  ui.select(ws.repos, {
    prompt = "Select repo:",
    format_item = function(repo)
      return repo.name
    end,
  }, function(repo)
    if repo then cb(repo) end
  end)
end

local function stop_agent(session)
  pcall(function()
    agents.get(session.agent.kind).stop(session)
  end)
end

function M.open(session, repo_root)
  worktree.ensure_ignored(repo_root)
  local path
  if session.worktree and session.worktree.mode == "local" then
    path = repo_root
  else
    path = worktree.ensure(repo_root, session)
  end
  pcall(vim.api.nvim_set_current_dir, path)
  agents.get(session.agent.kind).start(session, { cwd = path, repo_root = repo_root })
  util.notify("'" .. session.name .. "' -> " .. path)
  return session
end

function M.new(name, opts)
  opts = opts or {}
  local ws = M.workspace()
  pick_repo(ws, function(repo)
    name = name or "session-" .. util.id()
    for _, s in ipairs(store.list(repo.path, "active")) do
      if s.name == name then
        util.notify("active session '" .. name .. "' already exists in " .. repo.name, vim.log.levels.WARN)
        return
      end
    end
    local session = store.create(repo.path, name, { local_mode = opts.bang })
    M.open(session, repo.path)
  end)
end

function M.archive(name, repo_root)
  local session = store.find_by_name(repo_root, name)
  if not session or session.status ~= "active" then
    util.notify("no active session named '" .. name .. "'", vim.log.levels.WARN)
    return
  end
  if session.worktree and session.worktree.mode == "local" then
    store.archive(repo_root, session.id)
    stop_agent(session)
    util.notify("archived '" .. name .. "'")
    return
  end
  local ok, err = worktree.remove(repo_root, session)
  if not ok then
    ui.select({ "force remove", "cancel" }, {
      prompt = "Worktree '" .. name .. "': " .. tostring(err),
    }, function(choice)
      if choice == "force remove" then
        worktree.remove(repo_root, session, { force = true })
        store.archive(repo_root, session.id)
        stop_agent(session)
        util.notify("archived '" .. name .. "' (branch kept)")
      end
    end)
    return
  end
  store.archive(repo_root, session.id)
  stop_agent(session)
  util.notify("archived '" .. name .. "' (branch kept)")
end

local function clip(line, width)
  if vim.fn.strdisplaywidth(line) <= width then return line end
  return vim.fn.strcharpart(line, 0, width - 1) .. "…"
end

local function event_line(ev)
  local text = ev.text or ev.content or ev.message
  if type(text) == "table" then
    text = vim.inspect(text)
  end
  if type(text) == "string" then
    text = (vim.trim(text):gsub("%s+", " "))
  else
    text = nil
  end
  local who
  if ev.role == "user" then
    who = "you"
  elseif ev.role ~= nil or ev.agent ~= nil then
    who = "agent"
  end
  if who and text and text ~= "" then
    return who .. ": " .. text
  end
  if text and text ~= "" then
    return text
  end
  if who then
    return who .. ": (" .. tostring(ev.type or "event") .. ")"
  end
  return (vim.inspect(ev):gsub("%s+", " "))
end

local function transcript_preview(repo_root, id)
  local events = store.events(repo_root, id)
  if #events == 0 then
    return { "(no messages yet)" }
  end
  local width = math.max(40, math.floor(vim.o.columns * 0.5))
  local out = {}
  local first = math.max(1, #events - 19)
  if first > 1 then
    out[#out + 1] = ("(last %d of %d)"):format(#events - first + 1, #events)
  end
  for i = first, #events do
    out[#out + 1] = clip(event_line(events[i]), width)
  end
  return out
end

function M.worker_complete(id, succeeded, requirements, repo_root, opts)
  repo_root = repo_root or M.workspace().repos[1].path
  return pipeline.worker_finished(repo_root, id, succeeded, requirements, opts)
end

function M.review(id, requirements, opts, repo_root)
  repo_root = repo_root or M.workspace().repos[1].path
  return pipeline.review(repo_root, id, requirements, opts)
end

function M.integrate(id, opts, repo_root)
  repo_root = repo_root or M.workspace().repos[1].path
  return pipeline.integrate(repo_root, id, opts)
end

function M.retry(id, requirements, opts, repo_root)
  return M.review(id, requirements, opts, repo_root)
end

function M.manual_approve(id, reason, repo_root)
  repo_root = repo_root or M.workspace().repos[1].path
  return pipeline.manual_approve(repo_root, id, reason)
end

function M.recover(id, repo_root)
  repo_root = repo_root or M.workspace().repos[1].path
  return pipeline.recover(repo_root, id)
end

function M.process_queue(repo_root, opts)
  repo_root = repo_root or M.workspace().repos[1].path
  return pipeline.process_queue(repo_root, opts)
end

function M.sessions()
  local ws = M.workspace()
  local entries = {}
  for _, repo in ipairs(ws.repos) do
    for _, s in ipairs(store.list(repo.path, "active")) do
      local resolved = s.name
      local cached = s.agent and s.agent.title
      if cached and cached ~= "" and cached:match("^session%-") == nil then
        resolved = cached
      else
        pcall(function()
          resolved = title.resolve(s)
          if resolved ~= s.name then
            store.update_meta(repo.path, s.id, function(m)
              m.agent.title = resolved
            end)
          end
        end)
      end
      local state = s.pipeline and s.pipeline.state
      local base_label = resolved ~= s.name and (repo.name .. " · " .. resolved) or (repo.name .. "/" .. s.name)
      table.insert(entries, {
        label = state and (base_label .. " [" .. state .. "]") or base_label,
        session = s,
        repo_root = repo.path,
      })
    end
  end
  if #entries == 0 then
    util.notify("no active sessions in this workspace")
    return
  end
  table.sort(entries, function(a, b) return a.label < b.label end)
  ui.select(entries, {
    prompt = "Sessions:",
    format_item = function(entry)
      return entry.label
    end,
    preview_fn = function(entry)
      local s = entry.session
      local p = s.pipeline
      if p then
        local lines = { "pipeline: " .. tostring(p.state) }
        if p.failure and p.failure ~= vim.NIL then lines[#lines + 1] = "failure: " .. tostring(p.failure) end
        if p.ci then
          lines[#lines + 1] = "pre-review CI: " .. (p.ci.passed and "passed" or "failed")
        end
        if p.post_reconcile_ci then
          lines[#lines + 1] = "post-reconcile CI: " .. (p.post_reconcile_ci.passed and "passed" or "failed")
        end
        if p.judge then
          lines[#lines + 1] = "judge: " .. (p.judge.approved and "approved" or "rejected")
          lines[#lines + 1] = p.judge.summary or ""
        end
        if #lines > 1 then return lines end
      end
      local backend_id = s.agent and s.agent.backend_session_id
      if backend_id then
        local lines = opencode_db.recent_messages(backend_id, 20)
        if #lines > 0 then
          return lines
        end
      end
      return transcript_preview(entry.repo_root, s.id)
    end,
    actions = {
      {
        key = "a",
        desc = "archive session",
        fn = function(entry)
          M.archive(entry.session.name, entry.repo_root)
        end,
      },
      {
        key = "r",
        desc = "retry failed review",
        fn = function(entry)
          local p = entry.session.pipeline or {}
          pipeline.review(entry.repo_root, entry.session.id, p.requirements)
        end,
      },
      {
        key = "i",
        desc = "integrate merge-ready job",
        fn = function(entry)
          pipeline.integrate(entry.repo_root, entry.session.id)
        end,
      },
    },
  }, function(entry)
    if entry then
      M.open(entry.session, entry.repo_root)
    end
  end)
end

function M.scan()
  local ws = M.workspace()
  local names = vim.tbl_map(function(repo)
    return repo.name
  end, ws.repos)
  util.notify(ws.kind .. " workspace: " .. (#names > 0 and table.concat(names, ", ") or "no repos found"))
end

return M
