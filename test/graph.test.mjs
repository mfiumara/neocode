import assert from "node:assert/strict";
import test from "node:test";
import { buildPaseoGraph } from "../server.mjs";

test("maps Paseo projects, workspaces, agents, and subagents", () => {
  const graph = buildPaseoGraph(
    [{ projectId: "project-1", name: "Neocode", path: "/repo" }],
    [
      {
        workspaceId: "workspace-1",
        project: "Neocode",
        name: "Main",
        isolation: "local",
        cwd: "/repo",
        pullRequest: {
          number: 42,
          title: "Show workspace details",
          url: "https://example.test/pr/42",
          state: "OPEN",
          additions: 12,
          deletions: 3,
          ci: "success",
        },
      },
    ],
    [
      {
        id: "lead",
        shortId: "lead",
        name: "Repository Lead",
        provider: "pi/gpt-5.6-sol",
        status: "idle",
        cwd: "/repo",
      },
      {
        id: "worker",
        shortId: "worker",
        name: "Feature Lead",
        provider: "pi/gpt-5.6-sol",
        status: "running",
        cwd: "/worktree",
        parentAgentId: "lead",
      },
    ],
  );

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("project:project-1").parent, "paseo");
  assert.equal(byId.get("workspace:workspace-1").parent, "project:project-1");
  assert.equal(byId.get("workspace:workspace-1").pullRequest.number, 42);
  assert.deepEqual(byId.get("workspace:workspace-1").diff, {
    additions: 12,
    deletions: 3,
  });
  assert.equal(byId.get("lead").parent, "workspace:workspace-1");
  assert.equal(byId.get("worker").parent, "lead");
  assert.equal(byId.get("worker").lane, "running");
  assert.deepEqual(graph.counts, {
    projects: 1,
    workspaces: 1,
    sessions: 2,
    running: 1,
  });
});
