local M = {}

local PROMPT_BORDER = { "─", "│", "─", "│", "╭", "╮", "─", "─" }
local LIST_BORDER = { "─", "│", "─", "│", "─", "─", "╯", "╰" }
local PREVIEW_BORDER = { "─", "│", "─", "│", "─", "╮", "╯", "╰" }
local PLAIN_BORDER = { "─", "│", "─", "│", "╭", "╮", "╯", "╰" }

local NS = vim.api.nvim_create_namespace("neocode_ui")

local function define_hl(name, fallbacks)
  if vim.fn.hlexists(name) == 1 then return end
  for _, fb in ipairs(fallbacks) do
    if vim.fn.hlexists(fb) == 1 then
      vim.api.nvim_set_hl(0, name, { default = true, link = fb })
      return
    end
  end
end

local function pad(s, width)
  local w = vim.fn.strdisplaywidth(s)
  if w >= width then return s end
  return s .. string.rep(" ", width - w)
end

local function clip(s, width)
  if width <= 0 then return "" end
  if vim.fn.strdisplaywidth(s) <= width then return s end
  return vim.fn.strcharpart(s, 0, math.max(width - 1, 0)) .. "…"
end

local function help_buffer(actions)
  local rows = {
    pad("<CR>", 10) .. "open selection",
    pad("type", 10) .. "fuzzy filter",
    pad("j / k", 10) .. "move down / up",
    pad("<Esc>", 10) .. "back to keys",
  }
  for _, a in ipairs(actions) do
    rows[#rows + 1] = pad(a.key, 10) .. (a.desc or "action")
  end
  rows[#rows + 1] = pad("?", 10) .. "toggle help"
  rows[#rows + 1] = pad("q", 10) .. "close"
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, rows)
  vim.bo[bufnr].modifiable = false
  return bufnr, rows
end

function M.select(items, opts, on_choice)
  opts = opts or {}
  if #items == 0 then
    on_choice(nil)
    return
  end

  define_hl("NeocodeFuzzyMatch", { "TelescopeMatching", "Special" })
  define_hl("NeocodePromptPrefix", { "TelescopePromptPrefix", "Special" })
  define_hl("NeocodeDimText", { "Comment" })

  local actions = opts.actions or {}
  local labels = {}
  local content_width = 0
  for i, item in ipairs(items) do
    labels[i] = tostring(opts.format_item and opts.format_item(item) or item)
    content_width = math.max(content_width, vim.fn.strdisplaywidth(labels[i]))
  end

  local preview_fn = opts.preview_fn
  local has_preview = preview_fn ~= nil

  local list_w, prev_w
  if has_preview then
    local total = math.min(math.max(math.floor(vim.o.columns * 0.7), 84), math.floor(vim.o.columns * 0.92))
    list_w = math.max(30, math.floor(total * 0.44))
    prev_w = math.max(24, total - list_w - 3)
  else
    list_w = math.min(math.max(content_width + 4, 38), math.floor(vim.o.columns * 0.6))
  end
  local total_w = has_preview and (list_w + prev_w + 3) or (list_w + 2)

  local height = math.min(math.max(#items, 8), math.max(6, math.floor(vim.o.lines * 0.5)))
  local total_h = height + 4
  local top = math.floor((vim.o.lines - total_h) / 2)
  local left = math.floor((vim.o.columns - total_w) / 2)

  local title = opts.prompt and clip(opts.prompt, math.max(list_w - 6, 10)) or nil

  local prompt_win, list_win, preview_win
  local prompt_buf = vim.api.nvim_create_buf(false, true)
  local list_buf = vim.api.nvim_create_buf(false, true)
  local preview_buf = has_preview and vim.api.nvim_create_buf(false, true) or nil

  local query = ""
  local view = {}

  local function set_lines(buf, lines)
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
  end

  local function render_list()
    if not vim.api.nvim_buf_is_valid(list_buf) then return end
    vim.api.nvim_buf_clear_namespace(list_buf, NS, 0, -1)
    if #view == 0 then
      set_lines(list_buf, { "  no matches" })
      vim.api.nvim_buf_set_extmark(list_buf, NS, 0, 0, { end_col = 12, hl_group = "NeocodeDimText" })
      return
    end
    local out = {}
    for row, idx in ipairs(view) do
      out[row] = "  " .. clip(labels[idx], list_w - 2)
    end
    set_lines(list_buf, out)
    if query ~= "" then
      local ok, res = pcall(vim.fn.matchfuzzypos, labels, query)
      if ok and type(res) == "table" and type(res[2]) == "table" then
        local row_of, used = {}, {}
        for r, idx in ipairs(view) do row_of[idx] = r end
        for k, matched in ipairs(res[1] or {}) do
          for i, lab in ipairs(labels) do
            if lab == matched and not used[i] then
              used[i] = true
              local r = row_of[i]
              local rendered = r and out[r]
              if rendered then
                for _, p in ipairs(res[2][k] or {}) do
                  local b = vim.fn.byteidx(lab, p)
                  if b and b >= 0 then
                    local nxt = vim.fn.byteidx(lab, p + 1)
                    if not nxt or nxt < 0 then nxt = #lab end
                    local c0, c1 = b + 2, math.min(nxt + 2, #rendered)
                    if c0 < c1 then
                      vim.api.nvim_buf_set_extmark(list_buf, NS, r - 1, c0, {
                        end_col = c1,
                        hl_group = "NeocodeFuzzyMatch",
                      })
                    end
                  end
                end
              end
              break
            end
          end
        end
      end
    end
  end

  local function hovered()
    if #view == 0 or not vim.api.nvim_win_is_valid(list_win) then return nil end
    local cur = vim.api.nvim_win_get_cursor(list_win)[1]
    local idx = view[cur]
    if not idx then return nil end
    return { item = items[idx], label = labels[idx] }
  end

  local function render_preview()
    if not preview_buf or not vim.api.nvim_buf_is_valid(preview_buf) then return end
    local hv = hovered()
    local out = {}
    if hv then
      local ok, res = pcall(preview_fn, hv.item)
      if ok and type(res) == "table" then
        for _, l in ipairs(res) do
          out[#out + 1] = clip(tostring(l), prev_w)
        end
        if #out == 0 then out[1] = "" end
      elseif ok then
        out = { clip(tostring(res), prev_w) }
      else
        out = { "(preview error)" }
      end
    end
    set_lines(preview_buf, out)
    if preview_win and vim.api.nvim_win_is_valid(preview_win) then
      local t = hv and clip(hv.label, math.max(prev_w - 8, 8)) or "Preview"
      pcall(vim.api.nvim_win_set_config, preview_win, { title = " " .. t .. " ", title_pos = "center" })
    end
  end

  local function apply_filter()
    view = {}
    if query == "" then
      for i in ipairs(items) do
        view[#view + 1] = i
      end
    else
      local ok, res = pcall(vim.fn.matchfuzzy, labels, query)
      if ok and type(res) == "table" then
        local used = {}
        for _, matched in ipairs(res) do
          for i, lab in ipairs(labels) do
            if lab == matched and not used[i] then
              used[i] = true
              view[#view + 1] = i
              break
            end
          end
        end
      end
    end
    render_list()
    if vim.api.nvim_win_is_valid(list_win) then
      pcall(vim.api.nvim_win_set_cursor, list_win, { 1, 0 })
    end
    render_preview()
  end

  local function move(delta)
    if #view == 0 or not vim.api.nvim_win_is_valid(list_win) then return end
    local cur = vim.api.nvim_win_get_cursor(list_win)[1]
    cur = math.min(math.max(cur + delta, 1), #view)
    vim.api.nvim_win_set_cursor(list_win, { cur, 0 })
    render_preview()
  end

  local finished = false
  local augroup = vim.api.nvim_create_augroup("", { clear = true })

  local help_state = { win = nil, buf = nil, ns = nil }

  local function close_help()
    if help_state.ns then
      vim.on_key(nil, help_state.ns)
      help_state.ns = nil
    end
    if help_state.win and vim.api.nvim_win_is_valid(help_state.win) then
      pcall(vim.api.nvim_win_close, help_state.win, true)
    end
    if help_state.buf and vim.api.nvim_buf_is_valid(help_state.buf) then
      pcall(vim.api.nvim_buf_delete, help_state.buf, { force = true })
    end
    help_state.win = nil
    help_state.buf = nil
  end

  local function finish(choice)
    if finished then return end
    finished = true
    close_help()
    pcall(vim.api.nvim_clear_autocmds, { group = augroup })
    for _, w in ipairs({ preview_win, list_win }) do
      if w and vim.api.nvim_win_is_valid(w) then
        pcall(vim.api.nvim_win_close, w, true)
      end
    end
    for _, b in ipairs({ preview_buf, list_buf }) do
      if b and vim.api.nvim_buf_is_valid(b) then
        pcall(vim.api.nvim_buf_delete, b, { force = true })
      end
    end
    if vim.api.nvim_win_is_valid(prompt_win) then
      pcall(vim.api.nvim_win_close, prompt_win, true)
    end
    if vim.api.nvim_buf_is_valid(prompt_buf) then
      pcall(vim.api.nvim_buf_delete, prompt_buf, { force = true })
    end
    on_choice(choice)
  end

  local function pick()
    local hv = hovered()
    finish(hv and hv.item or nil)
  end

  local function toggle_help()
    if help_state.win then
      close_help()
      return
    end
    local hbuf, rows = help_buffer(actions)
    local hw = 0
    for _, r in ipairs(rows) do
      hw = math.max(hw, vim.fn.strdisplaywidth(r))
    end
    help_state.win = vim.api.nvim_open_win(hbuf, false, {
      relative = "editor",
      row = math.floor((vim.o.lines - #rows) / 2),
      col = math.floor((vim.o.columns - (hw + 4)) / 2),
      width = hw + 4,
      height = #rows,
      style = "minimal",
      border = PLAIN_BORDER,
      title = " Mappings ",
      title_pos = "center",
      focusable = false,
      zindex = 200,
    })
    help_state.buf = hbuf
    local ns = vim.api.nvim_create_namespace("")
    help_state.ns = ns
    vim.on_key(function(key)
      if key and key:byte() == 128 then return end
      close_help()
    end, ns)
  end

  local function map(modes, lhs, rhs)
    vim.keymap.set(modes, lhs, rhs, { buffer = prompt_buf, silent = true, nowait = true })
  end

  map("n", "<CR>", pick)
  map("n", "q", function() finish(nil) end)
  map("n", "<Esc>", function() finish(nil) end)
  map("n", "?", toggle_help)
  map("n", "j", function() move(1) end)
  map("n", "k", function() move(-1) end)
  map({ "n", "i" }, "<Down>", function() move(1) end)
  map({ "n", "i" }, "<Up>", function() move(-1) end)
  map("i", "<CR>", pick)
  for _, a in ipairs(actions) do
    map("n", a.key, function()
      local hv = hovered()
      local ok, err = pcall(a.fn, hv and hv.item or nil)
      finish(nil)
      if not ok then error(err) end
    end)
  end

  prompt_win = vim.api.nvim_open_win(prompt_buf, true, {
    relative = "editor",
    row = top + 1,
    col = left + 1,
    width = list_w,
    height = 1,
    style = "minimal",
    border = PROMPT_BORDER,
    title = title and (" " .. title .. " ") or nil,
    title_pos = "center",
    zindex = 60,
  })
  vim.wo[prompt_win].winblend = 8

  list_win = vim.api.nvim_open_win(list_buf, false, {
    relative = "editor",
    row = top + 3,
    col = left + 1,
    width = list_w,
    height = height,
    style = "minimal",
    border = LIST_BORDER,
    zindex = 61,
  })
  vim.wo[list_win].winblend = 8
  vim.wo[list_win].cursorline = true

  if has_preview then
    preview_win = vim.api.nvim_open_win(preview_buf, false, {
      relative = "editor",
      row = top + 1,
      col = left + list_w + 2,
      width = prev_w,
      height = height + 2,
      style = "minimal",
      border = PREVIEW_BORDER,
      title = " Preview ",
      title_pos = "center",
      focusable = false,
      zindex = 62,
    })
    vim.wo[preview_win].wrap = false
    vim.wo[preview_win].winblend = 8
  end

  vim.api.nvim_buf_set_extmark(prompt_buf, NS, 0, 0, {
    id = 1,
    virt_text = { { "> ", "NeocodePromptPrefix" } },
    virt_text_pos = "inline",
    right_gravity = false,
  })

  vim.api.nvim_create_autocmd({ "TextChangedI", "TextChanged" }, {
    group = augroup,
    buffer = prompt_buf,
    callback = function()
      if not vim.api.nvim_buf_is_valid(prompt_buf) then return end
      query = vim.trim(vim.api.nvim_buf_get_lines(prompt_buf, 0, 1, false)[1] or "")
      apply_filter()
    end,
  })

  if has_preview then
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorHold" }, {
      group = augroup,
      buffer = list_buf,
      callback = render_preview,
    })
  end

  vim.api.nvim_create_autocmd("WinClosed", {
    group = augroup,
    pattern = tostring(prompt_win),
    once = true,
    callback = function() finish(nil) end,
  })

  apply_filter()
  vim.cmd("startinsert")
end

return M
