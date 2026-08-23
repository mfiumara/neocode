import assert from "node:assert/strict";
import test from "node:test";
import { isCommandPaletteShortcut, isNormalModeCommandPaletteShortcut } from "./commandPalette";

const keyboardEvent = (key: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

test("Command/Ctrl-K opens the command palette", () => {
  assert.equal(isCommandPaletteShortcut(keyboardEvent("k", { metaKey: true })), true);
  assert.equal(isCommandPaletteShortcut(keyboardEvent("K", { ctrlKey: true })), true);
});

test("unrelated and additionally modified keys do not open the palette", () => {
  assert.equal(isCommandPaletteShortcut(keyboardEvent("p", { metaKey: true })), false);
  assert.equal(isCommandPaletteShortcut(keyboardEvent("p", { ctrlKey: true })), false);
  assert.equal(isCommandPaletteShortcut(keyboardEvent("k")), false);
  assert.equal(isCommandPaletteShortcut(keyboardEvent("k", { ctrlKey: true, altKey: true })), false);
});

test("backtick remains a NORMAL-mode palette shortcut", () => {
  assert.equal(isNormalModeCommandPaletteShortcut("`"), true);
  assert.equal(isNormalModeCommandPaletteShortcut(":"), true);
  assert.equal(isNormalModeCommandPaletteShortcut("k"), false);
});
