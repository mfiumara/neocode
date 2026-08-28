import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.PORT || 4173);

async function paseo(...args) {
  const { stdout } = await exec("paseo", ["--no-color", ...args], {
    cwd: HERE,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

const json = async (...args) => JSON.parse(await paseo(...args));
const absoluteCwd = (cwd = "") => resolve(cwd.replace(/^~(?=\/|$)/, homedir()));

async function workspaceDetails(workspace) {
  const cwd = absoluteCwd(workspace.cwd);
  const number = workspace.name.match(/\bPR\s*#?(\d+)/i)?.[1];
  try {
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "view",
        ...(number ? [number] : []),
        "--json",
        "number,title,url,state,isDraft,additions,deletions,statusCheckRollup",
      ],
      { cwd, maxBuffer: 5 * 1024 * 1024 },
    );
    const pr = JSON.parse(stdout);
    const results = pr.statusCheckRollup
      .map(
        (check) =>
          check.conclusion ||
          check.state ||
          (check.status && check.status !== "COMPLETED" ? "PENDING" : null),
      )
      .filter(Boolean);
    const passed = ["SUCCESS", "SKIPPED", "NEUTRAL"];
    const waiting = ["PENDING", "EXPECTED"];
    const ci = results.length
      ? results.some(
          (result) => !passed.includes(result) && !waiting.includes(result),
        )
        ? "failure"
        : results.some((result) => waiting.includes(result))
          ? "pending"
          : "success"
      : "none";
    return { ...workspace, pullRequest: { ...pr, ci } };
  } catch {
    try {
      const { stdout } = await exec("git", ["diff", "--numstat", "HEAD"], {
        cwd,
      });
      const diff = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .reduce(
          (total, line) => {
            const [additions, deletions] = line.split("\t").map(Number);
            total.additions += additions || 0;
            total.deletions += deletions || 0;
            return total;
          },
          { additions: 0, deletions: 0 },
        );
      return {
        ...workspace,
        diff: diff.additions || diff.deletions ? diff : null,
      };
    } catch {
      return workspace;
    }
  }
}

async function inspectAgent(agent) {
  try {
    const detail = await json("inspect", agent.id, "--json");
    return {
      ...agent,
      cwd: absoluteCwd(detail.Cwd || agent.cwd),
      model: detail.Model,
      parentAgentId: detail.ParentAgentId,
      status: detail.Status?.toLowerCase() || agent.status,
      timestamp: Date.parse(detail.UpdatedAt || detail.CreatedAt) || 0,
    };
  } catch {
    return { ...agent, cwd: absoluteCwd(agent.cwd), timestamp: 0 };
  }
}

const baseNode = (node) => ({
  hash: node.hash || "0000000",
  author: node.author || "Paseo",
  email: "",
  timestamp: node.timestamp || 0,
  subject: node.subject || "",
  remote: false,
  detached: false,
  locked: false,
  agents: [],
  agent: { status: "unavailable", id: null },
  paseoWorkspace: null,
  pullRequest: null,
  ...node,
});

export function buildPaseoGraph(projects, workspaces, agents) {
  const root = baseNode({
    id: "paseo",
    name: "Paseo",
    kind: "root",
    parent: null,
    subject: "Projects, workspaces, and active agent sessions",
  });
  const projectNodes = projects.map((project) =>
    baseNode({
      id: `project:${project.projectId}`,
      name: project.name,
      kind: "project",
      lane: "projects",
      parent: root.id,
      hash: project.projectId,
      subject: project.path,
      worktree: project.path,
      project,
    }),
  );
  const projectByName = new Map(
    projectNodes.map((node) => [node.project.name, node]),
  );
  const workspaceNodes = workspaces.map((workspace) =>
    baseNode({
      id: `workspace:${workspace.workspaceId}`,
      name: workspace.name,
      kind: "workspace",
      lane: "workspaces",
      parent: projectByName.get(workspace.project)?.id || root.id,
      hash: workspace.workspaceId,
      author: workspace.project,
      subject: `${workspace.isolation} workspace`,
      worktree: absoluteCwd(workspace.cwd),
      paseoWorkspace: workspace,
      pullRequest: workspace.pullRequest || null,
      diff: workspace.pullRequest
        ? {
            additions: workspace.pullRequest.additions,
            deletions: workspace.pullRequest.deletions,
          }
        : workspace.diff || null,
    }),
  );
  const workspaceByCwd = new Map(
    workspaceNodes.map((node) => [node.worktree, node]),
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  const agentNodes = agents.map((agent) => {
    const workspace = workspaceByCwd.get(absoluteCwd(agent.cwd));
    return baseNode({
      id: agent.id,
      name: agent.name,
      kind: "agent",
      lane:
        agent.status === "running"
          ? "running"
          : agent.status === "idle"
            ? "idle"
            : "attention",
      parent:
        (agentIds.has(agent.parentAgentId) && agent.parentAgentId) ||
        workspace?.id ||
        root.id,
      hash: agent.shortId || agent.id,
      author: agent.provider,
      timestamp: agent.timestamp,
      subject: agent.model || agent.provider,
      worktree: absoluteCwd(agent.cwd),
      agents: [agent],
      agent,
      paseoWorkspace: workspace?.paseoWorkspace || null,
    });
  });

  return {
    root: root.id,
    repository: "Paseo",
    generatedAt: Date.now(),
    nodes: [root, ...projectNodes, ...workspaceNodes, ...agentNodes],
    counts: {
      projects: projectNodes.length,
      workspaces: workspaceNodes.length,
      sessions: agentNodes.length,
      running: agentNodes.filter((node) => node.agent.status === "running")
        .length,
    },
  };
}

export async function snapshot() {
  const [projects, workspaces, agentSummaries] = await Promise.all([
    json("project", "ls", "--json"),
    json("workspace", "ls", "--json"),
    json("ls", "--global", "--json"),
  ]);
  const [agents, detailedWorkspaces] = await Promise.all([
    Promise.all(agentSummaries.map(inspectAgent)),
    Promise.all(workspaces.map(workspaceDetails)),
  ]);
  return buildPaseoGraph(projects, detailedWorkspaces, agents);
}

async function matchedAgent(id) {
  const agent = (await json("ls", "--global", "--json")).find(
    (item) => item.id === id,
  );
  return agent && { ...agent, cwd: absoluteCwd(agent.cwd) };
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readPrompt(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_000) throw new Error("Prompt is too long");
  }
  let prompt;
  try {
    prompt = JSON.parse(body).prompt?.trim();
  } catch {
    throw new Error("Prompt must be valid JSON");
  }
  if (!prompt) throw new Error("Prompt is required");
  return prompt;
}

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/graph") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(await snapshot()));
      return;
    }

    const agentRoute = url.pathname.match(
      /^\/api\/agents\/([\w-]+)\/(logs|prompt)$/,
    );
    if (agentRoute) {
      const [, id, action] = agentRoute;
      const agent = await matchedAgent(id);
      if (!agent) {
        response.writeHead(404).end("Unknown Paseo agent");
        return;
      }
      if (action === "logs" && request.method === "GET") {
        const logs = await paseo(
          "logs",
          id,
          "--filter",
          "text",
          "--tail",
          "60",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ logs, agent }));
        return;
      }
      if (action === "prompt" && request.method === "POST") {
        if (!sameOrigin(request)) {
          response.writeHead(403).end("Cross-origin prompts are not allowed");
          return;
        }
        const prompt = await readPrompt(request);
        const result = await paseo(
          "send",
          id,
          "--prompt",
          prompt,
          "--no-wait",
          "--json",
        );
        response.writeHead(202, { "content-type": "application/json" });
        response.end(result || "{}");
        return;
      }
      response.writeHead(405).end("Method not allowed");
      return;
    }

    const [file, type] = files.get(url.pathname) || [];
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": type });
    response.end(await readFile(join(PUBLIC, file)));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

export function start(port = PORT, attempts = 10) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT && attempts > 1) {
      start(port + 1, attempts - 1);
      return;
    }
    console.error(`Could not start Neocode: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Neocode Paseo map → http://localhost:${port}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
