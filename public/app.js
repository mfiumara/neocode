const svg = document.querySelector("#graph");
const viewport = document.querySelector("#viewport");
const details = document.querySelector("#details");
const projectList = document.querySelector("#projects .project-list");
const search = document.querySelector("#search");
const help = document.querySelector("#help");

const state = {
  data: null,
  activeProject: null,
  selected: null,
  positions: new Map(),
  ordered: [],
  session: null,
  logs: new Map(),
  agentSelection: new Map(),
  poll: null,
  g: false,
};
const NS = "http://www.w3.org/2000/svg";
const $ = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const s = (tag, attributes = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, value);
  return node;
};
const short = (value, length = 34) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

async function load({ keepSelection = true } = {}) {
  document.body.classList.add("loading");
  try {
    const response = await fetch("/api/graph");
    if (!response.ok) throw new Error(`Git returned ${response.status}`);
    const data = await response.json();
    state.data = data;
    const projects = data.nodes.filter((node) => node.kind === "project");
    const remembered = localStorage.getItem("neocode-project");
    if (!projects.some((node) => node.id === state.activeProject))
      state.activeProject =
        projects.find((node) => node.id === remembered)?.id || projects[0]?.id;
    if (
      !keepSelection ||
      !data.nodes.some((node) => node.id === state.selected)
    )
      state.selected = null;
    document.querySelector("#repo").textContent = data.repository;
    renderProjectTabs();
    document
      .querySelector("#stats")
      .replaceChildren(
        stat(data.counts.running, "running"),
        stat(data.counts.sessions, "sessions"),
        stat(data.counts.workspaces, "workspaces"),
        stat(data.counts.projects, "projects"),
      );
    render();
  } catch (error) {
    details.replaceChildren($("div", "error", error.message));
  } finally {
    document.body.classList.remove("loading");
  }
}

function stat(value, label) {
  const item = $("span");
  item.append($("strong", "", String(value)), $("small", "", label));
  return item;
}

function renderProjectTabs() {
  projectList.replaceChildren();
  for (const project of state.data.nodes.filter(
    (node) => node.kind === "project",
  )) {
    const button = $(
      "button",
      project.id === state.activeProject ? "active" : "",
    );
    button.type = "button";
    button.title = project.name;
    button.append(
      $("span", "project-icon", project.name.slice(0, 2).toUpperCase()),
      $("span", "project-name", project.name),
    );
    button.addEventListener("click", () => {
      closeAgent();
      state.activeProject = project.id;
      state.selected = null;
      localStorage.setItem("neocode-project", project.id);
      renderProjectTabs();
      render();
      viewport.scrollTo(0, 0);
    });
    projectList.append(button);
  }
}

function tree() {
  const all = new Map(state.data.nodes.map((node) => [node.id, node]));
  const root = all.get(state.activeProject);
  const belongsToProject = (node) => {
    let current = node;
    while (current) {
      if (current.id === root?.id) return true;
      current = all.get(current.parent);
    }
    return false;
  };
  const visible = root ? state.data.nodes.filter(belongsToProject) : [];
  const ids = new Set(visible.map((node) => node.id));
  const parentOf = (node) => {
    let parent = node.parent;
    while (parent && !ids.has(parent)) parent = all.get(parent)?.parent;
    return parent;
  };
  const children = new Map(visible.map((node) => [node.id, []]));
  for (const node of visible) {
    const parent = parentOf(node);
    if (parent) children.get(parent)?.push(node);
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        Number(b.kind === "workspace") - Number(a.kind === "workspace") ||
        b.timestamp - a.timestamp ||
        a.name.localeCompare(b.name),
    );
  }
  return { visible, children, parentOf, root };
}

function render() {
  svg.replaceChildren();
  state.positions.clear();
  const { visible, children, root } = tree();
  if (!root) return;
  let cursor = 24;
  let maxDepth = 0;
  const boxes = [];

  const placeAgent = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const descendants = children.get(node.id) || [];
    const childY = descendants.map((child) => placeAgent(child, depth + 1));
    const y = childY.length ? (childY[0] + childY.at(-1)) / 2 : cursor + 40;
    if (!childY.length) cursor += 96;
    state.positions.set(node.id, {
      x: 64 + depth * 304,
      y,
      parent: node.parent,
    });
    return y;
  };

  const topLevel = children.get(root.id) || [];
  for (const workspace of topLevel.filter(
    (node) => node.kind === "workspace",
  )) {
    const top = cursor;
    cursor += 72;
    const agents = children.get(workspace.id) || [];
    for (const agent of agents) placeAgent(agent, 0);
    if (!agents.length) cursor += 16;
    const bottom = Math.max(cursor + 16, top + 92);
    state.positions.set(workspace.id, {
      x: 32,
      y: top + 32,
      parent: workspace.parent,
    });
    boxes.push({ node: workspace, x: 32, y: top, height: bottom - top });
    cursor = bottom + 16;
  }
  for (const node of topLevel.filter((item) => item.kind !== "workspace"))
    placeAgent(node, 0);

  const height = Math.max(720, cursor + 28);
  const width = Math.max(980, 392 + (maxDepth + 1) * 304);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const shells = s("g", { class: "workspace-shells" });
  const edges = s("g", { class: "edges" });
  const cards = s("g", { class: "nodes" });
  svg.append(shells, edges, cards);
  for (const box of boxes)
    shells.append(workspaceBox(box.node, { ...box, width: width - 64 }));

  for (const node of visible) {
    if (node === root || node.kind === "workspace") continue;
    const position = state.positions.get(node.id);
    const parentNode = visible.find((item) => item.id === position.parent);
    const parent = state.positions.get(position.parent);
    if (parent && parentNode?.kind === "agent") {
      edges.append(
        s("path", {
          d: `M ${parent.x + 264} ${parent.y} C ${parent.x + 284} ${parent.y}, ${position.x - 20} ${position.y}, ${position.x} ${position.y}`,
          "data-child": node.id,
        }),
      );
    }
    cards.append(card(node, position));
  }

  const preorder = (node, result = []) => {
    result.push(node.id);
    for (const child of children.get(node.id) || []) preorder(child, result);
    return result;
  };
  state.ordered = topLevel.flatMap((node) => preorder(node));
  applySearch();
  select(state.selected, false);
  updateFocusClasses();
}

const compactNumber = (value) =>
  value >= 1_000
    ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : String(value);

function workspaceBox(node, { x, y, width, height }) {
  const group = s("g", {
    class: "node workspace-box",
    transform: `translate(${x} ${y})`,
    tabindex: "0",
    role: "treeitem",
    "data-id": node.id,
  });
  group.append(s("rect", { class: "workspace-shell", width, height, rx: 15 }));
  group.append(s("circle", { cx: 20, cy: 24, r: 4, class: "status" }));
  const name = s("text", { x: 34, y: 28, class: "workspace-name" });
  name.textContent = short(node.name, 52);
  group.append(name);

  if (node.diff) {
    const additions = s("text", {
      x: width - 72,
      y: 28,
      class: "diff-additions",
      "text-anchor": "end",
    });
    additions.textContent = `+${compactNumber(node.diff.additions)}`;
    const deletions = s("text", {
      x: width - 18,
      y: 28,
      class: "diff-deletions",
      "text-anchor": "end",
    });
    deletions.textContent = `-${compactNumber(node.diff.deletions)}`;
    group.append(additions, deletions);
  }

  const meta = s("text", { x: 34, y: 50, class: "workspace-meta" });
  if (node.pullRequest) {
    const pr = s("tspan");
    pr.textContent = `⑂ ${node.pullRequest.number}`;
    const ci = s("tspan", {
      dx: 12,
      class: `ci-${node.pullRequest.ci}`,
    });
    ci.textContent =
      node.pullRequest.ci === "success"
        ? "✓ passed"
        : node.pullRequest.ci === "failure"
          ? "✕ failed"
          : node.pullRequest.ci === "pending"
            ? "◷ pending"
            : "no CI";
    meta.append(pr, ci);
  } else {
    meta.textContent = node.paseoWorkspace.isolation;
  }
  group.append(meta);
  const title = s("title");
  title.textContent = node.pullRequest
    ? `${node.name} · PR #${node.pullRequest.number}: ${node.pullRequest.title}`
    : node.name;
  group.append(title);
  group.addEventListener("click", () => select(node.id));
  group.addEventListener("focus", () => select(node.id, false));
  return group;
}

function card(node, { x, y }) {
  const classes = [
    "node",
    node.kind === "workspace" && "has-worktree",
    node.remote && "remote",
    node.detached && "detached",
    node.agent?.status && `agent-${node.agent.status}`,
    node.lane && `pr-${node.lane}`,
  ]
    .filter(Boolean)
    .join(" ");
  const group = s("g", {
    class: classes,
    transform: `translate(${x} ${y - 40})`,
    tabindex: "0",
    role: "treeitem",
    "data-id": node.id,
  });
  if (node.worktree)
    group.append(s("circle", { cx: 132, cy: 40, r: 42, class: "agent-aura" }));
  group.append(s("rect", { width: 264, height: 80, rx: 13 }));
  group.append(s("circle", { cx: 20, cy: 22, r: 5, class: "status" }));
  const name = s("text", { x: 34, y: 27, class: "name" });
  name.textContent = short(node.name, node.pullRequest ? 23 : 28);
  const meta = s("text", { x: 18, y: 53, class: "meta" });
  meta.textContent = node.agent?.id
    ? short(node.agent.provider, 28)
    : `${node.hash.slice(0, 7)} · ${short(node.author, 24)}`;
  const badge = s("text", {
    x: 246,
    y: 55,
    class: "badge",
    "text-anchor": "end",
  });
  badge.textContent = node.agent?.id
    ? node.agent.status.toUpperCase()
    : node.kind.toUpperCase();
  const title = s("title");
  title.textContent = node.pullRequest
    ? `${node.name} · PR #${node.pullRequest.number}: ${node.pullRequest.title}`
    : node.name;
  group.append(name, meta, badge);
  if (node.pullRequest) {
    const pullRequest = s("text", {
      x: 246,
      y: 25,
      class: "pr-badge",
      "text-anchor": "end",
    });
    pullRequest.textContent = `PR #${node.pullRequest.number}`;
    group.append(pullRequest);
  }
  group.append(title);
  group.addEventListener("click", () =>
    node.kind === "agent" ? openAgent(node.id) : select(node.id),
  );
  group.addEventListener("focus", () => select(node.id, false));
  return group;
}

function select(id, scroll = true) {
  if (!state.positions.has(id)) id = state.ordered[0];
  if (!id) {
    details.replaceChildren(
      $("div", "agent-empty", "No workspaces in this project"),
    );
    return;
  }
  state.selected = id;
  svg
    .querySelectorAll(".selected")
    .forEach((node) => node.classList.remove("selected"));
  const element = svg.querySelector(`[data-id="${CSS.escape(id)}"]`);
  element?.classList.add("selected");
  const node = state.data.nodes.find((item) => item.id === id);
  if (state.session === id) showAgent(node);
  else showDetails(node);
  if (scroll) {
    const { x, y } = state.positions.get(id);
    viewport.scrollTo({
      left: Math.max(0, x - viewport.clientWidth / 2 + 132),
      top: Math.max(0, y - viewport.clientHeight / 2),
      behavior: "smooth",
    });
  }
}

function showDetails(node) {
  details.replaceChildren();
  const heading = $("div", "detail-heading");
  heading.append(
    $("span", `detail-dot ${node.worktree ? "active" : ""}`),
    $("div"),
  );
  heading.lastChild.append(
    $(
      "small",
      "",
      node.kind === "agent"
        ? "agent session"
        : node.kind === "workspace"
          ? `${node.paseoWorkspace.isolation} workspace`
          : node.kind,
    ),
    $("h1", "", node.name),
  );
  details.append(heading);

  const dl = $("dl");
  row(dl, "id", node.hash.slice(0, 12));
  if (node.timestamp) row(dl, "last change", ago(node.timestamp));
  if (node.kind === "agent") row(dl, "provider", node.agent.provider);
  if (node.kind === "workspace")
    row(dl, "project", node.paseoWorkspace.project);
  if (node.worktree) row(dl, "path", node.worktree);
  if (node.pullRequest) {
    row(
      dl,
      "pull request",
      `#${node.pullRequest.number} · ${node.pullRequest.state.toLowerCase()}`,
    );
    row(dl, "CI", node.pullRequest.ci);
  }
  if (node.diff)
    row(dl, "diff", `+${node.diff.additions} −${node.diff.deletions}`);
  details.append(dl, $("p", "subject", node.subject));

  if (node.pullRequest) {
    const link = $("a", "pr-link", `Open PR #${node.pullRequest.number} ↗`);
    link.href = node.pullRequest.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    details.append(link);
  }

  if (node.kind === "agent") {
    const open = $("button", "open-agent", "Open agent session  ↵");
    open.addEventListener("click", () => openAgent(node.id));
    details.append(open);
  }

  const parent = state.data.nodes.find((item) => item.id === node.parent);
  if (parent) {
    const relationship = $("div", "relationship");
    relationship.append(
      $("small", "", "reports to"),
      $("button", "", parent.name),
    );
    relationship
      .querySelector("button")
      .addEventListener("click", () => select(parent.id));
    details.append(relationship);
  }
}

function openAgent(id) {
  const node = state.data.nodes.find((item) => item.id === id);
  if (node?.kind !== "agent") return;
  state.session = id;
  document.body.classList.add("agent-view");
  svg.classList.add("session-active");
  select(id);
  animateAgentWindow(id);
  loadAgentLogs(node);
  clearInterval(state.poll);
  state.poll = setInterval(() => loadAgentLogs(node, true), 2_000);
  setTimeout(() => details.querySelector("textarea")?.focus(), 320);
}

function animateAgentWindow(id) {
  requestAnimationFrame(() => {
    const card = svg.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const from = card.getBoundingClientRect();
    const to = details.getBoundingClientRect();
    details.style.setProperty(
      "--origin-x",
      `${from.left + from.width / 2 - to.left}px`,
    );
    details.style.setProperty(
      "--origin-y",
      `${from.top + from.height / 2 - to.top}px`,
    );
    details.classList.remove("opening");
    void details.offsetWidth;
    details.classList.add("opening");
  });
}

function closeAgent() {
  if (!state.session) return;
  state.session = null;
  clearInterval(state.poll);
  state.poll = null;
  document.body.classList.remove("agent-view");
  svg.classList.remove("session-active");
  updateFocusClasses();
  showDetails(state.data.nodes.find((node) => node.id === state.selected));
}

function updateFocusClasses() {
  const downstream = new Set();
  if (state.session) {
    for (const node of state.data.nodes) {
      let parent = node.parent;
      while (parent) {
        if (parent === state.session) {
          downstream.add(node.id);
          break;
        }
        parent = state.data.nodes.find((item) => item.id === parent)?.parent;
      }
    }
  }
  for (const element of svg.querySelectorAll(".node")) {
    element.classList.toggle(
      "session-node",
      element.dataset.id === state.session,
    );
    element.classList.toggle("downstream", downstream.has(element.dataset.id));
  }
  for (const edge of svg.querySelectorAll(".edges path")) {
    edge.classList.toggle(
      "downstream",
      edge.dataset.child === state.session ||
        downstream.has(edge.dataset.child),
    );
  }
}

function activeAgent(node) {
  const selected = state.agentSelection.get(node.id);
  return node.agents?.find((agent) => agent.id === selected) || node.agent;
}

async function loadAgentLogs(node, force = false) {
  const agent = activeAgent(node);
  if (!agent?.id || (!force && state.logs.has(agent.id))) return;
  state.logs.set(agent.id, { loading: true });
  try {
    const response = await fetch(
      `/api/agents/${encodeURIComponent(agent.id)}/logs`,
    );
    if (!response.ok) throw new Error(await response.text());
    const activity = await response.json();
    state.logs.set(agent.id, activity);
    if (activity.agent) Object.assign(agent, activity.agent);
  } catch (error) {
    state.logs.set(agent.id, { error: error.message });
  }
  if (state.session === node.id && activeAgent(node)?.id === agent.id) {
    const activity = state.logs.get(agent.id);
    const log = details.querySelector(".agent-log");
    if (log && !activity.error) {
      const transcript = log.closest(".agent-transcript");
      const following =
        transcript.scrollHeight -
          transcript.scrollTop -
          transcript.clientHeight <
        24;
      renderMarkdown(log, activity.logs || "No recent activity");
      if (following) transcript.scrollTop = transcript.scrollHeight;
      const status = details.querySelector(".agent-state");
      status.className = `agent-state ${agent.status}`;
      status.textContent = agent.status;
    } else showAgent(node);
  }
}

function showAgent(node) {
  details.replaceChildren();
  const agent = activeAgent(node);
  const top = $("div", "agent-topbar");
  const back = $("button", "agent-back", "← Graph");
  back.addEventListener("click", closeAgent);
  top.append(
    back,
    $(
      "span",
      `agent-state ${agent?.status || "unattached"}`,
      agent?.status || "unattached",
    ),
  );

  const heading = $("div", "agent-identity");
  heading.append($("span", "agent-orb", "N"), $("div"));
  const children = state.data.nodes.filter(
    (item) => state.positions.get(item.id)?.parent === node.id,
  );
  const role = agent?.name?.toLowerCase().includes("repository lead")
    ? "Repository lead"
    : children.length
      ? `Lead agent · ${children.length} downstream`
      : "Paseo agent";
  heading.lastChild.append($("small", "", role), $("h1", "", node.name));
  if (agent?.name) heading.lastChild.append($("p", "agent-task", agent.name));

  let picker;
  if (node.agents?.length > 1) {
    picker = $("label", "session-picker");
    picker.append($("small", "", `${node.agents.length} Paseo sessions`));
    const select = $("select");
    for (const item of node.agents) {
      const option = $("option", "", `${item.status} · ${item.name}`);
      option.value = item.id;
      select.append(option);
    }
    select.value = agent.id;
    select.addEventListener("change", () => {
      state.agentSelection.set(node.id, select.value);
      showAgent(node);
      loadAgentLogs(node);
    });
    picker.append(select);
  }

  const context = $("div", "agent-context");
  context.append(
    $("span", "", node.hash.slice(0, 7)),
    $("span", "", agent?.provider || "No Paseo session"),
    $("span", "", node.worktree),
  );

  const transcript = $("div", "agent-transcript");
  const activity = agent?.id && state.logs.get(agent.id);
  if (!agent?.id) {
    const empty = $("div", "agent-empty");
    empty.append(
      $("strong", "", "No Paseo session attached"),
      $("p", "", "Start a Paseo agent in this worktree and refresh the graph."),
    );
    transcript.append(empty);
  } else if (!activity || activity.loading) {
    const loading = $("div", "agent-loading");
    loading.append($("span", "spinner"), $("div"));
    loading.lastChild.append(
      $("strong", "", "Loading conversation"),
      $("small", "", "Streaming from Paseo"),
    );
    transcript.append(loading);
  } else if (activity.error) {
    transcript.append($("div", "error", activity.error));
  } else {
    const log = $("div", "agent-log markdown");
    renderMarkdown(log, activity.logs || "No recent activity");
    transcript.append(log);
  }
  const down = $("section", "agent-downstream");
  down.append($("small", "", "Downstream branches"));
  const branchList = $("div", "branch-list");
  if (!children.length)
    branchList.append($("span", "empty-branches", "No child branches"));
  for (const child of children) {
    const button = $("button", child.worktree ? "live" : "", child.name);
    button.addEventListener("click", () => {
      if (child.kind === "agent") openAgent(child.id);
      else {
        closeAgent();
        select(child.id);
      }
    });
    branchList.append(button);
  }
  down.append(branchList);

  const form = $("form", "prompt-box");
  const textarea = $("textarea");
  textarea.rows = 3;
  textarea.disabled = !agent?.id;
  textarea.placeholder = agent?.id
    ? `Prompt ${agent.name}…`
    : "No Paseo agent in this worktree";
  const submit = $("button", "", "Send to Paseo  ↑");
  submit.type = "submit";
  submit.disabled = !agent?.id;
  form.append(
    textarea,
    $(
      "small",
      "",
      agent?.id ? `Paseo · ${agent.shortId}` : "Waiting for a Paseo session",
    ),
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = textarea.value.trim();
    if (!prompt || !agent?.id) return;
    submit.disabled = true;
    submit.textContent = "Sending…";
    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agent.id)}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      state.logs.delete(agent.id);
      showAgent(node);
      setTimeout(() => loadAgentLogs(node, true), 500);
    } catch (error) {
      state.logs.set(agent.id, { error: error.message });
      showAgent(node);
    }
  });

  details.append(top, heading, picker || "", context, transcript, down, form);
  requestAnimationFrame(() => {
    transcript.scrollTop = transcript.scrollHeight;
  });
}

function renderInline(target, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) target.append($("code", "", token.slice(1, -1)));
    else if (token.startsWith("**"))
      target.append($("strong", "", token.slice(2, -2)));
    else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      const link = $("a", "", label);
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";
      target.append(link);
    }
    cursor = match.index + token.length;
  }
  target.append(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(target, source) {
  target.replaceChildren();
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = [];
      for (
        index++;
        index < lines.length && !lines[index].startsWith("```");
        index++
      )
        code.push(lines[index]);
      index++;
      const pre = $("pre", "markdown-code");
      if (language) pre.dataset.language = language;
      pre.append($("code", "", code.join("\n")));
      target.append(pre);
      continue;
    }
    const event = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (event) {
      const block = $("div", `markdown-event ${event[1].toLowerCase()}`);
      block.append($("span", "", event[1]));
      if (event[2]) renderInline(block, event[2]);
      target.append(block);
      index++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const element = $(`h${heading[1].length + 1}`);
      renderInline(element, heading[2]);
      target.append(element);
      index++;
      continue;
    }
    const listItem = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
    if (listItem) {
      const list = $(listItem[2] ? "ol" : "ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
        if (!item || Boolean(item[2]) !== Boolean(listItem[2])) break;
        const entry = $("li");
        renderInline(entry, item[3]);
        list.append(entry);
        index++;
      }
      target.append(list);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !lines[index].match(/^(#{1,4})\s+|^\[[^\]]+\]\s*|^\s*(?:[-*]|\d+\.)\s+/)
    )
      paragraph.push(lines[index++]);
    const element = $("p");
    renderInline(element, paragraph.join(" "));
    target.append(element);
  }
}

function row(list, label, value) {
  list.append($("dt", "", label), $("dd", "", value));
}

function ago(timestamp) {
  if (!timestamp) return "unknown";
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  const units = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size)
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
        -Math.floor(seconds / size),
        unit,
      );
  }
  return "just now";
}

function applySearch() {
  const query = search.value.trim().toLowerCase();
  for (const element of svg.querySelectorAll(".node")) {
    const node = state.data.nodes.find(
      (item) => item.id === element.dataset.id,
    );
    const match =
      !query ||
      `${node.name} ${node.author} ${node.email} ${node.subject} ${node.agents?.map((agent) => agent.name).join(" ") || ""}`
        .toLowerCase()
        .includes(query);
    element.classList.toggle("dim", !match);
    element.classList.toggle("match", Boolean(query && match));
  }
}

function move(direction) {
  const position = state.ordered.indexOf(state.selected);
  if (direction === "parent")
    return select(
      state.positions.get(state.selected)?.parent || state.selected,
    );
  if (direction === "child") {
    const child = state.ordered.find(
      (id) => state.positions.get(id)?.parent === state.selected,
    );
    return select(child || state.selected);
  }
  const next = Math.max(
    0,
    Math.min(state.ordered.length - 1, position + direction),
  );
  select(state.ordered[next]);
}

function nextMatch() {
  const matches = [...svg.querySelectorAll(".node.match")].map(
    (node) => node.dataset.id,
  );
  if (!matches.length) return;
  select(matches[(matches.indexOf(state.selected) + 1) % matches.length]);
}

search.addEventListener("input", applySearch);
search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    nextMatch();
  }
  if (event.key === "Escape") {
    search.value = "";
    search.blur();
    applySearch();
  }
});
document.querySelector("#refresh").addEventListener("click", () => load());
document.addEventListener("pointerdown", (event) => {
  if (state.session && !details.contains(event.target)) closeAgent();
});
help.querySelector(".close").addEventListener("click", () => help.close());

window.addEventListener("keydown", (event) => {
  if (help.open) {
    if (event.key === "Escape") help.close();
    return;
  }
  if (event.target.matches("input, textarea")) {
    if (event.key === "Escape" && state.session) closeAgent();
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    search.focus();
    return;
  }
  if (event.key === "?") {
    help.showModal();
    return;
  }
  if ((event.key === "q" || event.key === "Escape") && state.session)
    closeAgent();
  else if (event.key === "Enter") openAgent(state.selected);
  else if (event.key === "h") move("parent");
  else if (event.key === "j") move(1);
  else if (event.key === "k") move(-1);
  else if (event.key === "l") move("child");
  else if (event.key === "G") select(state.ordered.at(-1));
  else if (event.key === "g" && state.g) {
    select(state.data.root);
    state.g = false;
  } else if (event.key === "g") {
    state.g = true;
    setTimeout(() => {
      state.g = false;
    }, 500);
  } else if (event.key === "n") nextMatch();
  else if (event.key === "r") load();
  else if (event.key === "Escape") {
    search.value = "";
    applySearch();
  }
});

load({ keepSelection: false }).then(() =>
  requestAnimationFrame(() => viewport.scrollTo({ top: 0, left: 0 })),
);
