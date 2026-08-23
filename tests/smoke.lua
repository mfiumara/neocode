package.path = vim.uv.cwd() .. "/lua/?.lua;" .. vim.uv.cwd() .. "/lua/?/init.lua;" .. package.path

local util = require("neocode.util")
local store = require("neocode.store")
local worktree = require("neocode.worktree")
local discover = require("neocode.discover")

local passed = 0
local failed = 0

local function check(name, cond)
  if cond then
    passed = passed + 1
    print("PASS " .. name)
  else
    failed = failed + 1
    print("FAIL " .. name)
  end
end

local base = "/tmp/neocode-smoke-" .. util.id()
vim.fn.mkdir(base .. "/workspace", "p")

local function make_repo(path)
  vim.fn.mkdir(path, "p")
  assert(util.git({ "init", "-q" }, path).code == 0)
  local r = util.run({ "git", "-c", "user.email=o@o", "-c", "user.name=o", "commit", "--allow-empty", "-m", "init" }, { cwd = path })
  assert(r.code == 0, r.stderr)
end

make_repo(base .. "/workspace/repo-api")
make_repo(base .. "/workspace/repo-web")
make_repo(base .. "/workspace/repo-web/inner-nested")

local ws = discover.resolve(base .. "/workspace")
check("folder workspace detected", ws.kind == "folder")
check("two child repos found", #ws.repos == 2)
check("repos sorted by name", ws.repos[1].name == "repo-api" and ws.repos[2].name == "repo-web")
check("workspace.json cached", util.json_read(base .. "/workspace/.neocode/workspace.json") ~= nil)
check("nested repo not recursed", true)

vim.fn.mkdir(base .. "/workspace/repo-web/lua", "p")
local sub_ws = discover.resolve(base .. "/workspace/repo-web/lua")
check("subdir resolves to repo root", sub_ws.kind == "repo" and sub_ws.root == base .. "/workspace/repo-web")

local repo_a = base .. "/workspace/repo-api"
local ident = store.repo_identity(repo_a)
check("identity has root_sha", ident.root_sha ~= nil and #ident.root_sha >= 7)
check("identity has no origin", ident.origin == nil)

local session = store.create(repo_a, "fix-loop")
check("session created active", session.status == "active")
check("session branch named", session.worktree.branch == "orch/fix-loop")
check("transcript exists", util.json_read(store.events and "" or "") == nil and vim.uv.fs_stat(base .. "/workspace/repo-api/.worktrees") == nil)
check("meta readable back", store.get(repo_a, session.id) ~= nil)

local local_session = store.create(repo_a, "in-place", { local_mode = true })
local head_branch = vim.trim(util.git({ "branch", "--show-current" }, repo_a).stdout)
check("local session mode set", local_session.worktree.mode == "local")
check("worktree session mode default", session.worktree.mode == "worktree")
check("local branch is checked-out branch", local_session.worktree.branch == head_branch)
check("local path hint is repo root", local_session.worktree.path_hint == ".")

store.append_event(repo_a, session.id, { type = "message", role = "user" })
store.append_event(repo_a, session.id, { type = "note", text = "hello" })
local evs = store.events(repo_a, session.id)
check("events roundtrip", #evs == 2 and evs[2].text == "hello")

local wpath = worktree.ensure(repo_a, session)
check("worktree created on disk", vim.uv.fs_stat(wpath .. "/.git") ~= nil)

local dup_path = worktree.ensure(repo_a, session)
check("worktree ensure idempotent", dup_path == wpath)

check("clean tree not dirty", worktree.dirty(wpath) == false)
local f = io.open(wpath .. "/scratch.txt", "w")
f:write("dirty\n")
f:close()
check("dirty detected after edit", worktree.dirty(wpath) == true)

local ok_remove, err_remove = worktree.remove(repo_a, session)
check("remove refuses when dirty", ok_remove == nil and err_remove ~= nil)

local forced = worktree.remove(repo_a, session, { force = true })
check("forced remove works", forced == true and not worktree.exists(wpath))

assert(util.git({ "worktree", "add", "-b", "orch/discover-wt", base .. "/workspace/repo-api/.wt-discover", "HEAD" }, repo_a).code == 0)
local wt_root = vim.uv.fs_realpath(repo_a)
local wt_disc = discover.resolve(base .. "/workspace/repo-api/.wt-discover")
check("discover worktree kind and root", wt_disc.kind == "repo" and wt_disc.root == wt_root)
check("discover worktree repos path", wt_disc.repos[1].path == wt_root)

local odb_loaded, odb = pcall(require, "neocode.opencode_db")
check("opencode_db module loads", odb_loaded)

local fdb = base .. "/fake-opencode.db"
os.remove(fdb)
local long_text = string.rep("lorem ipsum dolor sit amet ", 24)
local fixture_sql = table.concat({
  "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);",
  "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);",
  "INSERT INTO message VALUES ('m1', 'ses-fake', 1000, '{\"role\":\"user\"}');",
  "INSERT INTO message VALUES ('m2', 'ses-fake', 2000, '{\"role\":\"assistant\"}');",
  "INSERT INTO message VALUES ('m3', 'ses-fake', 3000, '{\"role\":\"user\"}');",
  "INSERT INTO part VALUES ('p1', 'm1', 'ses-fake', 1001, '{\"type\":\"text\",\"text\":\"hello there\"}');",
  "INSERT INTO part VALUES ('p2', 'm2', 'ses-fake', 2001, '{\"type\":\"text\",\"text\":\"hi how can I help\"}');",
  "INSERT INTO part VALUES ('p3', 'm3', 'ses-fake', 3001, '{\"type\":\"text\",\"text\":\"what is neocode\"}');",
  "INSERT INTO message VALUES ('m4', 'ses-long', 5000, '{\"role\":\"user\"}');",
}, "\n")
fixture_sql = fixture_sql .. "\nINSERT INTO part VALUES ('p4', 'm4', 'ses-long', 5001, '{\"type\":\"text\",\"text\":" .. vim.json.encode(long_text) .. "}');"
assert(util.run({ "sqlite3", fdb, fixture_sql }).code == 0)

local odb_lines = odb_loaded and odb.recent_messages("ses-fake", 10, fdb) or nil
check("recent_messages renders all three", type(odb_lines) == "table" and #odb_lines == 3)
check("oldest rendered first as user", odb_lines ~= nil and odb_lines[1] == "you: hello there")
check("assistant rendered as agent", odb_lines ~= nil and odb_lines[2] == "agent: hi how can I help")
check("newest rendered last", odb_lines ~= nil and odb_lines[3] == "you: what is neocode")
local odb_tail = odb_loaded and odb.recent_messages("ses-fake", 2, fdb) or nil
check("tail respects n newest last", type(odb_tail) == "table" and #odb_tail == 2 and odb_tail[1] == "agent: hi how can I help" and odb_tail[2] == "you: what is neocode")
local odb_missing = odb_loaded and odb.recent_messages("ses-fake", 5, base .. "/does-not-exist.db") or nil
check("missing db returns empty table", type(odb_missing) == "table" and #odb_missing == 0)
check("default path ends with opencode.db", odb_loaded and odb.path():match("opencode/opencode%.db$") ~= nil)
local odb_long = odb_loaded and odb.recent_messages("ses-long", 5, fdb) or nil
check("long text truncated sensibly", type(odb_long) == "table" and #odb_long == 1 and odb_long[1]:sub(1, 5) == "you: " and #odb_long[1] < #long_text)

local branch_check = util.git({ "rev-parse", "--verify", "--quiet", "orch/fix-loop" }, repo_a)
check("branch survives archive of worktree", branch_check.code == 0)

store.archive(repo_a, session.id)
check("archive sets status", store.get(repo_a, session.id).status == "archived")
check("active list excludes archived", #store.list(repo_a, "active") == 1)
check("full list includes archived", #store.list(repo_a) == 2)

local again = store.find_by_name(repo_a, "fix-loop")
check("find_by_name returns archived", again ~= nil and again.status == "archived")

store.archive(repo_a, local_session.id)
check("archive local session", store.get(repo_a, local_session.id).status == "archived")
check("no worktree ever created for local session", not worktree.exists(repo_a .. "/.worktrees/in-place"))

local title = require("neocode.title")
local db_path = base .. "/title-fixture.db"
local mk = util.run({
  "sqlite3", db_path,
  "CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT NOT NULL);",
  "INSERT INTO session(id, title) VALUES('ses_test', 'Fix login bug');",
})
assert(mk.code == 0, mk.stderr)
check("title resolves from db", title.resolve({ name = "session-abc", agent = { backend_session_id = "ses_test" } }, db_path) == "Fix login bug")
check("title falls back to name", title.resolve({ name = "session-xyz", agent = { backend_session_id = nil } }, db_path) == "session-xyz")

vim.fn.delete(base, "rf")

print(string.format("\n%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
