# Neocode

A live, read-only map of this repository's branches and worktrees.

```sh
npm start
```

Open <http://localhost:4173>. No install step or dependencies.

To inspect another repository:

```sh
REPO=/path/to/repository npm start
```

## Navigation

- `h` parent
- `j` / `k` next / previous node
- `l` first child
- `gg` root, `G` last node
- `/` search, `n` next match
- `w` show only worktrees
- `r` refresh
- `?` shortcuts

Branch ancestry is inferred from the Git commit graph. Git records commit authors—not who pushed a branch—so the displayed person is the branch tip's author.
