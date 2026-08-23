local M = {}

M.registry = {
  opencode = "neocode.agents.opencode",
}

function M.get(kind)
  local path = M.registry[kind]
  if not path then
    error("unknown agent kind: " .. tostring(kind))
  end
  return require(path)
end

function M.register(kind, module_path)
  M.registry[kind] = module_path
end

return M
