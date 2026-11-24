import { useT } from "@doco/shared/i18n/react";
import { BrainoMark } from "@doco/ui";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";

const API_PATH = "/api/v1/senor-braino.json";
const COLLAPSE_KEY = "braino:senor-braino:collapsed";
const RAIL_COLLAPSED = "32px";
const RAIL_DEFAULT = "320px";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

interface ChatSnapshot {
  messages: ChatMessage[];
  workspace: { handle: string };
  error?: string;
}

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, String(value));
  } catch {
    // Storage can be disabled; the rail still works for this page view.
  }
}

function PanelToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      <line x1="7" y1="4" x2="7" y2="20" />
      <polygon
        points={open ? "13 8 17 12 13 16" : "15 8 11 12 15 16"}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function messageParts(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const expression = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const href = match[2] ?? match[3] ?? "";
    const label = match[1] ?? href;
    let internal: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const url = new URL(href, window.location.origin);
        if (url.origin === window.location.origin)
          internal = `${url.pathname}${url.search}${url.hash}`;
      } catch {
        internal = null;
      }
    }
    parts.push(
      internal ? (
        <Link key={key++} to={internal} className="underline underline-offset-2">
          {label}
        </Link>
      ) : (
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          {label}
        </a>
      ),
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function Message({ message }: { message: ChatMessage }) {
  const t = useT();
  const assistant = message.role === "assistant";
  return (
    <div className={`mb-3 flex flex-col ${assistant ? "items-end" : "items-start"}`}>
      <div className={`flex w-full items-end gap-2 ${assistant ? "justify-end" : "justify-start"}`}>
        <div
          className={`neu-surface max-w-[82%] rounded-lg px-2.5 py-1.5 ${assistant ? "bg-primary/10" : "bg-card"}`}
        >
          <div className="whitespace-pre-wrap break-words">{messageParts(message.text)}</div>
        </div>
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {assistant ? "Señor Braino" : t("You")}
      </div>
    </div>
  );
}

export function AgentSidebar() {
  const t = useT();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageList = useRef<HTMLDivElement | null>(null);

  const applySnapshot = useCallback((snapshot: ChatSnapshot) => {
    setMessages(snapshot.messages);
    setWorkspace(snapshot.workspace.handle);
    setError(snapshot.error ?? null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(API_PATH, { signal: controller.signal })
      .then(async (response) => {
        const snapshot = (await response.json()) as ChatSnapshot;
        if (!response.ok) throw new Error(snapshot.error ?? "Could not load Señor Braino.");
        applySnapshot(snapshot);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load Señor Braino.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applySnapshot]);

  useLayoutEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  });

  const setCollapsedPersistent = (value: boolean) => {
    setCollapsed(value);
    writeCollapsed(value);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || asking) return;
    setQuestion("");
    setError(null);
    setAsking(true);
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await fetch(API_PATH, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ question: text }),
      });
      const snapshot = (await response.json()) as ChatSnapshot;
      if (!response.ok) throw new Error(snapshot.error ?? "Señor Braino could not answer.");
      applySnapshot(snapshot);
    } catch (cause) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setQuestion(text);
      setError(cause instanceof Error ? cause.message : "Señor Braino could not answer.");
    } finally {
      setAsking(false);
    }
  };

  const railStyle = {
    "--senor-doco-current-width": collapsed ? RAIL_COLLAPSED : RAIL_DEFAULT,
    transition: "width 180ms ease-out",
  } as CSSProperties & { "--senor-doco-current-width": string };

  const rail = (
    <aside
      className="senor-doco-rail flex h-full shrink-0 flex-col overflow-hidden border-e border-border bg-card"
      data-collapsed={collapsed ? "true" : "false"}
      style={railStyle}
      aria-busy={asking}
      aria-label={asking ? t("Señor Braino is thinking…") : t("Señor Braino")}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsedPersistent(false)}
          aria-label={t("Señor Braino")}
          className="group relative flex h-full w-full shrink-0 flex-col items-center justify-start gap-2 py-3 hover:bg-input"
        >
          <PanelToggleIcon open />
          <div
            className="select-none text-[12px] font-semibold text-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            {t("Señor Braino")}
          </div>
        </button>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
            <div className="select-none truncate text-sm font-semibold text-foreground">
              {t("Señor Braino")}
            </div>
            <button
              type="button"
              onClick={() => setCollapsedPersistent(true)}
              aria-label={t("Señor Braino")}
              title={t("Señor Braino")}
              className="neu-button neu-small inline-flex h-6 w-6 items-center justify-center rounded-md"
            >
              <PanelToggleIcon open={false} />
            </button>
          </div>

          <div className="shrink-0 border-b border-border px-3 py-1.5 text-[10px] leading-snug text-muted-foreground">
            {t("Ask about anything in this workspace. Answers stay grounded in its records.")}
          </div>
          <div className="flex min-h-[2.25rem] shrink-0 items-center border-b border-border px-3 pb-2 pt-1.5 font-mono text-[10px] text-muted-foreground">
            {workspace ? `workspace / ${workspace}` : "workspace"}
          </div>

          <div
            ref={messageList}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 text-xs leading-relaxed"
          >
            {loading ? (
              <p className="text-muted-foreground">{t("Señor Braino is thinking…")}</p>
            ) : null}
            {!loading && messages.length === 0 ? (
              <div className="my-auto py-8 text-center text-muted-foreground">
                <p className="font-semibold text-foreground">{t("Ask your workspace")}</p>
                <p className="mt-1 text-[11px]">
                  {t(
                    "Señor Braino searches the records you can access, then answers through your configured chat model.",
                  )}
                </p>
              </div>
            ) : null}
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            <output className="flex justify-end pb-3 pe-1 pt-1" aria-live="polite">
              {asking ? (
                <BrainoMark
                  height={28}
                  variant="mark"
                  active
                  ariaLabel={t("Señor Braino is thinking…")}
                />
              ) : (
                <span className="neu-surface inline-flex h-7 w-7 items-center justify-center rounded-full bg-card text-[15px] font-semibold text-muted-foreground">
                  •
                </span>
              )}
            </output>
          </div>

          <form onSubmit={send} className="shrink-0 border-t border-border bg-card px-3 py-2">
            {error ? (
              <p role="alert" className="mb-2 text-[11px] text-destructive">
                {error}
              </p>
            ) : null}
            <label className="sr-only" htmlFor="senor-braino-question">
              {t("Ask Señor Braino")}
            </label>
            <textarea
              id="senor-braino-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t("Ask about anything in this workspace")}
              rows={2}
              maxLength={4000}
              className="min-h-[44px] w-full resize-none rounded-md px-2 py-1.5 text-xs focus:border-primary focus:outline-none"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="mt-1 flex items-center justify-end gap-2">
              <button
                type="submit"
                disabled={!question.trim() || asking}
                className="neu-button rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
              >
                {asking ? t("Thinking…") : t("Ask")}
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  );

  return (
    <>
      {collapsed ? null : (
        <button
          type="button"
          aria-label={t("Señor Braino")}
          className="senor-doco-backdrop"
          onClick={() => setCollapsedPersistent(true)}
        />
      )}
      {rail}
    </>
  );
}
