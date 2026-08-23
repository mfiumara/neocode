import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { navigationForView, type ThreadNavigationByView } from "./threadNavigation";
import { isNearTranscriptBottom, nearestTranscriptScrollTop } from "./transcriptScroll";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type AgentActivity,
  type AgentJob,
  type AppSnapshot,
  type ClientMessage,
  type ImageAttachment,
  type RequestedIsolationMode,
  type ServerMessage,
  type TranscriptMessage,
} from "@neocode/protocol";

type ActiveView = { kind: "coordinator" } | { kind: "job"; id: string };
type JobTab = "conversation" | "diff";
interface ContextEntry { id: string; label: string; text: string }
interface PaletteEntry { id: string; label: string; detail: string; action: () => void }
interface ComposerImage extends ImageAttachment { previewUrl: string }
interface BrowserWorkspaceState {
  version: 1;
  active: ActiveView;
  jobTab: JobTab;
  prompt: string;
  isolation: RequestedIsolationMode;
  context: ContextEntry[];
}
const supportedImageTypes = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read the pasted image."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}
function imageSource(image: ImageAttachment): string { return `data:${image.mimeType};base64,${image.data}`; }
function modelKey(model: { provider: string; id: string }): string { return `${model.provider}/${model.id}`; }
function roleLabel(role: TranscriptMessage["role"]): string {
  return role === "user" ? "YOU" : role === "assistant" ? "AGENT" : role.toUpperCase();
}

type NavigableRow =
  | { kind: "message"; key: string; timestamp: number; message: TranscriptMessage }
  | { kind: "job"; key: string; timestamp: number; job: AgentJob };

function statusGlyph(status: AgentJob["status"]): string {
  if (status === "running") return "●";
  if (status === "interrupted") return "↻";
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

function browserStateKey(cwd: string): string {
  return `neocode.browser-state.v1:${encodeURIComponent(cwd)}`;
}

function loadBrowserState(cwd: string, jobs: AgentJob[]): BrowserWorkspaceState | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(browserStateKey(cwd)) || "null");
    if (!value || typeof value !== "object") return undefined;
    const state = value as Partial<BrowserWorkspaceState>;
    if (state.version !== 1 || typeof state.prompt !== "string" || !Array.isArray(state.context)) return undefined;
    const requestedActive = state.active;
    const active: ActiveView = requestedActive?.kind === "job" && jobs.some((job) => job.id === requestedActive.id)
      ? requestedActive
      : { kind: "coordinator" };
    const isolation = state.isolation === "root" || state.isolation === "worktree" ? state.isolation : "auto";
    return {
      version: 1,
      active,
      jobTab: active.kind === "job" && state.jobTab === "diff" ? "diff" : "conversation",
      prompt: state.prompt.slice(0, 100_000),
      isolation,
      context: state.context.slice(0, 50).filter((entry): entry is ContextEntry =>
        !!entry && typeof entry.id === "string" && typeof entry.label === "string" && typeof entry.text === "string"),
    };
  } catch {
    return undefined;
  }
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<ActiveView>({ kind: "coordinator" });
  const [jobTab, setJobTab] = useState<JobTab>("conversation");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [isolation, setIsolation] = useState<RequestedIsolationMode>("auto");
  const [mode, setMode] = useState<"NORMAL" | "INSERT">("INSERT");
  const [navigation, setNavigation] = useState<ThreadNavigationByView>({});
  const [context, setContext] = useState<ContextEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [activitySynced, setActivitySynced] = useState(false);
  const [pendingModel, setPendingModel] = useState<string>();
  const [workspaceStorageKey, setWorkspaceStorageKey] = useState<string>();
  const hydratedWorkspaceRef = useRef<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Record<string, number>>({});
  const imagesRef = useRef<ComposerImage[]>([]);
  const mountedRef = useRef(true);
  // Content may grow between scroll events. A render must not turn an
  // older-message reader back into a live-output follower.
  const followTranscriptRef = useRef(true);

  const send = (message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError("The Neocode backend is not connected.");
      return;
    }
    socket.send(JSON.stringify(message));
  };

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => {
    mountedRef.current = false;
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  }, []);

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
      if (message.type === "snapshot") {
        setSnapshot(message.snapshot);
        setActivitySynced(true);
        setPendingModel(undefined);
        if (hydratedWorkspaceRef.current !== message.snapshot.cwd) {
          const restored = loadBrowserState(message.snapshot.cwd, message.snapshot.jobs);
          if (restored) {
            setActive(restored.active);
            setJobTab(restored.jobTab);
            setPrompt(restored.prompt);
            setIsolation(restored.isolation);
            setContext(restored.context);
          } else {
            setActive({ kind: "coordinator" });
            setJobTab("conversation");
            setPrompt("");
            setIsolation("auto");
            setContext([]);
          }
          hydratedWorkspaceRef.current = message.snapshot.cwd;
          setWorkspaceStorageKey(browserStateKey(message.snapshot.cwd));
        }
      } else if (message.type === "coordinator_status") {
        setSnapshot((current) => current ? {
          ...current,
          coordinator: {
            ...current.coordinator,
            status: message.status,
            activity: message.status === "running" ? current.coordinator.activity : undefined,
          },
        } : current);
      } else if (message.type === "coordinator_activity") {
        setSnapshot((current) => current ? { ...current, coordinator: { ...current.coordinator, activity: message.activity } } : current);
      } else if (message.type === "coordinator_settings") {
        setSnapshot((current) => current ? { ...current, coordinator: { ...current.coordinator, settings: message.settings } } : current);
      } else if (message.type === "coordinator_model_updated") {
        setPendingModel(undefined);
        setSnapshot((current) => current ? { ...current, coordinator: { ...current.coordinator, model: message.model } } : current);
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
        setActivitySynced(false);
        setPendingModel(undefined);
        setSnapshot((current) => current ? {
          ...current,
          coordinator: { ...current.coordinator, activity: undefined },
          jobs: current.jobs.map((job) => ({ ...job, activity: undefined })),
        } : current);
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

  useEffect(() => {
    if (!workspaceStorageKey || !snapshot || hydratedWorkspaceRef.current !== snapshot.cwd) return;
    const state: BrowserWorkspaceState = { version: 1, active, jobTab, prompt, isolation, context };
    try {
      localStorage.setItem(workspaceStorageKey, JSON.stringify(state));
    } catch {
      // Storage can be disabled or full. Browser persistence is best effort and
      // must never prevent prompting or receiving live WebSocket updates.
    }
  }, [workspaceStorageKey, snapshot?.cwd, active, jobTab, prompt, isolation, context]);

  const activeJob = active.kind === "job" ? snapshot?.jobs.find((job) => job.id === active.id) : undefined;
  const messages = active.kind === "coordinator"
    ? snapshot?.coordinator.messages || []
    : activeJob?.messages || [];
  const activeActivity = active.kind === "coordinator" ? snapshot?.coordinator.activity : activeJob?.activity;
  const activityReady = connected && activitySynced;
  const activeWorking = activityReady && (active.kind === "coordinator"
    ? snapshot?.coordinator.status === "running"
    : activeJob?.status === "queued" || activeJob?.status === "running");
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

  const activeThreadKey = active.kind === "job" ? `job:${active.id}` : "coordinator";
  const selectedRow = navigationForView(navigation, activeThreadKey, rows.length).selectedRow;
  const setSelectedRow = (next: number | ((current: number) => number)) => {
    setNavigation((current) => {
      const saved = navigationForView(current, activeThreadKey, rows.length);
      const requested = typeof next === "function" ? next(saved.selectedRow) : next;
      return {
        ...current,
        [activeThreadKey]: navigationForView({ [activeThreadKey]: { ...saved, selectedRow: requested } }, activeThreadKey, rows.length),
      };
    });
  };

  useLayoutEffect(() => {
    setNavigation((current) => {
      const saved = current[activeThreadKey];
      if (!saved && rows.length === 0) return current;
      const resolved = navigationForView(current, activeThreadKey, rows.length);
      if (saved && saved.selectedRow === resolved.selectedRow) return current;
      return { ...current, [activeThreadKey]: resolved };
    });
  }, [activeThreadKey, rows.length]);

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
  useEffect(() => { setPaletteIndex(0); }, [paletteQuery, paletteOpen]);

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
        else if (event.key === "ArrowDown" || (event.key === "j" && !paletteQuery)) {
          event.preventDefault();
          setPaletteIndex((value) => Math.min(filteredPalette.length - 1, value + 1));
        } else if (event.key === "ArrowUp" || (event.key === "k" && !paletteQuery)) {
          event.preventDefault();
          setPaletteIndex((value) => Math.max(0, value - 1));
        } else if (event.key === "Enter" && filteredPalette[paletteIndex]) {
          event.preventDefault();
          filteredPalette[paletteIndex].action();
          setPaletteOpen(false);
        }
        return;
      }
      if (event.key === "Escape") {
        promptRef.current?.blur();
        setMode("NORMAL");
        return;
      }
      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        send({ type: "cycle_variant" });
        return;
      }
      if (event.key === "." && event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        send({ type: "cycle_thinking" });
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
      else if (event.key === ":" || event.key === "`") {
        event.preventDefault();
        setPaletteOpen(true);
        setPaletteQuery("");
      }
      prefix = event.key === "]" || event.key === "[" ? event.key : "";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, paletteOpen, paletteQuery, paletteIndex, filteredPalette, rows, selectedRow, snapshot?.jobs, active]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const saved = scrollPositionsRef.current[activeThreadKey];
    transcript.scrollTop = saved ?? transcript.scrollHeight;
    followTranscriptRef.current = saved === undefined || isNearTranscriptBottom(transcript);
  }, [activeThreadKey, jobTab]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const row = transcript?.querySelector<HTMLElement>(`[data-row-index="${selectedRow}"]`);
    if (!transcript || !row) return;

    const viewport = transcript.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    transcript.scrollTop = nearestTranscriptScrollTop({
      scrollTop: transcript.scrollTop,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      itemTop: item.top,
      itemBottom: item.bottom,
    });
  }, [activeThreadKey, jobTab, selectedRow]);

  const lastRow = rows[rows.length - 1];
  const outputRevision = lastRow?.kind === "message"
    ? `${lastRow.key}:${lastRow.message.text.length}`
    : lastRow ? `${lastRow.key}:${lastRow.job.status}` : "empty";

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [outputRevision, rows.length, snapshot?.coordinator.status, activeJob?.status]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const content = transcriptContentRef.current;
    if (!transcript || !content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      // Covers wrapping Markdown/code while streaming, context-chip/composer
      // height changes, font/layout shifts, and window resizes.
      if (followTranscriptRef.current) transcript.scrollTop = transcript.scrollHeight;
    });
    observer.observe(transcript);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active.kind, active.kind === "job" ? active.id : "coordinator", jobTab]);

  const removeImage = (imageId: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== imageId);
    });
  };

  const addPastedImages = async (files: File[]) => {
    const available = MAX_IMAGE_ATTACHMENTS - imagesRef.current.length;
    if (available <= 0) return setError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
    const accepted = files.slice(0, available);
    if (files.length > available) setError(`Only the first ${available} image${available === 1 ? "" : "s"} were attached.`);
    const additions: ComposerImage[] = [];
    for (const file of accepted) {
      if (!supportedImageTypes.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}.`); continue; }
      if (file.size > MAX_IMAGE_BYTES) { setError(`${file.name || "Image"} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`); continue; }
      const previewUrl = URL.createObjectURL(file);
      try {
        additions.push({ id: crypto.randomUUID(), mimeType: file.type as ImageAttachment["mimeType"], data: await fileAsBase64(file), size: file.size, name: file.name || "clipboard image", previewUrl });
      } catch (readError) {
        URL.revokeObjectURL(previewUrl);
        setError(readError instanceof Error ? readError.message : String(readError));
      }
    }
    if (!mountedRef.current) additions.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    else if (additions.length) setImages((current) => {
      const kept = additions.slice(0, Math.max(0, MAX_IMAGE_ATTACHMENTS - current.length));
      additions.slice(kept.length).forEach((image) => URL.revokeObjectURL(image.previewUrl));
      return [...current, ...kept];
    });
  };

  const settings = snapshot?.coordinator.settings;
  const isPlan = settings?.variant === "plan";
  const thinkingSupported = (settings?.availableThinkingLevels.length || 0) > 0;
  const modelGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<AppSnapshot["coordinator"]["models"]>>();
    for (const model of snapshot?.coordinator.models || []) groups.set(model.provider, [...(groups.get(model.provider) || []), model]);
    return [...groups.entries()];
  }, [snapshot?.coordinator.models]);
  const currentModelKey = snapshot?.coordinator.model ? modelKey(snapshot.coordinator.model) : "";
  const modelSelectDisabled = !connected || !snapshot?.coordinator.models.length
    || snapshot.coordinator.status === "running" || Boolean(pendingModel);

  const submit = (delegate = false) => {
    const text = prompt.trim();
    if ((!text && !images.length) || (delegate && isPlan)) return;
    const attachments = images.map(({ previewUrl: _previewUrl, ...image }) => image);
    followTranscriptRef.current = true;
    send(delegate
      ? { type: "delegate", text, isolation, attachments }
      : { type: "prompt", text, attachments, context: context.map((entry) => `${entry.label}\n${entry.text}`) });
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    setImages([]);
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
            <span className={`agent-orb ${activityReady ? snapshot?.coordinator.status || "idle" : "idle"}`} />
            <span><strong>Coordinator</strong><small>{activityReady && snapshot?.coordinator.status === "running" ? snapshot.coordinator.activity?.description || "Working" : "Main thread"}</small></span>
            <span className="binding">q</span>
          </button>

          <div className="section-label jobs-label"><span>Workers</span><span>{snapshot?.jobs.length || 0}</span></div>
          <div className="jobs-list">
            {snapshot?.jobs.map((job) => (
              <button key={job.id} className={`job-row ${active.kind === "job" && active.id === job.id ? "active" : ""}`} onClick={() => openJob(job)}>
                <span className={`job-glyph ${activityReady || (job.status !== "queued" && job.status !== "running") ? job.status : "disconnected"}`}>{statusGlyph(job.status)}</span>
                <span><strong>{job.title}</strong><small>{activityReady && (job.status === "queued" || job.status === "running") ? job.activity?.description || "Working" : `${isolationLabel(job)} · ${shortPath(job.isolation.path)}`}</small></span>
              </button>
            ))}
            {!snapshot?.jobs.length && <p className="empty-copy">Implementation workers will appear here.</p>}
          </div>

          <div className="key-hints">
            <span><kbd>i</kbd> prompt</span>
            <span><kbd>j k</kbd> navigate</span>
            <span><kbd>h l</kbd> parent / open</span>
            <span><kbd>a</kbd> context</span>
            <span><kbd>`</kbd> palette</span>
            <span><kbd>⇧Tab</kbd> build / plan</span>
          </div>
        </aside>

        <section className="main-panel">
          <div className="view-header">
            <div>
              <span className="eyebrow">{active.kind === "coordinator" ? "MAIN THREAD" : activeJob?.status.toUpperCase()}</span>
              <h1>{active.kind === "coordinator" ? "Coordinator" : activeJob?.title || "Worker"}</h1>
            </div>
            {active.kind === "coordinator" && (
              <label className={`model-selector ${modelSelectDisabled ? "disabled" : ""}`} title="Model used by the coordinator and new workers">
                <span>model</span>
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
                  {modelGroups.map(([provider, models]) => <optgroup key={provider} label={provider}>
                    {models.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.label}</option>)}
                  </optgroup>)}
                </select>
                {pendingModel && <small>switching…</small>}
              </label>
            )}
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
            <div
              className="transcript"
              ref={transcriptRef}
              onScroll={(event) => {
                scrollPositionsRef.current[activeThreadKey] = event.currentTarget.scrollTop;
                followTranscriptRef.current = isNearTranscriptBottom(event.currentTarget);
              }}
            >
              <div className="transcript-content" ref={transcriptContentRef}>
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
                    <span>{roleLabel(row.message.role)}</span>
                    <time>{new Date(row.message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    <button title="Add to context" onClick={(event) => { event.stopPropagation(); setSelectedRow(index); addMessageToContext(row.message); }}>+context</button>
                  </div>
                  <div className="message-body">
                    {row.message.text ? <Markdown>{row.message.text}</Markdown> : (!row.message.attachments?.length && <span className="stream-caret">▋</span>)}
                  </div>
                  {!!row.message.attachments?.length && <AttachmentGallery attachments={row.message.attachments} />}
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
              {activeWorking && (
                <WorkingIndicator activity={activeActivity} agentLabel={active.kind === "coordinator" ? "Coordinator" : activeJob?.title || "Worker"} />
              )}
              <div className="transcript-end" aria-hidden="true" />
              </div>
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
            {!!images.length && (
              <div className="attachment-previews" aria-label="Image attachments">
                {images.map((image) => <div className="attachment-preview" key={image.id}>
                  <a href={image.previewUrl} target="_blank" rel="noreferrer"><img src={image.previewUrl} alt={image.name || "Pasted image"} /></a>
                  <button type="button" aria-label={`Remove ${image.name || "image"}`} onClick={() => removeImage(image.id)}>×</button>
                </div>)}
              </div>
            )}
            <textarea
              ref={promptRef}
              value={prompt}
              rows={2}
              placeholder={active.kind === "coordinator" ? "Ask, investigate, or describe an implementation…" : "Send guidance through the coordinator…"}
              onFocus={() => setMode("INSERT")}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => {
                const files = [...event.clipboardData.items]
                  .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                  .map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
                if (files.length) {
                  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
                  void addPastedImages(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(false);
                }
              }}
            />
            <div className="composer-actions">
              <span className={`mode-badge ${mode.toLowerCase()}`}>{mode}</span>
              <div className="runtime-controls" aria-label="Pi runtime settings">
                <button type="button" className={`runtime-chip variant-${settings?.variant || "loading"}`} disabled={!settings?.availableVariants.length} onClick={() => send({ type: "cycle_variant" })} title="Cycle Build / Plan (Shift+Tab)">
                  <span>mode</span><strong>{settings?.variant || "loading"}</strong><kbd>⇧Tab</kbd>
                </button>
                <button type="button" className="runtime-chip" disabled={!thinkingSupported} onClick={() => send({ type: "cycle_thinking" })} title={thinkingSupported ? "Cycle reasoning effort (Ctrl+.)" : "This model does not support reasoning effort"}>
                  <span>effort</span><strong>{thinkingSupported ? settings?.thinkingLevel : "n/a"}</strong><kbd>⌃.</kbd>
                </button>
              </div>
              <span className="muted composer-hint">↵ send · ⇧↵ newline · esc normal</span>
              <div className="action-buttons">
                <label className="isolation-picker" title="auto uses root only for clearly read-only tasks">
                  isolation
                  <select value={isolation} onChange={(event) => setIsolation(event.target.value as RequestedIsolationMode)}>
                    <option value="auto">auto</option>
                    <option value="worktree">worktree</option>
                    <option value="root">root</option>
                  </select>
                </label>
                <button className="delegate-button" title={isPlan ? "Switch to Build mode to delegate" : undefined} disabled={(!prompt.trim() && !images.length) || isPlan} onClick={() => submit(true)}>Hand off</button>
                <button className="send-button" disabled={!prompt.trim() && !images.length} onClick={() => submit(false)}>Send <span>↵</span></button>
              </div>
            </div>
          </div>
        </section>
      </section>

      {paletteOpen && (
        <div className="palette-backdrop" onMouseDown={() => setPaletteOpen(false)}>
          <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
            <div className="palette-input"><span>⌕</span><input autoFocus value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Find threads, workers and commands…" /></div>
            <div className="palette-results">
              {filteredPalette.map((entry, index) => (
                <button key={entry.id} className={index === paletteIndex ? "active" : ""} onMouseEnter={() => setPaletteIndex(index)} onClick={() => { entry.action(); setPaletteOpen(false); }}>
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

function AttachmentGallery({ attachments }: { attachments: ImageAttachment[] }) {
  return <div className="message-attachments">{attachments.map((image) => {
    const source = imageSource(image);
    return <a key={image.id} href={source} target="_blank" rel="noreferrer" title="View full image">
      <img src={source} alt={image.name || "Image attachment"} loading="lazy" />
    </a>;
  })}</div>;
}

function WorkingIndicator({ activity: current, agentLabel }: { activity?: AgentActivity; agentLabel: string }) {
  return <div className={`working-row ${current?.phase || "starting"}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="working-spinner" aria-hidden="true" />
    <span className="sr-only">{agentLabel} is working: </span>
    <span className="working-description">{current?.description || "Working"}</span>
  </div>;
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
