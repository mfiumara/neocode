import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentJob,
  AppSnapshot,
  ClientMessage,
  ServerMessage,
  TranscriptMessage,
} from "@neocode/protocol";

type ActiveView = { kind: "coordinator" } | { kind: "job"; id: string };
type JobTab = "conversation" | "diff";
interface ContextEntry { id: string; label: string; text: string }
interface PaletteEntry { id: string; label: string; detail: string; action: () => void }

function statusGlyph(status: AgentJob["status"]): string {
  if (status === "running") return "●";
  if (status === "completed") return "✓";
  if (status === "failed") return "!";
  if (status === "cancelled") return "×";
  return "○";
}

function shortPath(path: string): string {
  const pieces = path.split("/").filter(Boolean);
  return pieces.slice(-2).join("/") || path;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<ActiveView>({ kind: "coordinator" });
  const [jobTab, setJobTab] = useState<JobTab>("conversation");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"NORMAL" | "INSERT">("INSERT");
  const [selectedMessage, setSelectedMessage] = useState(0);
  const [context, setContext] = useState<ContextEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [pendingModel, setPendingModel] = useState<string>();
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const send = (message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError("The Neocode backend is not connected.");
      return;
    }
    socket.send(JSON.stringify(message));
  };

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socketRef.current = socket;
    socket.onopen = () => setConnected(true);
    socket.onclose = () => {
      setConnected(false);
      setPendingModel(undefined);
    };
    socket.onerror = () => setError("Lost connection to the Neocode backend.");
    socket.onmessage = (raw) => {
      const message = JSON.parse(raw.data) as ServerMessage;
      if (message.type === "snapshot") setSnapshot(message.snapshot);
      else if (message.type === "coordinator_status") {
        setSnapshot((current) => current ? {
          ...current,
          coordinator: { ...current.coordinator, status: message.status },
        } : current);
      } else if (message.type === "coordinator_model_updated") {
        setPendingModel(undefined);
        setSnapshot((current) => current ? {
          ...current,
          coordinator: { ...current.coordinator, model: message.model },
        } : current);
      } else if (message.type === "coordinator_message") {
        setSnapshot((current) => current ? {
          ...current,
          coordinator: {
            ...current.coordinator,
            messages: [...current.coordinator.messages, message.message],
          },
        } : current);
      } else if (message.type === "coordinator_message_updated") {
        setSnapshot((current) => current ? {
          ...current,
          coordinator: {
            ...current.coordinator,
            messages: current.coordinator.messages.map((entry) =>
              entry.id === message.message.id ? message.message : entry),
          },
        } : current);
      } else if (message.type === "coordinator_delta") {
        setSnapshot((current) => current ? {
          ...current,
          coordinator: {
            ...current.coordinator,
            messages: current.coordinator.messages.map((entry) =>
              entry.id === message.messageId ? { ...entry, text: entry.text + message.delta } : entry),
          },
        } : current);
      } else if (message.type === "job_updated") {
        setSnapshot((current) => current ? {
          ...current,
          jobs: [message.job, ...current.jobs.filter((job) => job.id !== message.job.id)]
            .sort((a, b) => b.createdAt - a.createdAt),
        } : current);
      } else if (message.type === "error") {
        setPendingModel(undefined);
        setError(message.message);
      }
    };
    return () => socket.close();
  }, []);

  const activeJob = active.kind === "job" ? snapshot?.jobs.find((job) => job.id === active.id) : undefined;
  const messages = active.kind === "coordinator"
    ? snapshot?.coordinator.messages || []
    : activeJob?.messages || [];

  useEffect(() => {
    setSelectedMessage(Math.max(0, messages.length - 1));
  }, [active.kind, active.kind === "job" ? active.id : "coordinator", messages.length]);

  const openCoordinator = () => {
    setActive({ kind: "coordinator" });
    setJobTab("conversation");
  };

  const openJob = (job: AgentJob) => {
    setActive({ kind: "job", id: job.id });
    setJobTab("conversation");
  };

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const entries: PaletteEntry[] = [
      { id: "coordinator", label: "Coordinator", detail: "main thread", action: openCoordinator },
      { id: "focus-prompt", label: "Focus prompt", detail: "command", action: () => focusPrompt() },
      { id: "abort", label: "Abort coordinator", detail: "command", action: () => send({ type: "abort" }) },
    ];
    for (const job of snapshot?.jobs || []) {
      entries.push({
        id: `job-${job.id}`,
        label: job.title,
        detail: `${job.status} · ${job.branch}`,
        action: () => openJob(job),
      });
    }
    return entries;
  }, [snapshot?.jobs]);

  const filteredPalette = paletteEntries.filter((entry) =>
    `${entry.label} ${entry.detail}`.toLowerCase().includes(paletteQuery.toLowerCase()));
  const modelGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<AppSnapshot["coordinator"]["models"]>>();
    for (const model of snapshot?.coordinator.models || []) {
      const group = groups.get(model.provider) || [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()];
  }, [snapshot?.coordinator.models]);
  const currentModelKey = snapshot?.coordinator.model ? modelKey(snapshot.coordinator.model) : "";
  const modelSelectDisabled = !connected || !snapshot?.coordinator.models.length
    || snapshot.coordinator.status === "running" || Boolean(pendingModel);

  function focusPrompt() {
    setPaletteOpen(false);
    setMode("INSERT");
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  function addMessageToContext(message: TranscriptMessage | undefined) {
    if (!message?.text) return;
    const entry: ContextEntry = {
      id: message.id,
      label: `${active.kind === "coordinator" ? "coordinator" : activeJob?.title} · ${message.role}`,
      text: message.text,
    };
    setContext((current) => current.some((item) => item.id === entry.id) ? current : [...current, entry]);
  }

  function addSelectedToContext() {
    addMessageToContext(messages[selectedMessage]);
  }

  useEffect(() => {
    let prefix = "";
    const onKey = (event: KeyboardEvent) => {
      if (paletteOpen) {
        if (event.key === "Escape") setPaletteOpen(false);
        return;
      }
      if (event.key === "Escape") {
        promptRef.current?.blur();
        setMode("NORMAL");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen(true);
        setPaletteQuery("");
        return;
      }
      if (mode === "INSERT") return;
      if (prefix === "]" && event.key === "j") {
        const jobs = snapshot?.jobs || [];
        const index = active.kind === "job" ? jobs.findIndex((job) => job.id === active.id) : -1;
        if (jobs.length) openJob(jobs[(index + 1) % jobs.length]!);
      } else if (prefix === "[" && event.key === "j") {
        const jobs = snapshot?.jobs || [];
        const index = active.kind === "job" ? jobs.findIndex((job) => job.id === active.id) : 0;
        if (jobs.length) openJob(jobs[(index - 1 + jobs.length) % jobs.length]!);
      } else if (event.key === "i") focusPrompt();
      else if (event.key === "j") setSelectedMessage((value) => Math.min(messages.length - 1, value + 1));
      else if (event.key === "k") setSelectedMessage((value) => Math.max(0, value - 1));
      else if (event.key === "a") addSelectedToContext();
      else if (event.key === "q") openCoordinator();
      else if (event.key === ":") {
        setPaletteOpen(true);
        setPaletteQuery("");
      }
      prefix = event.key === "]" || event.key === "[" ? event.key : "";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, paletteOpen, messages, selectedMessage, snapshot?.jobs, active]);

  useEffect(() => {
    document.querySelector(`[data-message-index="${selectedMessage}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedMessage]);

  const submit = (delegate = false) => {
    const text = prompt.trim();
    if (!text) return;
    send(delegate
      ? { type: "delegate", text }
      : { type: "prompt", text, context: context.map((entry) => `${entry.label}\n${entry.text}`) });
    setPrompt("");
    if (!delegate) setContext([]);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">N</span><span>neocode</span></div>
        <button className="workspace-chip" onClick={() => setPaletteOpen(true)}>
          <span className="muted">workspace</span> {snapshot ? shortPath(snapshot.cwd) : "loading…"}
          <kbd>⌘P</kbd>
        </button>
        <div className={`connection ${connected ? "online" : "offline"}`}>
          <span />{connected ? "local" : "offline"}
        </div>
      </header>

      <section className="workspace-grid">
        <aside className="rail">
          <div className="section-label">Threads</div>
          <button className={`thread-row ${active.kind === "coordinator" ? "active" : ""}`} onClick={openCoordinator}>
            <span className={`agent-orb ${snapshot?.coordinator.status || "idle"}`} />
            <span><strong>Coordinator</strong><small>Main thread</small></span>
            <span className="binding">q</span>
          </button>

          <div className="section-label jobs-label"><span>Workers</span><span>{snapshot?.jobs.length || 0}</span></div>
          <div className="jobs-list">
            {snapshot?.jobs.map((job) => (
              <button key={job.id} className={`job-row ${active.kind === "job" && active.id === job.id ? "active" : ""}`} onClick={() => openJob(job)}>
                <span className={`job-glyph ${job.status}`}>{statusGlyph(job.status)}</span>
                <span><strong>{job.title}</strong><small>{job.branch}</small></span>
              </button>
            ))}
            {!snapshot?.jobs.length && <p className="empty-copy">Implementation workers will appear here.</p>}
          </div>

          <div className="key-hints">
            <span><kbd>i</kbd> prompt</span>
            <span><kbd>j k</kbd> navigate</span>
            <span><kbd>a</kbd> context</span>
            <span><kbd>]j</kbd> next worker</span>
          </div>
        </aside>

        <section className="main-panel">
          <div className="view-header">
            <div>
              <span className="eyebrow">{active.kind === "coordinator" ? "MAIN THREAD" : activeJob?.status.toUpperCase()}</span>
              <h1>{active.kind === "coordinator" ? "Coordinator" : activeJob?.title || "Worker"}</h1>
            </div>
            <div className="view-header-actions">
              <label
                className={`model-selector ${modelSelectDisabled ? "disabled" : ""}`}
                title={snapshot?.coordinator.status === "running" ? "Model changes are available when the coordinator is idle" : "Model used by the coordinator and new workers"}
              >
                <span>Coordinator model</span>
                <div>
                  <select
                    aria-label="Coordinator model"
                    value={pendingModel || currentModelKey}
                    disabled={modelSelectDisabled}
                    onChange={(event) => {
                      const choice = snapshot?.coordinator.models.find((model) => modelKey(model) === event.target.value);
                      if (!choice || event.target.value === currentModelKey) return;
                      setPendingModel(event.target.value);
                      send({ type: "set_model", model: { provider: choice.provider, id: choice.id } });
                    }}
                  >
                    {!snapshot && <option value="">Loading models…</option>}
                    {snapshot && !snapshot.coordinator.models.length && <option value="">No configured models</option>}
                    {snapshot && !snapshot.coordinator.model && snapshot.coordinator.models.length > 0 && <option value="">Select a model…</option>}
                    {modelGroups.map(([provider, models]) => (
                      <optgroup key={provider} label={provider}>
                        {models.map((model) => (
                          <option key={modelKey(model)} value={modelKey(model)}>{model.label} · {model.provider}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <span className="select-chevron">⌄</span>
                </div>
                {pendingModel && <small>switching…</small>}
              </label>
              {activeJob && (
                <div className="view-tabs">
                  <button className={jobTab === "conversation" ? "active" : ""} onClick={() => setJobTab("conversation")}>Conversation</button>
                  <button className={jobTab === "diff" ? "active" : ""} onClick={() => setJobTab("diff")}>Diff</button>
                </div>
              )}
            </div>
          </div>

          {jobTab === "diff" && activeJob ? (
            <DiffView diff={activeJob.diff || ""} />
          ) : (
            <div className="transcript">
              {!messages.length && (
                <div className="welcome-card">
                  <span className="welcome-glyph">⌁</span>
                  <h2>{active.kind === "coordinator" ? "What are we building?" : "Worker is starting…"}</h2>
                  <p>{active.kind === "coordinator"
                    ? "Investigate with the coordinator. Implementation is handed to isolated workers so this thread stays responsive."
                    : "Its reasoning, tool activity and final report will stream into this buffer."}</p>
                </div>
              )}
              {messages.map((message, index) => (
                <article
                  key={message.id}
                  data-message-index={index}
                  className={`message ${message.role} ${index === selectedMessage && mode === "NORMAL" ? "selected" : ""}`}
                  onClick={() => setSelectedMessage(index)}
                >
                  <div className="message-meta">
                    <span>{message.role === "user" ? "YOU" : message.role === "assistant" ? "AGENT" : "TOOL"}</span>
                    <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    <button title="Add to context" onClick={(event) => { event.stopPropagation(); setSelectedMessage(index); addMessageToContext(message); }}>＋ context</button>
                  </div>
                  <div className="message-body">{message.text || <span className="stream-caret">▋</span>}</div>
                </article>
              ))}
            </div>
          )}

          <div className={`composer ${mode === "INSERT" ? "focused" : ""}`}>
            {context.length > 0 && (
              <div className="context-chips">
                {context.map((entry) => (
                  <button key={entry.id} onClick={() => setContext((items) => items.filter((item) => item.id !== entry.id))}>
                    <span>◇</span>{entry.label}<b>×</b>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={promptRef}
              value={prompt}
              rows={2}
              placeholder={active.kind === "coordinator" ? "Ask, investigate, or describe an implementation…" : "Send guidance through the coordinator…"}
              onFocus={() => setMode("INSERT")}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(false);
                }
              }}
            />
            <div className="composer-actions">
              <span className={`mode-badge ${mode.toLowerCase()}`}>{mode}</span>
              <span className="muted">↵ send · ⇧↵ newline · esc normal</span>
              <div className="action-buttons">
                <button className="delegate-button" disabled={!prompt.trim()} onClick={() => submit(true)}>Hand off</button>
                <button className="send-button" disabled={!prompt.trim()} onClick={() => submit(false)}>Send <span>↵</span></button>
              </div>
            </div>
          </div>
        </section>

        <aside className="context-rail">
          <div className="section-label">Context basket <span>{context.length}</span></div>
          {context.length ? context.map((entry) => (
            <div className="context-card" key={entry.id}>
              <button onClick={() => setContext((items) => items.filter((item) => item.id !== entry.id))}>×</button>
              <strong>{entry.label}</strong>
              <p>{entry.text.slice(0, 180)}</p>
            </div>
          )) : (
            <div className="context-empty">
              <span>◇</span>
              <p>Select any message and press <kbd>a</kbd> to carry it into the next prompt.</p>
            </div>
          )}
          {activeJob && (
            <div className="worker-facts">
              <div><span>branch</span><code>{activeJob.branch}</code></div>
              <div><span>worktree</span><code>{shortPath(activeJob.worktree)}</code></div>
              <div><span>job</span><code>{activeJob.id}</code></div>
              {activeJob.status === "running" && <button onClick={() => send({ type: "cancel_job", jobId: activeJob.id })}>Cancel worker</button>}
            </div>
          )}
        </aside>
      </section>

      {paletteOpen && (
        <div className="palette-backdrop" onMouseDown={() => setPaletteOpen(false)}>
          <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
            <div className="palette-input"><span>⌕</span><input autoFocus value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && filteredPalette[0]) { filteredPalette[0].action(); setPaletteOpen(false); } }} placeholder="Find threads, workers and commands…" /></div>
            <div className="palette-results">
              {filteredPalette.map((entry) => (
                <button key={entry.id} onClick={() => { entry.action(); setPaletteOpen(false); }}>
                  <span>{entry.label}</span><small>{entry.detail}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && <button className="error-toast" onClick={() => setError(undefined)}>{error}<span>×</span></button>}
    </main>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="diff-empty"><span>✓</span><h2>No diff available</h2><p>The worker may still be running or made no file changes.</p></div>;
  return (
    <div className="diff-view">
      {diff.split("\n").map((line, index) => (
        <div key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : line.startsWith("diff ") ? "file" : ""}>
          <span>{index + 1}</span><code>{line || " "}</code>
        </div>
      ))}
    </div>
  );
}
