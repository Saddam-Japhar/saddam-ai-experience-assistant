"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Message = {
  id: number;
  role: "assistant" | "user";
  text: string;
  isStreaming?: boolean;
};

const initialMessages: Message[] = [
  {
    id: 1,
    role: "assistant",
    text: "Hi! I am your resume assistant. Ask about skills, projects, or experience."
  },
  {
    id: 2,
    role: "user",
    text: "Give me a quick summary of your background."
  },
  {
    id: 3,
    role: "assistant",
    text: "I am a software engineer focused on building reliable web products, with experience in frontend systems, APIs, and AI-powered workflows."
  }
];

export default function Page() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isLoading, setIsLoading] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Keeps the chat view pinned to the latest message during normal and streaming updates.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const lastMessage = messages[messages.length - 1];
    const isStreamingUpdate = lastMessage?.role === "assistant" && lastMessage?.isStreaming;
    const behavior: ScrollBehavior = isStreamingUpdate ? "auto" : "smooth";

    const frame = requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior
      });
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    });

    return () => cancelAnimationFrame(frame);
  }, [messages]);

  const canSend = useMemo(() => draft.trim().length > 0 && !isLoading, [draft, isLoading]);

  // Sends a user message, opens stream, and incrementally updates one assistant bubble.
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;

    const userMessage = draft.trim();
    const nextId = Date.now();
    const assistantId = nextId + 1;
    setMessages((prev) => [
      ...prev,
      { id: nextId, role: "user", text: userMessage },
      { id: assistantId, role: "assistant", text: "", isStreaming: true }
    ]);
    setDraft("");

    setIsLoading(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage })
      });

      if (!response.ok) {
        const raw = await response.text();
        let data: { error?: string; details?: string } = {};
        try {
          data = JSON.parse(raw);
        } catch {
          data = { error: raw };
        }
        const errorText =
          typeof data.error === "string"
            ? data.details
              ? `${data.error}\n${data.details}`
              : data.error
            : "I could not generate a response right now.";

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? { ...msg, text: errorText, isStreaming: false }
              : msg
          )
        );
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  text: "I could not generate a response right now.",
                  isStreaming: false
                }
              : msg
          )
        );
        return;
      }

      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? { ...msg, text: fullText, isStreaming: true }
              : msg
          )
        );
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId ? { ...msg, isStreaming: false } : msg
        )
      );
    } catch {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                text: "I could not generate a response right now.",
                isStreaming: false
              }
            : msg
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="h-dvh w-full bg-white">
      <section className="flex h-full w-full flex-col bg-white">
        <header className="border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-900">Saddam’s AI Experience Assistant</h1>
          <p className="text-sm text-slate-500">AI Assistant Trained on My Professional Experience</p>
        </header>

        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-4 pb-36">
          <div className="space-y-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed md:max-w-[75%] ${
                    message.role === "user"
                      ? "bg-teal-700 text-white"
                      : "bg-slate-200 text-slate-900"
                  }`}
                >
                  {message.text || (message.isStreaming ? "Thinking..." : "")}
                  {message.isStreaming ? (
                    <span className="ml-2 inline-block animate-pulse text-xs text-slate-500">
                      typing
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} className="h-2 scroll-mb-28" />
          </div>
        </div>
      </section>

      <form
        onSubmit={onSubmit}
        className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur"
      >
        <div className="flex w-full items-center gap-2 rounded-2xl bg-slate-100 p-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about experience, projects, or skills..."
            className="h-10 flex-1 bg-transparent px-2 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "..." : "Send"}
          </button>
        </div>
      </form>
    </main>
  );
}
