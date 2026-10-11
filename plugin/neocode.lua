if vim.g.loaded_neocode then
  return
end
vim.g.loaded_neocode = true

local function dispatch(fn_name, with_args)
  return function(opts)
    local call_args = {}
    if with_args then
      table.insert(call_args, opts.args ~= "" and opts.args or nil)
      table.insert(call_args, { bang = opts.bang })
    end
    vim.schedule(function()
      local ok, err = pcall(require("neocode")[fn_name], unpack(call_args))
      if not ok then
        vim.notify("[neocode] " .. tostring(err), vim.log.levels.ERROR)
      end
    end)
  end
end

vim.api.nvim_create_user_command("NeocodeNew", dispatch("new", true), { nargs = "?" })
vim.api.nvim_create_user_command("NeocodeSessions", dispatch("sessions"), {})
vim.api.nvim_create_user_command("NeocodeScan", dispatch("scan"), {})

local function pipeline_cmd(action)
  return function(opts)
    vim.schedule(function()
      local ok, err = pcall(function()
        local nc = require("neocode")
        local ws = nc.workspace()
        for _, repo in ipairs(ws.repos) do
          local session = require("neocode.store").find_by_name(repo.path, opts.fargs[1])
          if session then
            local requirements = table.concat(opts.fargs, " ", 2)
            if action == "review" then
              return nc.worker_complete(session.id, true, requirements, repo.path)
            elseif action == "retry" then
              return nc.retry(session.id, requirements, nil, repo.path)
            elseif action == "integrate" then
              return nc.integrate(session.id, nil, repo.path)
            end
          end
        end
        error("no session named '" .. opts.fargs[1] .. "'")
      end)
      if not ok then vim.notify("[neocode] " .. tostring(err), vim.log.levels.ERROR) end
    end)
  end
end

vim.api.nvim_create_user_command("NeocodeReview", pipeline_cmd("review"), { nargs = "+" })
vim.api.nvim_create_user_command("NeocodeRetryReview", pipeline_cmd("retry"), { nargs = "+" })
vim.api.nvim_create_user_command("NeocodeIntegrate", pipeline_cmd("integrate"), { nargs = 1 })

local function archive_cmd(opts)
  vim.schedule(function()
    if opts.args ~= "" then
      local ws
      local name
      local repo_root
      local ok, err = pcall(function()
        ws = require("neocode").workspace()
        for _, repo in ipairs(ws.repos) do
          local s = require("neocode.store").find_by_name(repo.path, opts.args)
          if s and s.status == "active" then
            name = s.name
            repo_root = repo.path
            break
          end
        end
      end)
      if not ok or not name then
        vim.notify("[neocode] no active session named '" .. opts.args .. "'", vim.log.levels.WARN)
        return
      end
      require("neocode").archive(name, repo_root)
    else
      require("neocode").sessions()
    end
  end)
end

vim.api.nvim_create_user_command("NeocodeArchive", archive_cmd, { nargs = "?" })
