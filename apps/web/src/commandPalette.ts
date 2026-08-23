export interface CommandPaletteShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** The conventional global shortcut; backtick remains a NORMAL-mode binding. */
export function isCommandPaletteShortcut(event: CommandPaletteShortcutEvent): boolean {
  return (event.ctrlKey || event.metaKey)
    && !event.altKey
    && event.key.toLowerCase() === "k";
}

export function isNormalModeCommandPaletteShortcut(key: string): boolean {
  return key === "`" || key === ":";
}
