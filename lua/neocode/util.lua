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
  local f = assert(io.open(path, "w"))
  f:write(vim.json.encode(data) .. "\n")
  f:close()
end

function M.append_line(path, line)
  local f = assert(io.open(path, "a"))
  f:write(line .. "\n")
  f:close()
end

function M.run(cmd, opts)
  opts = opts or {}
  local r = vim.system(cmd, { cwd = opts.cwd, text = true }):wait()
  return { code = r.code, stdout = r.stdout or "", stderr = r.stderr or "" }
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
