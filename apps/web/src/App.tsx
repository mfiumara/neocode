import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentJob,
  AppSnapshot,
  ClientMessage,
  RequestedIsolationMode,
  ServerMessage,
  TranscriptMessage,
} from "@neocode/protocol";

type ActiveView = { kind: "coordinator" } | { kind: "job"; id: string };
type JobTab = "conversation" | "diff";
interface ContextEntry { id: string; label: string; text: string }
interface PaletteEntry { id: string; label: string; detail: string; action: () => void }
type NavigableRow =
  | { kind: "message"; key: string; timestamp: number; message: TranscriptMessage }
  | { kind: "job"; key: string; timestamp: number; job: AgentJob };

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

function isolationLabel(job: AgentJob): string {
  return job.isolation.requested === "auto"
    ? `auto→${job.isolation.mode}`
    : job.isolation.mode;
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<ActiveView>({ kind: "coordinator" });
  const [jobTab, setJobTab] = useState<JobTab>("conversation");
  const [prompt, setPrompt] = useState("");
  const [isolation, setIsolation] = useState<RequestedIsolationMode>("auto");
  const [mode, setMode] = useState<"NORMAL" | "INSERT">("INSERT");
  const [selectedRow, setSelectedRow] = useState(0);
  const [context, setContext] = useState<ContextEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
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
    const url = `${protocol}://${location.host}/ws`;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const handleMessage = (raw: MessageEvent) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.data) as ServerMessage;
      } catch {
        setError("Received an invalid message from the Neocode backend.");
        return;
      }
      if (message.type === "snapshot") setSnapshot(message.snapshot);
      else if (message.type === "coordinator_status") {
        setSnapshot((current) => current ? {
          ...current,
          coordinator: { ...current.coordinator, status: message.status },
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
      } else if (message.type === "error") setError(message.message);
    };

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
        setError(undefined);
      };
      socket.onmessage = handleMessage;
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = undefined;
        setConnected(false);
        if (!disposed) {
          const delay = Math.min(500 * 2 ** attempts, 5_000);
          attempts += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, []);

  const activeJob = active.kind === "job" ? snapshot?.jobs.find((job) => job.id === active.id) : undefined;
  const messages = active.kind === "coordinator"
    ? snapshot?.coordinator.messages || []
    : activeJob?.messages || [];
  const rows = useMemo<NavigableRow[]>(() => {
    const transcriptRows: NavigableRow[] = messages.map((message) => ({
      kind: "message",
      key: `message-${message.id}`,
      timestamp: message.timestamp,
      message,
    }));
    if (active.kind === "job") return transcriptRows;
    const jobRows: NavigableRow[] = (snapshot?.jobs || []).map((job) => ({
      kind: "job",
      key: `job-${job.id}`,
      timestamp: job.createdAt,
      job,
    }));
    return [...transcriptRows, ...jobRows].sort((a, b) => a.timestamp - b.timestamp);
  }, [active.kind, messages, snapshot?.jobs]);

  useEffect(() => {
    setSelectedRow(Math.max(0, rows.length - 1));
  }, [active.kind, active.kind === "job" ? active.id : "coordinator", rows.length]);

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
        detail: `${job.status} · ${isolationLabel(job)} · ${shortPath(job.isolation.path)}`,
        action: () => openJob(job),
      });
    }
    return entries;
  }, [snapshot?.jobs]);

  const filteredPalette = paletteEntries.filter((entry) =>
    `${entry.label} ${entry.detail}`.toLowerCase().includes(paletteQuery.toLowerCase()));

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
    const row = rows[selectedRow];
    if (row?.kind === "message") addMessageToContext(row.message);
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
      else if (event.key === "j" || event.key === "ArrowDown") setSelectedRow((value) => Math.min(Math.max(0, rows.length - 1), value + 1));
      else if (event.key === "k" || event.key === "ArrowUp") setSelectedRow((value) => Math.max(0, value - 1));
      else if (event.key === "l" || event.key === "ArrowRight") {
        const row = rows[selectedRow];
        if (row?.kind === "job") openJob(row.job);
      }
      else if (event.key === "h" || event.key === "ArrowLeft") openCoordinator();
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
  }, [mode, paletteOpen, rows, selectedRow, snapshot?.jobs, active]);

  useEffect(() => {
    document.querySelector(`[data-row-index="${selectedRow}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedRow]);

  const submit = (delegate = false) => {
    const text = prompt.trim();
    if (!text) return;
    send(delegate
      ? { type: "delegate", text, isolation }
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
                <span><strong>{job.title}</strong><small>{isolationLabel(job)} · {shortPath(job.isolation.path)}</small></span>
              </button>
            ))}
            {!snapshot?.jobs.length && <p className="empty-copy">Implementation workers will appear here.</p>}
          </div>

          <div className="key-hints">
            <span><kbd>i</kbd> prompt</span>
            <span><kbd>j k</kbd> navigate</span>
            <span><kbd>h l</kbd> parent / open</span>
            <span><kbd>a</kbd> context</span>
          </div>
        </aside>

        <section className="main-panel">
          <div className="view-header">
            <div>
              <span className="eyebrow">{active.kind === "coordinator" ? "MAIN THREAD" : activeJob?.status.toUpperCase()}</span>
              <h1>{active.kind === "coordinator" ? "Coordinator" : activeJob?.title || "Worker"}</h1>
            </div>
            {activeJob && (
              <div className="view-controls">
                <span className={`isolation-badge ${activeJob.isolation.mode}`} title={activeJob.isolation.path}>
                  {isolationLabel(activeJob)} · {shortPath(activeJob.isolation.path)}
                </span>
                <code>{activeJob.id}</code>
                <div className="view-tabs">
                  <button className={jobTab === "conversation" ? "active" : ""} onClick={() => setJobTab("conversation")}>Conversation</button>
                  <button className={jobTab === "diff" ? "active" : ""} onClick={() => setJobTab("diff")}>Diff</button>
                </div>
                {activeJob.status === "running" && <button className="cancel-button" onClick={() => send({ type: "cancel_job", jobId: activeJob.id })}>Cancel</button>}
              </div>
            )}
          </div>

          {jobTab === "diff" && activeJob ? (
            <DiffView diff={activeJob.diff || ""} />
          ) : (
            <div className="transcript">
              {!rows.length && (
                <div className="empty-view">
                  {active.kind === "coordinator" ? "Type a prompt to start." : "Worker is starting."}
                </div>
              )}
              {rows.map((row, index) => row.kind === "message" ? (
                <article
                  key={row.key}
                  data-row-index={index}
                  className={`message ${row.message.role} ${index === selectedRow && mode === "NORMAL" ? "selected" : ""}`}
                  onClick={() => setSelectedRow(index)}
                >
                  <div className="message-meta">
                    <span>{row.message.role === "user" ? "YOU" : row.message.role === "assistant" ? "AGENT" : "TOOL"}</span>
                    <time>{new Date(row.message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    <button title="Add to context" onClick={(event) => { event.stopPropagation(); setSelectedRow(index); addMessageToContext(row.message); }}>+context</button>
                  </div>
                  <div className="message-body">{row.message.text || <span className="stream-caret">▋</span>}</div>
                </article>
              ) : (
                <button
                  key={row.key}
                  data-row-index={index}
                  className={`worker-line ${row.job.status} ${index === selectedRow && mode === "NORMAL" ? "selected" : ""}`}
                  onClick={() => setSelectedRow(index)}
                  onDoubleClick={() => openJob(row.job)}
                >
                  <span className="worker-arrow">→</span>
                  <span className="worker-status">{row.job.status}</span>
                  <span className="worker-title">{row.job.title}</span>
                  <code>{row.job.id}</code>
                  <span className="worker-open">l</span>
                </button>
              ))}
              {active.kind === "coordinator" && snapshot?.coordinator.status === "running" && (
                <div className="working-row"><span /><span>Coordinator is working</span></div>
              )}
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
                <label className="isolation-picker" title="auto uses root only for clearly read-only tasks">
                  isolation
                  <select value={isolation} onChange={(event) => setIsolation(event.target.value as RequestedIsolationMode)}>
                    <option value="auto">auto</option>
                    <option value="worktree">worktree</option>
                    <option value="root">root</option>
                  </select>
                </label>
                <button className="delegate-button" disabled={!prompt.trim()} onClick={() => submit(true)}>Hand off</button>
                <button className="send-button" disabled={!prompt.trim()} onClick={() => submit(false)}>Send <span>↵</span></button>
              </div>
            </div>
          </div>
        </section>
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
