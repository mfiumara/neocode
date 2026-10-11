local agents = require("neocode.agents")
local store = require("neocode.store")
local ui = require("neocode.ui")
local util = require("neocode.util")

local M = {}

local current

local function model_key(model)
  if not model then return nil end
  local provider = model.provider
  local id = model.id or model.modelId or model.model
  if type(provider) ~= "string" or provider == "" or type(id) ~= "string" or id == "" then
    return nil
  end
  return provider .. "/" .. id
end

function M.label(model)
  return model_key(model) or "unavailable"
end

function M.normalize(models)
  local out, seen = {}, {}
  for _, raw in ipairs(type(models) == "table" and models or {}) do
    local key = type(raw) == "table" and model_key(raw) or nil
    if key and not seen[key] then
      seen[key] = true
      out[#out + 1] = {
        provider = raw.provider,
        id = raw.id or raw.modelId or raw.model,
        contextWindow = raw.contextWindow,
        reasoning = raw.reasoning,
      }
    end
  end
  table.sort(out, function(a, b) return model_key(a) < model_key(b) end)
  return out
end

local function fail(prefix, err)
  util.notify(prefix .. ": " .. tostring(err or "unknown runtime error"), vim.log.levels.ERROR)
end

local function redraw()
  if not current or not current.bufnr or not vim.api.nvim_buf_is_valid(current.bufnr) then return end
  local label = M.label(current.session.agent and current.session.agent.model)
  vim.b[current.bufnr].neocode_model = label
  -- The winbar remains visible while the prompt is active.  The buffer-local key
  -- is also useful in terminals where statusline mouse handling is unavailable.
  local safe_label = label:gsub("%%", "%%%%")
  for _, win in ipairs(vim.fn.win_findbuf(current.bufnr)) do
    vim.api.nvim_set_option_value("winbar", "%@v:lua.NeocodeModelPicker@ Neocode  Model: " .. safe_label
      .. "  (click or <leader>m) %X", { win = win })
  end
end

_G.NeocodeModelPicker = function()
  M.pick()
end

function M.attach(session, repo_root, bufnr)
  current = { session = session, repo_root = repo_root, bufnr = bufnr }
  if bufnr and vim.api.nvim_buf_is_valid(bufnr) then
    vim.keymap.set({ "n", "t" }, "<leader>m", function() M.pick() end, {
      buffer = bufnr,
      desc = "Select Neocode model",
      silent = true,
    })
  end
  redraw()

  local adapter = agents.get(session.agent.kind)
  if type(adapter.get_model) == "function" then
    adapter.get_model(session, function(active, err)
      if err then
        fail("could not determine active Pi model", err)
        return
      end
      if not model_key(active) then
        fail("could not determine active Pi model", "runtime returned an invalid model")
        return
      end
      session.agent.model = { provider = active.provider, id = active.id or active.modelId or active.model }
      if repo_root then
        pcall(store.update_meta, repo_root, session.id, function(meta)
          meta.agent.model = vim.deepcopy(session.agent.model)
        end)
      end
      redraw()
    end)
  end
end

function M.current()
  return current
end

function M.pick(target)
  target = target or current
  if not target or not target.session then
    fail("cannot select model", "no live coordinator")
    return
  end
  local session = target.session
  local adapter = agents.get(session.agent.kind)
  if type(adapter.list_models) ~= "function" or type(adapter.set_model) ~= "function" then
    fail("model selection unavailable", "the active agent does not expose model APIs")
    return
  end

  adapter.list_models(session, function(models, err)
    if err then fail("could not load models from Pi", err) return end
    models = M.normalize(models)
    if #models == 0 then
      fail("model selection unavailable", "Pi reported no available models")
      return
    end
    ui.select(models, {
      prompt = "Model (active: " .. M.label(session.agent.model) .. "):",
      format_item = function(item)
        local selected = model_key(item) == model_key(session.agent.model)
        return (selected and "● " or "  ") .. model_key(item)
      end,
      preview_fn = function(item)
        return {
          "Provider: " .. item.provider,
          "Model: " .. item.id,
          item.contextWindow and ("Context: " .. tostring(item.contextWindow)) or "",
          item.reasoning == nil and "" or ("Reasoning: " .. (item.reasoning and "supported" or "not supported")),
        }
      end,
    }, function(choice)
      if not choice or model_key(choice) == model_key(session.agent.model) then return end
      adapter.set_model(session, choice, function(applied, set_err)
        if set_err or not applied then
          fail("Pi rejected model " .. model_key(choice), set_err or "runtime did not confirm the change")
          return
        end
        -- Persist only after the live runtime confirms the switch. This avoids
        -- displaying a cosmetic selection that the coordinator is not using.
        session.agent.model = { provider = choice.provider, id = choice.id }
        if target.repo_root then
          local ok, persisted = pcall(store.update_meta, target.repo_root, session.id, function(meta)
            meta.agent.model = vim.deepcopy(session.agent.model)
          end)
          if not ok then
            fail("model changed but could not be persisted", persisted)
          end
        end
        redraw()
        util.notify("active model: " .. model_key(choice))
      end)
    end)
  end)
end

-- Worker creation code can use this without knowing about model variants or
-- effort. Those remain separate fields in agent state.
function M.inherit(parent, child)
  if parent and parent.agent and parent.agent.model and child and child.agent then
    child.agent.model = vim.deepcopy(parent.agent.model)
  end
  return child
end

return M
