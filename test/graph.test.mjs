import assert from "node:assert/strict";
import test from "node:test";
import { inferParents } from "../server.mjs";

test("infers the nearest branch tip as parent and anchors shared tips at main", () => {
  const nodes = [
    { id: "main", hash: "a", remote: false },
    { id: "team", hash: "b", remote: false },
    { id: "task", hash: "c", remote: false },
    { id: "fresh", hash: "a", remote: false },
  ];
  const commits = new Map([
    ["a", []],
    ["b", ["a"]],
    ["c", ["b"]],
  ]);

  assert.equal(inferParents(nodes, commits, "main"), "main");
  assert.deepEqual(
    nodes.map(({ id, parent }) => [id, parent]),
    [
      ["main", null],
      ["team", "main"],
      ["task", "team"],
      ["fresh", "main"],
    ],
  );
});

test("does not turn merged historical branches into a fake management chain", () => {
  const nodes = [
    { id: "main", hash: "d", remote: false },
    { id: "old-team", hash: "b", remote: false },
    { id: "old-task", hash: "c", remote: false },
  ];
  const commits = new Map([
    ["a", []],
    ["b", ["a"]],
    ["c", ["b"]],
    ["d", ["c"]],
  ]);

  inferParents(nodes, commits, "main");
  assert.deepEqual(
    nodes.map(({ parent }) => parent),
    [null, "main", "main"],
  );
});
