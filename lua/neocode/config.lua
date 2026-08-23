local M = {}

M.defaults = {
  neocode_dir = ".neocode",
  worktrees_dir = ".worktrees",
  branch_prefix = "orch/",
  default_agent = "opencode",
}

M.options = vim.deepcopy(M.defaults)

function M.setup(opts)
  M.options = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
  return M.options
end

return M
