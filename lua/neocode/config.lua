local M = {}

M.defaults = {
  neocode_dir = ".neocode",
  worktrees_dir = ".worktrees",
  branch_prefix = "orch/",
  default_agent = "opencode",
  pipeline = {
    commands = {},
    require_commands = true,
    timeout_ms = 300000,
    judge_timeout_ms = 600000,
    output_limit = 262144,
    diff_limit = 2097152,
    main_branch = "main",
    allow_manual_approval = false,
  },
}

M.options = vim.deepcopy(M.defaults)

function M.setup(opts)
  M.options = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
  return M.options
end

return M
