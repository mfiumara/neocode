import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const REPO = process.env.REPO ? resolve(process.env.REPO) : HERE;
const PORT = Number(process.env.PORT || 4173);

async function git(...args) {
  const { stdout } = await exec("git", args, {
    cwd: REPO,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

export function inferParents(nodes, commitParents, rootId) {
  const root = nodes.find((node) => node.id === rootId) || nodes[0];
  const tips = Map.groupBy(nodes, (node) => node.hash);
  const rootHistory = new Set([root.hash]);
  const pending = [root.hash];
  for (const hash of pending) {
    for (const parent of commitParents.get(hash) || []) {
      if (!rootHistory.has(parent)) {
        rootHistory.add(parent);
        pending.push(parent);
      }
    }
  }

  for (const node of nodes) {
    if (node === root || rootHistory.has(node.hash)) {
      node.parent = node === root ? null : root.id;
      continue;
    }

    let frontier = [...(commitParents.get(node.hash) || [])];
    const seen = new Set(frontier);
    let parent;

    while (frontier.length && !parent) {
      const candidates = frontier
        .flatMap((hash) => tips.get(hash) || [])
        .filter(
          (candidate) => candidate !== node && !rootHistory.has(candidate.hash),
        );
      parent = candidates.sort(
        (a, b) => Number(a.remote) - Number(b.remote),
      )[0];
      frontier = frontier
        .flatMap((hash) => commitParents.get(hash) || [])
        .filter((hash) => !seen.has(hash) && seen.add(hash));
    }

    node.parent = parent?.id || root.id;
  }

  return root.id;
}

function parseWorktrees(text) {
  return text
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const item = {};
      for (const line of block.split("\n")) {
        const [key, ...value] = line.split(" ");
        item[key] = value.join(" ") || true;
      }
      return item;
    });
}

export async function snapshot() {
  const [refsText, worktreeText, commitsText, rootPath] = await Promise.all([
    git(
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(authorname)%00%(authoremail)%00%(committerdate:unix)%00%(subject)",
      "refs/heads",
      "refs/remotes",
    ),
    git("worktree", "list", "--porcelain"),
    git("rev-list", "--parents", "--all"),
    git("rev-parse", "--show-toplevel"),
  ]);

  const refs = refsText
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, hash, author, email, timestamp, subject] = line.split("\0");
      const local = ref.startsWith("refs/heads/");
      return {
        id: ref,
        name: ref.replace(local ? "refs/heads/" : "refs/remotes/", ""),
        hash,
        author,
        email: email.replace(/^<|>$/g, ""),
        timestamp: Number(timestamp) * 1000,
        subject,
        remote: !local,
      };
    })
    .filter((node) => !node.id.endsWith("/HEAD"));

  const localTips = new Set(
    refs
      .filter((node) => !node.remote)
      .map((node) => `${node.name}\0${node.hash}`),
  );
  const nodes = refs.filter(
    (node) =>
      !node.remote ||
      !localTips.has(
        `${node.name.split("/").slice(1).join("/")}\0${node.hash}`,
      ),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byHash = new Map(nodes.map((node) => [node.hash, node]));
  const worktrees = parseWorktrees(worktreeText);

  for (const worktree of worktrees) {
    const branch =
      typeof worktree.branch === "string" && byId.get(worktree.branch);
    if (branch) {
      branch.worktree = worktree.worktree;
      branch.locked = Boolean(worktree.locked);
    } else {
      const source = byHash.get(worktree.HEAD) || {};
      nodes.push({
        id: `worktree:${worktree.worktree}`,
        name: `(detached) ${basename(worktree.worktree)}`,
        hash: worktree.HEAD,
        author: source.author || "Unknown",
        email: source.email || "",
        timestamp: source.timestamp || 0,
        subject: source.subject || "Detached worktree",
        remote: false,
        detached: true,
        worktree: worktree.worktree,
        locked: Boolean(worktree.locked),
      });
    }
  }

  const commitParents = new Map(
    commitsText
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, ...parents] = line.split(" ");
        return [hash, parents];
      }),
  );
  const root =
    nodes.find((node) => node.id === "refs/heads/main") ||
    nodes.find((node) => node.id === "refs/heads/master") ||
    nodes.find((node) => node.worktree === rootPath) ||
    nodes[0];

  inferParents(nodes, commitParents, root.id);
  nodes.sort(
    (a, b) =>
      Number(Boolean(b.worktree)) - Number(Boolean(a.worktree)) ||
      b.timestamp - a.timestamp ||
      a.name.localeCompare(b.name),
  );

  return {
    root: root.id,
    repository: basename(rootPath),
    generatedAt: Date.now(),
    nodes,
    counts: {
      branches: nodes.filter((node) => !node.detached).length,
      worktrees: nodes.filter((node) => node.worktree).length,
      people: new Set(nodes.map((node) => node.email || node.author)).size,
    },
  };
}

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/graph") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(await snapshot()));
      return;
    }

    const [file, type] = files.get(request.url) || [];
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
  server.listen(port, () =>
    console.log(`Neocode graph → http://localhost:${port}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
