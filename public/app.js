const svg = document.querySelector("#graph");
const viewport = document.querySelector("#viewport");
const details = document.querySelector("#details");
const search = document.querySelector("#search");
const worktreeButton = document.querySelector("#worktrees");
const help = document.querySelector("#help");

const state = {
  data: null,
  selected: null,
  worktreesOnly: false,
  positions: new Map(),
  ordered: [],
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
    if (
      !keepSelection ||
      !data.nodes.some((node) => node.id === state.selected)
    )
      state.selected = data.root;
    document.querySelector("#repo").textContent = data.repository;
    document
      .querySelector("#stats")
      .replaceChildren(
        stat(data.counts.branches, "branches"),
        stat(data.counts.worktrees, "worktrees"),
        stat(data.counts.people, "people"),
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

function tree() {
  const all = new Map(state.data.nodes.map((node) => [node.id, node]));
  const visible = state.worktreesOnly
    ? state.data.nodes.filter(
        (node) => node.worktree || node.id === state.data.root,
      )
    : state.data.nodes;
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
        Number(Boolean(b.worktree)) - Number(Boolean(a.worktree)) ||
        b.timestamp - a.timestamp,
    );
  }
  return { visible, children, parentOf };
}

function render() {
  svg.replaceChildren();
  state.positions.clear();
  const { visible, children, parentOf } = tree();
  let cursor = 44;
  let maxDepth = 0;

  function place(node, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const descendants = children.get(node.id) || [];
    const childY = descendants.map((child) => place(child, depth + 1));
    const y = childY.length ? (childY[0] + childY.at(-1)) / 2 : (cursor += 112);
    state.positions.set(node.id, {
      x: 56 + depth * 328,
      y,
      parent: parentOf(node),
    });
    return y;
  }

  const root =
    visible.find((node) => node.id === state.data.root) || visible[0];
  place(root, 0);
  const height = Math.max(720, cursor + 80);
  const width = Math.max(980, 120 + (maxDepth + 1) * 328);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const edges = s("g", { class: "edges" });
  const cards = s("g", { class: "nodes" });
  svg.append(edges, cards);

  for (const node of visible) {
    const position = state.positions.get(node.id);
    if (position.parent) {
      const parent = state.positions.get(position.parent);
      const path = s("path", {
        d: `M ${parent.x + 264} ${parent.y} C ${parent.x + 300} ${parent.y}, ${position.x - 36} ${position.y}, ${position.x} ${position.y}`,
      });
      edges.append(path);
    }
    cards.append(card(node, position));
  }

  state.ordered = preorder(root, children);
  applySearch();
  select(state.selected, false);
}

function preorder(node, children, result = []) {
  result.push(node.id);
  for (const child of children.get(node.id) || [])
    preorder(child, children, result);
  return result;
}

function card(node, { x, y }) {
  const classes = [
    "node",
    node.worktree && "has-worktree",
    node.remote && "remote",
    node.detached && "detached",
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
  group.append(s("rect", { width: 264, height: 80, rx: 13 }));
  group.append(s("circle", { cx: 20, cy: 22, r: 5, class: "status" }));
  const name = s("text", { x: 34, y: 27, class: "name" });
  name.textContent = short(node.name);
  const meta = s("text", { x: 18, y: 53, class: "meta" });
  meta.textContent = `${node.hash.slice(0, 7)} · ${short(node.author, 24)}`;
  const badge = s("text", {
    x: 246,
    y: 55,
    class: "badge",
    "text-anchor": "end",
  });
  badge.textContent = node.worktree
    ? "WORKTREE"
    : node.remote
      ? "REMOTE"
      : "BRANCH";
  const title = s("title");
  title.textContent = node.name;
  group.append(name, meta, badge, title);
  group.addEventListener("click", () => select(node.id));
  group.addEventListener("focus", () => select(node.id, false));
  return group;
}

function select(id, scroll = true) {
  if (!state.positions.has(id)) id = state.data.root;
  state.selected = id;
  svg
    .querySelectorAll(".selected")
    .forEach((node) => node.classList.remove("selected"));
  const element = svg.querySelector(`[data-id="${CSS.escape(id)}"]`);
  element?.classList.add("selected");
  const node = state.data.nodes.find((item) => item.id === id);
  showDetails(node);
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
      node.worktree
        ? "active worktree"
        : node.remote
          ? "remote branch"
          : "local branch",
    ),
    $("h1", "", node.name),
  );
  details.append(heading);

  const dl = $("dl");
  row(dl, "commit", node.hash.slice(0, 12));
  row(dl, "last change", ago(node.timestamp));
  row(dl, "author", node.author);
  if (node.email) row(dl, "email", node.email);
  if (node.worktree) row(dl, "path", node.worktree);
  details.append(dl, $("p", "subject", node.subject));

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
      `${node.name} ${node.author} ${node.email} ${node.subject}`
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
worktreeButton.addEventListener("click", () => {
  state.worktreesOnly = !state.worktreesOnly;
  worktreeButton.classList.toggle("active", state.worktreesOnly);
  render();
});
help.querySelector(".close").addEventListener("click", () => help.close());

window.addEventListener("keydown", (event) => {
  if (event.target.matches("input") || help.open) {
    if (event.key === "Escape" && help.open) help.close();
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
  if (event.key === "h") move("parent");
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
  else if (event.key === "w") worktreeButton.click();
  else if (event.key === "Escape") {
    search.value = "";
    applySearch();
  }
});

load({ keepSelection: false }).then(() =>
  setTimeout(() => select(state.data.root), 50),
);
