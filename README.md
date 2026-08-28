# Neocode

A live visual control plane for Paseo projects, workspaces, and agent sessions.

```sh
npm start
```

Open <http://localhost:4173>. Neocode uses the local `paseo` CLI and has no install step or dependencies.

Choose a project from the auto-hiding sidebar, then select an agent to view its recent activity, follow its live status, or send a prompt. Click outside the agent panel to return to the overview. Parent-child agent relationships are shown when Paseo records them; otherwise agents attach to the workspace matching their working directory.

## Navigation

- `h` parent
- `j` / `k` next / previous node
- `l` first child
- `gg` root, `G` last node
- `/` search, `n` next match
- `enter` open agent
- `q` / `esc` close agent
- `r` refresh
- `?` shortcuts
