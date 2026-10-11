local M = {}

function M.notify(msg, level)
  vim.notify("[neocode] " .. msg, level or vim.log.levels.INFO)
end

function M.json_read(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  if not data or data == "" then return nil end
  local ok, decoded = pcall(vim.json.decode, data)
  if not ok then return nil end
  return decoded
end

function M.json_write(path, data)
  vim.fn.mkdir(vim.fs.dirname(path), "p")
  -- Write/rename keeps persisted state readable if Neovim is interrupted mid-transition.
  local tmp = path .. ".tmp-" .. M.id()
  local f = assert(io.open(tmp, "w"))
  f:write(vim.json.encode(data) .. "\n")
  f:close()
  assert(os.rename(tmp, path))
end

function M.append_line(path, line)
  local f = assert(io.open(path, "a"))
  f:write(line .. "\n")
  f:close()
end

function M.run(cmd, opts)
  opts = opts or {}
  local limit = opts.output_limit or (1024 * 1024)
  local proc = vim.system(cmd, { cwd = opts.cwd, env = opts.env, text = true })
  local r = proc:wait(opts.timeout or 120000)
  if not r then
    pcall(proc.kill, proc, 15)
    r = proc:wait(1000) or { code = 124, stdout = "", stderr = "command timed out" }
  end
  local function bounded(s)
    s = s or ""
    if #s <= limit then return s, false end
    return s:sub(1, limit) .. "\n[output truncated]", true
  end
  local stdout, out_truncated = bounded(r.stdout)
  local stderr, err_truncated = bounded(r.stderr)
  return {
    code = r.code or 124,
    signal = r.signal,
    stdout = stdout,
    stderr = stderr,
    timed_out = r.code == 124 or r.signal == 15,
    truncated = out_truncated or err_truncated,
  }
end

function M.git(args, cwd)
  return M.run({ "git", unpack(args) }, { cwd = cwd })
end

function M.id()
  return string.format("%x%04x", os.time(), math.random(0, 0xffff))
end

function M.now_iso()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

return M
