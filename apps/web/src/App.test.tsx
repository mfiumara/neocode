import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";

test("the composer exposes one normal coordinator action", () => {
  const markup = renderToStaticMarkup(<App />);
  const actions = markup.match(/<div class="action-buttons">(.*?)<\/div>/)?.[1];

  assert.ok(actions);
  assert.equal(actions.match(/<button/g)?.length, 1);
  assert.match(actions, />Send <span>↵<\/span><\/button>/);
});

test("the workspace command-palette label uses Command/Ctrl-K", () => {
  const markup = renderToStaticMarkup(<App />);

  assert.match(markup, /Open command palette \(Command\/Ctrl-K\)/);
  assert.match(markup, /⌘\/Ctrl K/);
});
