import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRow,
  navigationForView,
  type ThreadNavigationByView,
} from "./threadNavigation";

test("unvisited threads initially select their newest row", () => {
  assert.deepEqual(navigationForView({}, "coordinator", 4), {
    selectedRow: 3,
    scrollTop: 0,
  });
  assert.equal(navigationForView({}, "job:new", 0).selectedRow, 0);
});

test("coordinator and worker navigation are independent", () => {
  const navigation: ThreadNavigationByView = {
    coordinator: { selectedRow: 1, scrollTop: 120 },
    "job:first": { selectedRow: 4, scrollTop: 480 },
    "job:second": { selectedRow: 2, scrollTop: 240 },
  };

  assert.deepEqual(navigationForView(navigation, "coordinator", 8), navigation.coordinator);
  assert.deepEqual(navigationForView(navigation, "job:first", 8), navigation["job:first"]);
  assert.deepEqual(navigationForView(navigation, "job:second", 8), navigation["job:second"]);
});

test("saved rows clamp safely when a transcript shrinks", () => {
  assert.equal(clampRow(9, 3), 2);
  assert.equal(clampRow(-2, 3), 0);
  assert.equal(clampRow(3, 0), 0);

  const navigation: ThreadNavigationByView = {
    "job:changed": { selectedRow: 9, scrollTop: 900 },
  };
  assert.deepEqual(navigationForView(navigation, "job:changed", 3), {
    selectedRow: 2,
    scrollTop: 900,
  });
});

test("appending rows does not move an existing cursor", () => {
  const navigation: ThreadNavigationByView = {
    coordinator: { selectedRow: 2, scrollTop: 100 },
  };
  assert.equal(navigationForView(navigation, "coordinator", 3).selectedRow, 2);
  assert.equal(navigationForView(navigation, "coordinator", 5).selectedRow, 2);
});
