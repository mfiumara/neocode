# Neocode

A live visual control plane for Paseo projects, workspaces, and agent sessions.

```sh
npm start
```

Open <http://localhost:4173>. Neocode uses the local `paseo` CLI and has no install step or dependencies.

Choose a project from the auto-hiding sidebar, then select an agent to view its recent activity, follow its live status, or send a prompt. New Paseo workspaces, sessions, and status changes appear automatically. Click outside the agent panel to return to the overview. Parent-child agent relationships are shown when Paseo records them; otherwise agents attach to the workspace matching their working directory.

## Navigation

- `j` / `k` next / previous agent
- `enter` open or focus the prompt; `shift+enter` inserts a newline
- `esc` leaves the prompt for navigation; press it again for the overview (`q` also closes)
- `a` create an agent in the selected workspace
- `A` create an agent in a fresh worktree workspace
- `h` parent, `l` first child
- `gg` root, `G` last node
- `/` search, `n` next match
- `cmd+k` / `ctrl+k` command palette
- `r` refresh, `?` shortcuts
