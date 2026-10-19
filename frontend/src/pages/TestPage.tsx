import { useT } from "../lib/i18n"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Button } from "../components/ui/button"
import { Check, ChevronDown, Send, RefreshCw, Bot, Brain, Zap } from "lucide-react"
import { getAuthHeader } from "../lib/auth"
import { API_BASE } from "../lib/api"
import { toast } from "sonner"
import {
  FALLBACK_CHAT_MODELS,
  chooseDefaultModel,
  fetchModelOptions,
  filterTextTestModels,
  formatModelOptionLabel,
  groupModelOptions,
  isThinkingVariant,
  type ModelOption,
} from "../lib/models"

// 渲染消息内容：自动把 Markdown 图片和图片 URL 渲染成 <img>
function MessageContent({ content }: { content: string }) {
  type Seg = { start: number; end: number; url: string }
  const segs: Seg[] = []
  const fullRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s"<>]+\.(?:jpg|jpeg|png|webp|gif)[^\s"<>]*)/gi
  let m: RegExpExecArray | null
  while ((m = fullRe.exec(content)) !== null) {
    segs.push({ start: m.index, end: m.index + m[0].length, url: (m[1] || m[2]) as string })
  }

  if (segs.length === 0) {
    return <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
  }

  const nodes: ReactNode[] = []
  let cursor = 0
  segs.forEach((seg, i) => {
    if (seg.start > cursor) {
      nodes.push(<span key={"t" + i}>{content.slice(cursor, seg.start)}</span>)
    }
    nodes.push(
      <div key={"i" + i} className="my-2">
        <img
          src={seg.url}
          alt="generated"
          className="max-w-full rounded-lg shadow-md border"
          loading="lazy"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
        />
        <div className="text-xs text-muted-foreground mt-1 break-all font-mono">{seg.url}</div>
      </div>
    )
    cursor = seg.end
  })
  if (cursor < content.length) {
    nodes.push(<span key="tail">{content.slice(cursor)}</span>)
  }
  return <div className="whitespace-pre-wrap leading-relaxed">{nodes}</div>
}

type ChatMessage = { role: string; content: string; reasoning?: string; error?: boolean }
type ModelMenuStyle = { left: number; top: number; width: number; maxHeight: number }
const TYPEWRITER_CHUNK_SIZE = 2
const TYPEWRITER_DELAY_MS = 24
const MODEL_MENU_EDGE_GAP = 16
const MODEL_MENU_TRIGGER_GAP = 8
const MODEL_MENU_MAX_WIDTH = 760
const MODEL_MENU_MAX_HEIGHT = 448
const MODEL_MENU_MIN_HEIGHT = 220

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map(part => {
      const block = asRecord(part)
      const type = asText(block.type)
      if (type === "thinking" || type === "reasoning" || type === "reasoning_text") {
        return ""
      }
      if (type === "text" || type === "output_text" || type === "message") {
        return asText(block.text) || asText(block.content)
      }
      return asText(block.text) || asText(block.content)
    })
    .join("")
}

function readReasoningFields(value: unknown): string {
  const record = asRecord(value)
  const extra = asRecord(record.extra)
  return (
    asText(record.reasoning_content) ||
    asText(record.reasoning) ||
    asText(record.reasoning_text) ||
    asText(record.thinking) ||
    asText(record.thoughts) ||
    asText(extra.reasoning_content) ||
    asText(extra.reasoning) ||
    asText(extra.reasoning_text) ||
    asText(extra.thinking) ||
    asText(extra.thoughts)
  )
}

function splitInlineThinking(content: string, reasoning = ""): { content: string; reasoning: string } {
  if (!content || !/<think[\s>]/i.test(content)) return { content, reasoning }
  let visible = ""
  let thoughts = reasoning
  let cursor = 0
  for (const match of content.matchAll(/<think[^>]*>([\s\S]*?)<\/think>/gi)) {
    visible += content.slice(cursor, match.index)
    thoughts += match[1] || ""
    cursor = (match.index ?? 0) + match[0].length
  }
  visible += content.slice(cursor)
  return { content: visible, reasoning: thoughts }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function extractReasoningFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map(part => {
      const block = asRecord(part)
      const type = block.type
      if (type === "thinking") return asText(block.thinking)
      if (type === "reasoning_text") return asText(block.text)
      if (type === "reasoning") return asText(block.text) || asText(block.reasoning)
      return readReasoningFields(block)
    })
    .join("")
}

function normalizeAssistantMessage(message: unknown): ChatMessage {
  const msg = asRecord(message)
  const inline = splitInlineThinking(extractTextFromContent(msg.content), readReasoningFields(msg) || extractReasoningFromContent(msg.content))
  return {
    role: asText(msg.role) || "assistant",
    content: inline.content,
    ...(inline.reasoning ? { reasoning: inline.reasoning } : {}),
  }
}

function extractStreamDelta(payload: unknown): { content: string; reasoning: string } {
  const data = asRecord(payload)
  const responseEventType = asText(data.type)
  if (responseEventType === "response.reasoning_text.delta") {
    return { content: "", reasoning: asText(data.delta) }
  }
  if (responseEventType === "response.output_text.delta") {
    return splitInlineThinking(asText(data.delta))
  }

  const choices = Array.isArray(data.choices) ? data.choices : []
  const choice = asRecord(choices[0])
  const delta = asRecord(choice.delta)
  const message = asRecord(choice.message)
  const content = extractTextFromContent(delta.content) || extractTextFromContent(message.content) || extractTextFromContent(data.content)
  const reasoning = readReasoningFields(delta) || readReasoningFields(message) || readReasoningFields(data) || extractReasoningFromContent(delta.content) || extractReasoningFromContent(message.content)
  return splitInlineThinking(content, reasoning)
}

export default function TestPage() {
  const { t } = useT()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState("qwen3.6-plus")
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(FALLBACK_CHAT_MODELS)
  const [stream, setStream] = useState(true)
  const [answerMode, setAnswerMode] = useState<"thinking" | "fast">("thinking")
  const bottomRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelMenuStyle, setModelMenuStyle] = useState<ModelMenuStyle | null>(null)
  const groupedModels = groupModelOptions(availableModels)
  const selectedModel = availableModels.find(item => item.id === model)
  const selectedModelLabel = selectedModel ? formatModelOptionLabel(selectedModel) : model
  const selectedForcesThinking = isThinkingVariant(model)

  const updateModelMenuPosition = () => {
    const trigger = modelPickerRef.current?.querySelector("button")
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const availableWidth = Math.max(280, viewportWidth - MODEL_MENU_EDGE_GAP * 2)
    const width = Math.min(MODEL_MENU_MAX_WIDTH, availableWidth)
    const left = Math.min(
      Math.max(MODEL_MENU_EDGE_GAP, rect.right - width),
      viewportWidth - width - MODEL_MENU_EDGE_GAP,
    )
    const downSpace = viewportHeight - rect.bottom - MODEL_MENU_EDGE_GAP - MODEL_MENU_TRIGGER_GAP
    const upSpace = rect.top - MODEL_MENU_EDGE_GAP - MODEL_MENU_TRIGGER_GAP
    const openUp = downSpace < MODEL_MENU_MIN_HEIGHT && upSpace > downSpace
    const availableHeight = Math.max(MODEL_MENU_MIN_HEIGHT, openUp ? upSpace : downSpace)
    const maxHeight = Math.min(MODEL_MENU_MAX_HEIGHT, availableHeight)
    const top = openUp
      ? Math.max(MODEL_MENU_EDGE_GAP, rect.top - maxHeight - MODEL_MENU_TRIGGER_GAP)
      : rect.bottom + MODEL_MENU_TRIGGER_GAP

    setModelMenuStyle({ left, top, width, maxHeight })
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!modelPickerRef.current?.contains(target) && !modelMenuRef.current?.contains(target)) {
        setModelMenuOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [])

  useEffect(() => {
    if (!modelMenuOpen) {
      setModelMenuStyle(null)
      return
    }

    updateModelMenuPosition()
    window.addEventListener("resize", updateModelMenuPosition)
    window.addEventListener("scroll", updateModelMenuPosition, true)
    return () => {
      window.removeEventListener("resize", updateModelMenuPosition)
      window.removeEventListener("scroll", updateModelMenuPosition, true)
    }
  }, [modelMenuOpen, availableModels.length])

  // 接口测试只展示文本类模型，图片/视频等生成模型分流到独立页面。
  useEffect(() => {
    (async () => {
      try {
        const options = filterTextTestModels(await fetchModelOptions())
        if (options.length) {
          setAvailableModels(options)
          setModel(current => chooseDefaultModel(options, current))
        }
      } catch {
        // keep fallback list
      }
    })()
  }, [])

  const appendAssistantDelta = (content: string, reasoning: string) => {
    if (!content && !reasoning) return
    setMessages(prev => {
      const msgs = [...prev]
      const last = msgs[msgs.length - 1] ?? { role: "assistant", content: "" }
      msgs[msgs.length - 1] = {
        ...last,
        content: (last.content || "") + content,
        reasoning: (last.reasoning || "") + reasoning,
      }
      return msgs
    })
  }

  const appendAssistantTypewriter = async (message: ChatMessage) => {
    setMessages(prev => [...prev, { role: "assistant", content: "" }])
    let pendingReasoning = message.reasoning || ""
    let pendingContent = message.content || ""
    while (pendingReasoning || pendingContent) {
      if (pendingReasoning) {
        const chunk = pendingReasoning.slice(0, TYPEWRITER_CHUNK_SIZE)
        pendingReasoning = pendingReasoning.slice(chunk.length)
        appendAssistantDelta("", chunk)
      } else {
        const chunk = pendingContent.slice(0, TYPEWRITER_CHUNK_SIZE)
        pendingContent = pendingContent.slice(chunk.length)
        appendAssistantDelta(chunk, "")
      }
      await sleep(TYPEWRITER_DELAY_MS)
    }
  }

  const handleSend = async () => {
    if (!input.trim() || loading) return
    const userMsg = { role: "user", content: input }
    const wantsThinking = answerMode === "thinking"
    const requestBody = {
      model,
      messages: [...messages, userMsg],
      stream,
      include_reasoning: wantsThinking,
      enable_thinking: wantsThinking,
    }
    if (!wantsThinking && selectedForcesThinking) {
      toast.info(t("s0254"))
    }
    setMessages(prev => [...prev, userMsg])
    setInput("")
    setLoading(true)

    try {
      if (!stream) {
        const res = await fetch(`${API_BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeader() },
          body: JSON.stringify({ ...requestBody, stream: false })
        })
        const data = await res.json()
        if (data.error) {
          setMessages(prev => [...prev, { role: "assistant", content: `❌ ${data.error}`, error: true }])
        } else if (data.choices?.[0]) {
          await appendAssistantTypewriter(normalizeAssistantMessage(data.choices[0].message))
        } else {
          setMessages(prev => [...prev, { role: "assistant", content: t("test.unknownResponse", { data: JSON.stringify(data) }), error: true }])
        }
      } else {
        const res = await fetch(`${API_BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeader() },
          body: JSON.stringify({ ...requestBody, stream: true })
        })

        if (!res.ok) {
          const errText = await res.text()
          setMessages(prev => [...prev, { role: "assistant", content: `❌ HTTP ${res.status}: ${errText}`, error: true }])
          return
        }

        if (!res.body) throw new Error("No response body")

        setMessages(prev => [...prev, { role: "assistant", content: "" }])
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let hasContent = false
        let hasTerminalError = false
        const outputQueue = { content: "", reasoning: "" }
        let typewriterRunning = false

        const runTypewriter = async () => {
          if (typewriterRunning) return
          typewriterRunning = true
          try {
            while (outputQueue.reasoning || outputQueue.content) {
              if (outputQueue.reasoning) {
                const chunk = outputQueue.reasoning.slice(0, TYPEWRITER_CHUNK_SIZE)
                outputQueue.reasoning = outputQueue.reasoning.slice(chunk.length)
                appendAssistantDelta("", chunk)
              } else {
                const chunk = outputQueue.content.slice(0, TYPEWRITER_CHUNK_SIZE)
                outputQueue.content = outputQueue.content.slice(chunk.length)
                appendAssistantDelta(chunk, "")
              }
              await sleep(TYPEWRITER_DELAY_MS)
            }
          } finally {
            typewriterRunning = false
            if (outputQueue.reasoning || outputQueue.content) void runTypewriter()
          }
        }

        const enqueueAssistantDelta = (content: string, reasoning: string) => {
          if (!content && !reasoning) return
          hasContent = true
          outputQueue.content += content
          outputQueue.reasoning += reasoning
          void runTypewriter()
        }

        const waitForTypewriter = async () => {
          while (typewriterRunning || outputQueue.reasoning || outputQueue.content) {
            await sleep(20)
          }
        }

        let currentEventData = ""

        const processSsePayload = (payload: string) => {
          const trimmedPayload = payload.trim()
          if (!trimmedPayload || trimmedPayload === "[DONE]") return

          try {
            const data = JSON.parse(trimmedPayload)
            if (data.error) {
              outputQueue.content = ""
              outputQueue.reasoning = ""
              setMessages(prev => {
                const msgs = [...prev]
                msgs[msgs.length - 1] = { role: "assistant", content: `❌ ${data.error}`, error: true }
                return msgs
              })
              hasContent = true
              hasTerminalError = true
              return
            }
            const { content, reasoning } = extractStreamDelta(data)
            enqueueAssistantDelta(content, reasoning)
          } catch {
            // Keep the test page resilient to malformed payloads without aborting the stream.
          }
        }

        let buffer = ""

        const dispatchSseEvent = () => {
          if (!currentEventData) return
          const payload = currentEventData
          currentEventData = ""
          processSsePayload(payload)
        }

        const processSseLine = (rawLine: string) => {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
          if (line === "") {
            dispatchSseEvent()
            return
          }
          if (line.startsWith(":")) return
          if (!line.startsWith("data:")) return

          const data = line.startsWith("data: ") ? line.slice(6) : line.slice(5)
          currentEventData += currentEventData ? `\n${data}` : data
        }

        const processSseChunk = (chunk: string) => {
          if (!chunk) return
          buffer += chunk
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            processSseLine(line)
            if (hasTerminalError) break
          }
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          processSseChunk(decoder.decode(value, { stream: true }))
          if (hasTerminalError) break
        }

        if (!hasTerminalError) {
          processSseChunk(decoder.decode())
          if (buffer) {
            processSseLine(buffer)
            buffer = ""
          }
          dispatchSseEvent()
        } else {
          decoder.decode()
        }

        await waitForTypewriter()

        if (!hasContent) {
          setMessages(prev => {
            const msgs = [...prev]
            msgs[msgs.length - 1] = { role: "assistant", content: t("s0255"), error: true }
            return msgs
          })
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("s0256")
      toast.error(t("test.networkError", { message }))
      setMessages(prev => [...prev, { role: "assistant", content: t("test.networkErrorX", { message }), error: true }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] w-full flex-col space-y-4">
      <section className="admin-hero p-5">
        <div className="relative z-10 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.28em] text-muted-foreground">Protocol Trial</div>
            <h2 className="mt-2 text-4xl font-black tracking-tight">{t("s0260")}</h2>
            <p className="mt-2 text-muted-foreground">{t("s0261")}</p>
          </div>
          <div className="flex flex-col gap-3 md:items-end">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <div ref={modelPickerRef} className="relative">
                <button
                  type="button"
                  data-testid="model-picker-trigger"
                  onClick={() => {
                    updateModelMenuPosition()
                    setModelMenuOpen(open => !open)
                  }}
                  className="admin-input flex h-11 w-[22rem] max-w-[calc(100vw-2rem)] shrink-0 items-center gap-2 px-3 text-left"
                >
                  <span className="font-medium text-muted-foreground">{t("s0262")}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{selectedModelLabel}</span>
                  <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition ${modelMenuOpen ? "rotate-180" : ""}`} />
                </button>
                {modelMenuOpen && createPortal(
                  <div
                    ref={modelMenuRef}
                    data-testid="model-picker-menu"
                    className="fixed-select-menu fixed z-50 overflow-y-auto rounded-[24px] border border-white/75 bg-card/98 p-2 text-left shadow-[var(--shadow-lift)] backdrop-blur-xl"
                    style={modelMenuStyle ?? undefined}
                  >
                    {groupedModels.map(group => (
                      <div key={group.family} className="py-1">
                        <div className="px-3 py-2 text-[11px] font-black uppercase tracking-[0.22em] text-muted-foreground">
                          {group.family}
                        </div>
                        <div className="space-y-1">
                          {group.models.map(option => {
                            const label = formatModelOptionLabel(option)
                            const active = option.id === model
                            return (
                              <button
                                key={option.id}
                                type="button"
                                onClick={() => {
                                  setModel(option.id)
                                  setModelMenuOpen(false)
                                }}
                                className={`flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left transition ${
                                  active ? "bg-primary text-primary-foreground" : "hover:bg-muted/60"
                                }`}
                              >
                                <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border ${active ? "border-primary-foreground/50" : "border-border"}`}>
                                  {active ? <Check className="size-3.5" /> : null}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block break-words [overflow-wrap:anywhere] font-mono text-sm leading-5">{label}</span>
                                  <span className={`mt-1 block break-all [overflow-wrap:anywhere] text-xs ${active ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                                    {option.id}
                                  </span>
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
              <div
                className="admin-input flex cursor-pointer items-center gap-2 px-3 py-2"
                onClick={() => setStream(!stream)}
              >
                <input type="checkbox" checked={stream} onChange={() => {}} className="cursor-pointer" />
                <span className="font-medium">{t("s0263")}</span>
              </div>
              <Button variant="outline" onClick={() => { setMessages([]); setInput("") }}>
                <RefreshCw className="mr-2 h-4 w-4" /> {t("test.newChat")}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div className="admin-card p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="admin-input flex p-1">
            <button
              type="button"
              onClick={() => setAnswerMode("thinking")}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${answerMode === "thinking" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}
            >
              <Brain className="h-4 w-4" /> {t("models.modeThinking")}
            </button>
            <button
              type="button"
              onClick={() => setAnswerMode("fast")}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${answerMode === "fast" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}
            >
              <Zap className="h-4 w-4" /> {t("test.fast")}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {answerMode === "thinking"
              ? t("s0257")
              : t("s0258")}
          </p>
        </div>
        {selectedForcesThinking && answerMode === "fast" ? (
          <p className="mt-2 text-xs text-amber-500">{t("s0264")}</p>
        ) : null}
      </div>

      <div className="admin-card flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto p-6 space-y-6 flex flex-col">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <Bot className="h-12 w-12 text-muted-foreground/30" />
              <p className="text-sm">{t("s0265")}</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm shadow-sm
                ${msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : msg.error
                    ? "bg-red-500/10 border border-red-500/30 text-red-400"
                    : "bg-muted/30 border text-foreground"}`}>
                {msg.role === "assistant" && !msg.content && !msg.reasoning && loading ? (
                  <span className="animate-pulse flex items-center gap-2 text-muted-foreground">
                    <Bot className="h-4 w-4" /> {t("test.thinkingDots")}
                  </span>
                ) : msg.role === "assistant" && !msg.error ? (
                  <div className="space-y-2">
                    {msg.reasoning ? (
                      <details open className="rounded-md border border-dashed border-border/50 bg-muted/20 p-2 text-xs">
                        <summary className="cursor-pointer select-none text-muted-foreground font-mono">
                          💭 {t("test.thinkingLen", { len: msg.reasoning.length })}
                        </summary>
                        <div className="whitespace-pre-wrap leading-relaxed text-muted-foreground mt-2 pl-2 border-l-2 border-border/30">
                          {msg.reasoning}
                        </div>
                      </details>
                    ) : null}
                    {msg.content ? <MessageContent content={msg.content} /> : null}
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="p-4 border-t border-border/50 bg-muted/15 flex gap-3 items-center">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSend()}
            className="admin-input flex h-12 w-full px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={t("s0259")}
            disabled={loading}
          />
          <Button onClick={handleSend} disabled={loading || !input.trim()} className="h-12 px-6">
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
