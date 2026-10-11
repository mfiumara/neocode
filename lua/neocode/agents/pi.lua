local util = require("neocode.util")

local M = {}
local coordinators = {}

-- The server owns the Pi process.  Keeping this adapter against its request API
-- means model changes affect the existing coordinator (and its delegated
-- workers), rather than spawning a second, cosmetic Pi process.
function M.bind(session, coordinator)
  assert(session and session.id, "session is required")
  assert(coordinator and type(coordinator.request) == "function", "coordinator.request is required")
  coordinators[session.id] = coordinator
end

function M.unbind(session)
  if session then coordinators[session.id] = nil end
end

local function request(session, command, cb)
  local coordinator = session and coordinators[session.id]
  if not coordinator then
    cb(nil, "live Pi coordinator is not connected")
    return
  end
  local called = false
  local function done(response, err)
    if called then return end
    called = true
    if err then cb(nil, err) return end
    if type(response) ~= "table" then cb(nil, "invalid response from Pi") return end
    if response.success == false then cb(nil, response.error or "Pi request failed") return end
    cb(response.data or response)
  end
  local ok, result = pcall(coordinator.request, coordinator, command, done)
  if not ok then done(nil, result) return end
  -- Also accept synchronous server implementations, which is convenient for
  -- embedders and tests. Async implementations may return nil or a request id.
  if type(result) == "table" then done(result) end
end

function M.list_models(session, cb)
  request(session, { type = "get_available_models" }, function(data, err)
    if err then cb(nil, err) return end
    cb(type(data.models) == "table" and data.models or data)
  end)
end

function M.get_model(session, cb)
  request(session, { type = "get_state" }, function(data, err)
    if err then cb(nil, err) return end
    cb(data.model)
  end)
end

function M.set_model(session, model, cb)
  request(session, {
    type = "set_model",
    provider = model.provider,
    modelId = model.id,
  }, function(data, err)
    if err then cb(nil, err) return end
    local actual = data.model or data
    if actual.provider ~= model.provider or (actual.id or actual.modelId) ~= model.id then
      cb(nil, "Pi confirmed a different model")
      return
    end
    cb(actual)
  end)
end

-- Coordinator lifecycle is supplied by the Neocode server. These methods keep
-- the adapter contract explicit and produce actionable errors if used alone.
function M.start(session, ctx)
  if ctx and ctx.coordinator then M.bind(session, ctx.coordinator) end
  if not coordinators[session.id] then
    util.notify("cannot open Pi session: coordinator is not connected", vim.log.levels.ERROR)
    return nil
  end
  return ctx and ctx.bufnr or nil
end

function M.stop(session)
  M.unbind(session)
end

function M.is_running(session)
  return coordinators[session.id] ~= nil
end

return M
