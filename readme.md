# Neocode

Neocode manages local coding-agent sessions and their Git worktrees from Neovim.

## Commands

- `:NeocodeNew [name]` creates and opens a session. Use `:NeocodeNew!` to work in the current checkout.
- `:NeocodeSessions` opens active sessions.
- `:NeocodeArchive [name]` archives a session.
- `:NeocodeScan` reports the current workspace.
- `:NeocodePalette` opens the command palette.

## Command palette

In **NORMAL** mode, press backtick (`` ` ``) to open the Neocode command palette. This mapping is intentionally NORMAL-mode-only, so a backtick can still be typed normally in INSERT mode and in an agent's terminal prompt.

The palette starts in NORMAL mode:

- `j` / `k` or the arrow keys move the visible selection.
- `Enter` executes the selected command.
- `Escape` (or `q` in NORMAL mode) closes the palette.
- `/` or `i` enters fuzzy-filter editing. In filter/INSERT mode, `j` and `k` are query characters rather than navigation keys; use the arrows to move without leaving the filter. `Escape` closes the palette.
- Click to select a command and double-click to execute it.

The old Command/Ctrl-P palette shortcut is not installed. Colon (`:`) retains its standard Neovim command-line behavior; use the `:Neocode…` commands above when that workflow is preferred.
