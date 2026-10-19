import { t, useT } from "../lib/i18n"
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react"
import { Button } from "../components/ui/button"
import {
  Ban,
  CheckCircle2,
  Clipboard,
  Download,
  Edit3,
  FileUp,
  Import,
  MailWarning,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldAlert,
  Trash2,
  UploadCloud,
  UserRound,
  XCircle,
  Lock,
} from "lucide-react"
import { toast } from "sonner"
import { adminRequestErrorMessage, getAuthHeader, getStoredApiKey } from "../lib/auth"
import { API_BASE } from "../lib/api"

type AccountItem = {
  email: string
  password?: string
  token?: string
  cookies?: string
  username?: string
  valid?: boolean
  inflight?: number
  max_inflight?: number
  rate_limited_until?: number
  rate_limits?: Record<string, AccountRateLimit>
  activation_pending?: boolean
  status_code?: string
  status_text?: string
  last_error?: string
  last_request_started?: number
  last_request_finished?: number
  consecutive_failures?: number
  rate_limit_strikes?: number
  service?: string
  provider?: string
  plan?: string
  pool?: string
  image_quota?: number
  gpt_image_quota?: number
  success_count?: number
  failure_count?: number
  source?: string
  env_name?: string
}

type AccountRateLimit = {
  until?: number
  reason?: string
  last_error?: string
  strikes?: number
}

type ImportAccount = {
  token: string
  email?: string
  password?: string
  username?: string
  cookies?: string
}

type ZipEntry = {
  name: string
  content: string
}

function statusStyle(code?: string) {
  switch (code) {
    case "valid":
      return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 ring-emerald-500/25"
    case "pending_activation":
      return "bg-orange-500/12 text-orange-700 dark:text-orange-300 ring-orange-500/25"
    case "rate_limited":
      return "bg-yellow-500/12 text-yellow-700 dark:text-yellow-300 ring-yellow-500/25"
    case "banned":
      return "bg-rose-500/12 text-rose-700 dark:text-rose-300 ring-rose-500/25"
    case "auth_error":
      return "bg-slate-500/12 text-slate-700 dark:text-slate-300 ring-slate-500/25"
    default:
      return "bg-rose-500/12 text-rose-700 dark:text-rose-300 ring-rose-500/25"
  }
}

const RATE_LIMIT_LABELS: Record<string, string> = {
  chat: t("s0062"),
  image: t("s0063"),
  video: t("s0064"),
  metadata: t("s0065"),
  unknown: t("s0066"),
  legacy: t("s0067"),
}

function activeRateLimits(acc: AccountItem) {
  const now = Date.now() / 1000
  const items = Object.entries(acc.rate_limits || {})
    .filter(([, state]) => Number(state?.until || 0) > now)
    .map(([usage, state]) => ({
      usage,
      label: RATE_LIMIT_LABELS[usage] || t("accounts.rateFallback", { usage }),
      until: Number(state.until || 0),
      error: state.last_error || state.reason || "",
    }))

  if ((acc.rate_limited_until || 0) > now && !items.some(item => item.usage === "chat")) {
    items.push({
      usage: "legacy",
      label: t("s0067"),
      until: Number(acc.rate_limited_until || 0),
      error: acc.last_error || "",
    })
  }

  const order = ["chat", "image", "video", "metadata", "unknown", "legacy"]
  return items.sort((a, b) => order.indexOf(a.usage) - order.indexOf(b.usage))
}

function hasActiveChatLimit(acc: AccountItem) {
  return activeRateLimits(acc).some(item => item.usage === "chat" || item.usage === "legacy")
}

function effectiveStatusCode(acc: AccountItem) {
  if (hasActiveChatLimit(acc)) return "rate_limited"
  if (acc.status_code === "rate_limited" && acc.valid) return "valid"
  return acc.status_code || (acc.valid ? "valid" : "invalid")
}

function formatLimitTime(until: number) {
  return new Date(until * 1000).toLocaleString()
}

function limitSummary(acc: AccountItem) {
  const limits = activeRateLimits(acc)
  if (limits.length === 0) return ""
  return limits.map(item => t("accounts.limitRecover", { label: item.label, time: formatLimitTime(item.until) })).join("；")
}

function statusText(acc: AccountItem) {
  switch (effectiveStatusCode(acc)) {
    case "valid": return t("s0068")
    case "pending_activation": return t("s0069")
    case "rate_limited": return hasActiveChatLimit(acc) ? t("s0062") : t("s0070")
    case "banned": return t("s0071")
    case "auth_error": return t("s0072")
    default: return acc.valid ? t("s0068") : t("s0073")
  }
}

function statusNote(acc: AccountItem) {
  const limits = activeRateLimits(acc)
  if (limits.length > 0) return limits.map(item => `${item.label}${item.error ? `：${item.error}` : ""}`).join("；")
  return acc.last_error || ""
}

function serviceOf(acc: AccountItem) {
  return acc.service || acc.provider || "Qwen"
}

function planOf(acc: AccountItem) {
  return acc.plan || acc.pool || "free"
}

function quotaOf(acc: AccountItem) {
  return Number(acc.gpt_image_quota ?? acc.image_quota ?? 0)
}

function successOf(acc: AccountItem) {
  return Number(acc.success_count ?? Math.max(0, acc.last_request_finished ? 1 : 0))
}

function failureOf(acc: AccountItem) {
  return Number(acc.failure_count ?? acc.consecutive_failures ?? 0)
}

function recoveryText(acc: AccountItem) {
  const summary = limitSummary(acc)
  if (summary) return summary
  if (acc.status_code === "rate_limited") return t("s0074")
  return "-"
}

function maskedToken(token?: string) {
  const value = (token || "").trim()
  if (!value) return "-"
  if (value.length <= 14) return "token-hidden"
  return `${value.slice(0, 8)}••••••${value.slice(-6)}`
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 96) || "account"
}

function localizeError(error?: string) {
  if (!error) return "\u672a\u77e5\u9519\u8bef"
  const lower = error.toLowerCase()
  if (lower.includes("activation already in progress")) return "\u8d26\u53f7\u6b63\u5728\u6fc0\u6d3b\u4e2d\uff0c\u8bf7\u7a0d\u540e\u5237\u65b0"
  if (lower.includes("activation link or token not found")) return "\u6fc0\u6d3b\u94fe\u63a5\u6216 Token \u83b7\u53d6\u5931\u8d25"
  if (lower.includes("token invalid") || lower.includes("token") || lower.includes("auth")) return "Token \u65e0\u6548\u6216\u8ba4\u8bc1\u5931\u8d25"
  return error
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function accountFromRecord(value: unknown): ImportAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const token = getString(record.token) || getString(record.access_token) || getString(record.accessToken)
  if (!token) return null
  return {
    token: token.replace(/^Bearer\s+/i, "").trim(),
    email: getString(record.email) || getString(record.account) || undefined,
    password: getString(record.password) || undefined,
    username: getString(record.username) || undefined,
    cookies: getString(record.cookies) || getString(record.cookie) || undefined,
  }
}

function collectImportAccounts(value: unknown): ImportAccount[] {
  const direct = accountFromRecord(value)
  if (direct) return [direct]
  if (Array.isArray(value)) return value.flatMap(collectImportAccounts)
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  return [record.accounts, record.items, record.data, record.results, record.records, record.list]
    .filter(item => item !== undefined)
    .flatMap(collectImportAccounts)
}

function parseTokenLine(line: string): ImportAccount | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    const accounts = collectImportAccounts(parsed)
    return accounts[0] || null
  } catch {
    // Fall back to text formats below.
  }
  const tabParts = trimmed.split(/[\t,]/).map(item => item.trim()).filter(Boolean)
  if (tabParts.length >= 2 && tabParts[1].length > 16) {
    return { email: tabParts[0], token: tabParts[1].replace(/^Bearer\s+/i, "") }
  }
  const tokenMatch = trimmed.match(/(?:access_token|accessToken|token)\s*[:=]\s*["']?([^"',\s]+)["']?/i)
  const rawToken = tokenMatch?.[1] || trimmed.replace(/^Bearer\s+/i, "")
  return rawToken.length > 16 ? { token: rawToken } : null
}

function parseImportText(text: string): ImportAccount[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    const accounts = collectImportAccounts(parsed)
    if (accounts.length) return accounts
  } catch {
    // Plain line based import.
  }
  return trimmed
    .split(/\r?\n/)
    .flatMap(line => {
      const parsed = parseTokenLine(line)
      return parsed ? [parsed] : []
    })
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function downloadJSON(name: string, data: unknown) {
  downloadBlob(name, new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }))
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = Math.max(1, date.getFullYear() - 1980)
  const dateValue = (day << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dateValue }
}

function u16(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function concatBytes(chunks: Uint8Array[]) {
  const size = chunks.reduce((sum, item) => sum + item.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function zipBlob(entries: ZipEntry[]) {
  const enc = new TextEncoder()
  const { time, date } = dosTime()
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = enc.encode(entry.name)
    const content = enc.encode(entry.content)
    const crc = crc32(content)
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(content.length), ...u32(content.length), ...u16(name.length), ...u16(0),
      ...name, ...content,
    ])
    const central = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(content.length), ...u32(content.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    ])
    localChunks.push(local)
    centralChunks.push(central)
    offset += local.length
  }

  const centralOffset = offset
  const central = concatBytes(centralChunks)
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(centralOffset), ...u16(0),
  ])
  return new Blob([concatBytes(localChunks), central, end], { type: "application/zip" })
}

export default function AccountsPage() {
  const { t } = useT()

  const [accounts, setAccounts] = useState<AccountItem[]>([])
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState("")
  const [verifying, setVerifying] = useState<string | null>(null)
  const [verifyingAll, setVerifyingAll] = useState(false)
  const [bulkText, setBulkText] = useState("")
  const [bulkImporting, setBulkImporting] = useState(false)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [serviceFilter, setServiceFilter] = useState("all")
  const [planFilter, setPlanFilter] = useState("all")
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  const deferredQuery = useDeferredValue(query)

  const requireSessionKey = () => {
    if (getStoredApiKey()) return true
    toast.error(t("s0075"))
    return false
  }

  const readAdminJSON = async (res: Response) => {
    if (!res.ok) throw new Error(await adminRequestErrorMessage(res))
    return res.json().catch(() => ({}))
  }

  const fetchAccounts = (notify = false) => {
    if (!getStoredApiKey()) {
      setAccounts([])
      toast.error(t("s0075"))
      return
    }
    fetch(`${API_BASE}/api/admin/accounts`, { headers: getAuthHeader() })
      .then(readAdminJSON)
      .then(data => {
        const next = data.accounts || []
        setAccounts(next)
        setSelected(prev => new Set([...prev].filter(email => next.some((acc: AccountItem) => acc.email === email))))
        if (notify) toast.success(t("s0076"))
      })
      .catch(err => toast.error(err instanceof Error ? err.message : t("s0077")))
  }

  useEffect(() => {
    fetchAccounts()
  }, [])

  const stats = useMemo(() => {
    const result = { total: accounts.length, valid: 0, rateLimited: 0, abnormal: 0, banned: 0, quota: 0, pending: 0, invalid: 0 }
    for (const acc of accounts) {
      const code = effectiveStatusCode(acc)
      if (code === "valid") result.valid += 1
      else if (code === "pending_activation") result.pending += 1
      else if (code === "rate_limited") result.rateLimited += 1
      else if (code === "banned") result.banned += 1
      else result.invalid += 1
      if (activeRateLimits(acc).length > 0 && code !== "rate_limited") result.rateLimited += 1
      result.quota += quotaOf(acc)
    }
    result.abnormal = result.pending + result.invalid
    return result
  }, [accounts])

  const parsedBulkAccounts = useMemo(() => parseImportText(bulkText), [bulkText])
  const serviceOptions = useMemo(() => Array.from(new Set(accounts.map(serviceOf))).sort(), [accounts])
  const planOptions = useMemo(() => Array.from(new Set(accounts.map(planOf))).sort(), [accounts])
  const selectedAccounts = useMemo(() => accounts.filter(acc => selected.has(acc.email)), [accounts, selected])

  const filteredAccounts = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return accounts.filter(acc => {
      const code = effectiveStatusCode(acc)
      const limitText = `${limitSummary(acc)} ${statusNote(acc)}`
      const matchedQuery = !q || [acc.email, acc.username, code, acc.last_error, acc.token, limitText].some(value => String(value || "").toLowerCase().includes(q))
      const matchedStatus = statusFilter === "all" || code === statusFilter || (statusFilter === "valid" && acc.valid) || (statusFilter === "rate_limited" && activeRateLimits(acc).length > 0)
      const matchedService = serviceFilter === "all" || serviceOf(acc) === serviceFilter
      const matchedPlan = planFilter === "all" || planOf(acc) === planFilter
      return matchedQuery && matchedStatus && matchedService && matchedPlan
    })
  }, [accounts, deferredQuery, planFilter, serviceFilter, statusFilter])

  const allFilteredSelected = filteredAccounts.length > 0 && filteredAccounts.every(acc => selected.has(acc.email))

  const toggleSelected = (targetEmail: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(targetEmail)) next.delete(targetEmail)
      else next.add(targetEmail)
      return next
    })
  }

  const toggleAllFiltered = () => {
    setSelected(prev => {
      const next = new Set(prev)
      if (allFilteredSelected) filteredAccounts.forEach(acc => next.delete(acc.email))
      else filteredAccounts.forEach(acc => next.add(acc.email))
      return next
    })
  }

  const handleAdd = () => {
    if (!requireSessionKey()) return
    if (!token.trim()) {
      toast.error(t("s0078"))
      return
    }
    const id = toast.loading(t("s0079"))
    fetch(`${API_BASE}/api/admin/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({
        email: email || `manual_${Date.now()}@qwen`,
        password,
        token,
      })
    }).then(readAdminJSON)
      .then(data => {
        if (data.ok) {
          toast.success(t("s0080"), { id })
          setEmail("")
          setPassword("")
          setToken("")
          fetchAccounts()
        } else {
          toast.error(localizeError(data.error) || t("s0081"), { id, duration: 8000 })
        }
      })
      .catch(err => toast.error(err instanceof Error ? err.message : t("s0082"), { id }))
  }

  const handleDelete = (target: AccountItem) => {
    if (!requireSessionKey()) return
    if (target.source === "env") {
      toast.error(t("s0083"))
      return
    }

    const id = toast.loading(`\u6b63\u5728\u5220\u9664 ${target.email}...`)
    fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(target.email)}`, {
      method: "DELETE",
      headers: getAuthHeader(),
    }).then(async res => {
      if (!res.ok) throw new Error(await adminRequestErrorMessage(res))
      toast.success(`\u5df2\u5220\u9664 ${target.email}`, { id })
      setSelected(prev => {
        const next = new Set(prev)
        next.delete(target.email)
        return next
      })
      fetchAccounts()
    }).catch(err => toast.error(err instanceof Error ? err.message : t("s0084"), { id }))
  }

  const handleDeleteSelected = async () => {
    if (!requireSessionKey()) return
    const deletableAccounts = selectedAccounts.filter(acc => acc.source !== "env")
    if (!deletableAccounts.length) {
      toast.error(t("s0085"))
      return
    }
    const skipped = selectedAccounts.length - deletableAccounts.length
    const id = toast.loading(t("accounts.deletingSelected", { n: deletableAccounts.length }))
    let ok = 0
    let failed = 0
    for (const acc of deletableAccounts) {
      try {
        const res = await fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(acc.email)}`, {
          method: "DELETE",
          headers: getAuthHeader(),
        })
        if (res.ok) ok += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    toast.success(`${t("accounts.deleteDone", { ok, failed })}${skipped ? t("accounts.skipEnv", { count: skipped }) : ""}`, { id, duration: 8000 })
    setSelected(new Set())
    fetchAccounts()
  }

  const handleDeleteAbnormal = async () => {
    if (!requireSessionKey()) return
    const abnormal = accounts.filter(acc => acc.status_code !== "valid" && !acc.valid)
    if (!abnormal.length) {
      toast.success(t("s0086"))
      return
    }
    const id = toast.loading(t("accounts.removingAbnormal", { n: abnormal.length }))
    let ok = 0
    let failed = 0
    for (const acc of abnormal) {
      try {
        const res = await fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(acc.email)}`, {
          method: "DELETE",
          headers: getAuthHeader(),
        })
        if (res.ok) ok += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    toast.success(t("accounts.removeDone", { ok, failed }), { id, duration: 8000 })
    setSelected(new Set())
    fetchAccounts()
  }

  const handleVerify = (targetEmail: string) => {
    if (!requireSessionKey()) return
    setVerifying(targetEmail)
    const id = toast.loading(`\u6b63\u5728\u9a8c\u8bc1 ${targetEmail}...`)
    fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(targetEmail)}/verify`, {
      method: "POST",
      headers: getAuthHeader(),
    }).then(readAdminJSON)
      .then(data => {
        if (data.valid) {
          toast.success(`\u9a8c\u8bc1\u901a\u8fc7\uff1a${targetEmail}`, { id })
        } else {
          toast.error(`\u9a8c\u8bc1\u5931\u8d25\uff1a${statusText(data) || localizeError(data.error)}`, { id, duration: 8000 })
        }
        fetchAccounts()
      })
      .catch(err => toast.error(err instanceof Error ? err.message : t("s0087"), { id }))
      .finally(() => setVerifying(null))
  }

  const handleVerifyAll = () => {
    if (!requireSessionKey()) return
    setVerifyingAll(true)
    const id = toast.loading(t("s0088"))
    fetch(`${API_BASE}/api/admin/verify`, {
      method: "POST",
      headers: getAuthHeader(),
    }).then(readAdminJSON)
      .then(data => {
        if (data.ok) {
          toast.success(`\u5168\u91cf\u5de1\u68c0\u5b8c\u6210\uff0c\u5e76\u53d1\u6570\uff1a${data.concurrency || 1}`, { id })
        } else {
          toast.error(t("s0089"), { id })
        }
        fetchAccounts()
      })
      .catch(err => toast.error(err instanceof Error ? err.message : t("s0090"), { id }))
      .finally(() => setVerifyingAll(false))
  }

  const handleVerifySelected = async () => {
    if (!requireSessionKey()) return
    if (!selectedAccounts.length) {
      toast.error(t("s0085"))
      return
    }
    const id = toast.loading(t("accounts.refreshingSelected", { n: selectedAccounts.length }))
    let ok = 0
    let failed = 0
    for (const acc of selectedAccounts) {
      try {
        const res = await fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(acc.email)}/verify`, {
          method: "POST",
          headers: getAuthHeader(),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.valid) ok += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    toast.success(t("accounts.refreshDone", { ok, failed }), { id, duration: 8000 })
    fetchAccounts()
  }

  const handleActivate = (targetEmail: string) => {
    if (!requireSessionKey()) return
    const id = toast.loading(`\u6b63\u5728\u6fc0\u6d3b ${targetEmail}...`)
    fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(targetEmail)}/activate`, {
      method: "POST",
      headers: getAuthHeader(),
    }).then(readAdminJSON)
      .then(data => {
        if (data.pending) {
          toast.success(`\u8d26\u53f7\u6b63\u5728\u6fc0\u6d3b\u4e2d\uff0c\u8bf7\u7a0d\u540e\u5237\u65b0\uff1a${targetEmail}`, { id, duration: 6000 })
        } else if (data.ok) {
          toast.success(data.message || `\u6fc0\u6d3b\u6210\u529f\uff1a${targetEmail}`, { id, duration: 6000 })
        } else {
          toast.error(`\u6fc0\u6d3b\u5931\u8d25\uff1a${localizeError(data.error || data.message)}`, { id, duration: 8000 })
        }
        fetchAccounts()
      })
      .catch(err => toast.error(err instanceof Error ? err.message : t("s0091"), { id }))
  }

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ""
    if (!files.length) return
    const chunks = await Promise.all(files.map(file => file.text()))
    setBulkText(prev => [prev, ...chunks].filter(Boolean).join("\n"))
    toast.success(t("accounts.filesRead", { n: files.length }))
  }

  const handleBulkImport = async () => {
    if (!requireSessionKey()) return
    const candidates = parsedBulkAccounts
    if (!candidates.length) {
      toast.error(t("s0092"))
      return
    }
    setBulkImporting(true)
    const id = toast.loading(t("accounts.importing", { n: candidates.length }))
    let ok = 0
    let failed = 0
    try {
      for (const [index, item] of candidates.entries()) {
        const res = await fetch(`${API_BASE}/api/admin/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeader() },
          body: JSON.stringify({
            email: item.email || `batch_${Date.now()}_${index + 1}@qwen`,
            password: item.password || "",
            username: item.username || "",
            cookies: item.cookies || "",
            token: item.token,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.ok) ok += 1
        else failed += 1
      }
      toast.success(t("accounts.importDone", { ok, failed }), { id, duration: 8000 })
      fetchAccounts()
      if (ok > 0) setBulkText("")
    } catch (err) {
      toast.error(t("accounts.importInterrupted", { msg: err instanceof Error ? err.message : t("common.unknownError") }), { id })
    } finally {
      setBulkImporting(false)
    }
  }

  const handleCopyToken = async (acc: AccountItem) => {
    if (!acc.token) {
      toast.error(t("s0093"))
      return
    }
    await navigator.clipboard.writeText(acc.token)
    toast.success(t("accounts.tokenCopied", { email: acc.email }))
  }

  const handleEditAccount = async (acc: AccountItem) => {
    if (!requireSessionKey()) return
    const nextEmail = window.prompt(t("s0094"), acc.email)
    if (nextEmail === null) return
    const nextPassword = window.prompt(t("s0095"), acc.password || "")
    if (nextPassword === null) return
    const nextUsername = window.prompt(t("s0096"), acc.username || "")
    if (nextUsername === null) return
    const nextToken = window.prompt(t("s0097"), acc.token || "")
    if (nextToken === null) return
    if (!nextToken.trim()) {
      toast.error(t("s0098"))
      return
    }
    const id = toast.loading(t("accounts.saving", { email: acc.email }))
    const res = await fetch(`${API_BASE}/api/admin/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({
        email: nextEmail.trim() || acc.email,
        password: nextPassword,
        username: nextUsername,
        cookies: acc.cookies || "",
        token: nextToken.trim(),
      }),
    }).catch(() => null)
    if (!res) {
      toast.error(t("s0099"), { id })
      return
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      toast.error(localizeError(data.error) || t("s0100"), { id, duration: 8000 })
      return
    }
    if ((nextEmail.trim() || acc.email) !== acc.email) {
      await fetch(`${API_BASE}/api/admin/accounts/${encodeURIComponent(acc.email)}`, {
        method: "DELETE",
        headers: getAuthHeader(),
      }).catch(() => null)
    }
    toast.success(t("s0101"), { id })
    fetchAccounts()
  }

  const exportAccounts = (scope: "all" | "selected", format: "json" | "zip") => {
    const list = scope === "selected" ? selectedAccounts : accounts
    if (!list.length) {
      toast.error(scope === "selected" ? t("s0085") : t("s0102"))
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    if (format === "json") {
      downloadJSON(`qwen2api-accounts-${scope}-${stamp}.json`, { accounts: list })
      toast.success(t("s0103"))
      return
    }
    const entries: ZipEntry[] = [
      { name: "accounts.json", content: JSON.stringify({ accounts: list }, null, 2) },
      ...list.map(acc => ({ name: `accounts/${safeFileName(acc.email)}.json`, content: JSON.stringify(acc, null, 2) })),
    ]
    downloadBlob(`qwen2api-accounts-${scope}-${stamp}.zip`, zipBlob(entries))
    toast.success(t("s0104"))
  }

  return (
    <div className="space-y-6 relative">
      <input ref={importFileInputRef} type="file" accept=".txt,.json,.csv" multiple className="hidden" onChange={handleImportFile} />

      <section className="admin-hero p-6">
        <div className="relative z-10 space-y-4">
          <div className="flex flex-col justify-between gap-5 2xl:flex-row 2xl:items-center">
            <div className="min-w-0">
              <div className="text-xs font-black uppercase tracking-[0.28em] text-muted-foreground">ACCOUNT POOL</div>
              <h2 className="mt-2 text-4xl font-black tracking-tight">{t("s0105")}</h2>
            </div>
            <div className="account-action-row 2xl:justify-end">
            <Button variant="outline" onClick={() => fetchAccounts(true)}>
              <RefreshCw className="mr-2 h-4 w-4" /> {t("s0106")}
            </Button>
            <Button variant="outline" onClick={handleVerifyAll} disabled={verifyingAll}>
              <RotateCw className={`mr-2 h-4 w-4 ${verifyingAll ? "animate-spin" : ""}`} /> {t("s0107")}
            </Button>
            <Button onClick={() => importFileInputRef.current?.click()} className="bg-black text-white hover:bg-black/85">
              <Import className="mr-2 h-4 w-4" /> {t("s0108")}
            </Button>
            <Button variant="outline" onClick={() => exportAccounts("all", "json")}>
              <Download className="mr-2 h-4 w-4" /> {t("s0109")}
            </Button>
            <Button variant="outline" onClick={() => exportAccounts("all", "zip")}>
              <Download className="mr-2 h-4 w-4" /> {t("s0110")}
            </Button>
            </div>
          </div>
          <p className="text-muted-foreground">{t("s0111")}</p>
        </div>
      </section>

      <div className="account-stat-row">
        <MetricCard icon={<UserRound className="size-5" />} label={t("s0112")} value={stats.total} />
        <MetricCard icon={<CheckCircle2 className="size-5" />} label={t("s0113")} value={stats.valid} tone="emerald" />
        <MetricCard icon={<ShieldAlert className="size-5" />} label={t("s0114")} value={stats.rateLimited} tone="orange" />
        <MetricCard icon={<XCircle className="size-5" />} label={t("s0115")} value={stats.abnormal} tone="rose" />
        <MetricCard icon={<Ban className="size-5" />} label={t("s0116")} value={stats.banned} />
        <MetricCard icon={<RotateCw className="size-5" />} label={t("s0117")} value={stats.quota} tone="blue" />
      </div>
      <p className="text-sm text-muted-foreground">
        {t("accounts.desc")}
      </p>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[30px] border border-white/75 bg-card/86 p-6 shadow-[var(--shadow-lift)] space-y-4">
          <div>
            <h3 className="text-base font-bold">{t("s0118")}</h3>
            <p className="text-sm text-muted-foreground">{t("s0119")}</p>
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-3 mt-3">
              <p className="text-sm font-semibold text-orange-700 dark:text-orange-300">{t("s0120")}</p>
              <p className="text-xs text-orange-700/80 dark:text-orange-200/80 mt-1">{t("s0121")}</p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="text-xs font-semibold mb-1.5 block">{t("s0122")}</label>
              <input type="text" value={token} onChange={e => setToken(e.target.value)} className="admin-input flex h-10 w-full px-3 py-2 text-sm" placeholder={t("s0123")} />
            </div>
            <div>
              <label className="text-xs font-semibold mb-1.5 block">{t("s0124")}</label>
              <input type="text" value={email} onChange={e => setEmail(e.target.value)} className="admin-input flex h-10 w-full px-3 py-2 text-sm" placeholder={t("s0125")} />
            </div>
            <div>
              <label className="text-xs font-semibold mb-1.5 block">{t("s0126")}</label>
              <input type="text" value={password} onChange={e => setPassword(e.target.value)} className="admin-input flex h-10 w-full px-3 py-2 text-sm" placeholder={t("s0127")} />
            </div>
          </div>
          <Button onClick={handleAdd} variant="secondary" className="h-10 w-full font-semibold">
            <Plus className="mr-2 h-4 w-4" /> {t("s0128")}
          </Button>
        </div>

        <div className="rounded-[30px] border border-white/75 bg-card/86 p-6 shadow-[var(--shadow-lift)] space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <h3 className="text-base font-bold">{t("s0129")}</h3>
              <p className="text-sm text-muted-foreground">{t("s0142")}</p>
            </div>
            <label className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border bg-background/70 px-4 text-sm font-bold shadow-sm">
              <FileUp className="size-4" />
              {t("accounts.readFile")}
              <input type="file" accept=".txt,.json,.csv" multiple className="hidden" onChange={handleImportFile} />
            </label>
          </div>
          <textarea
            value={bulkText}
            onChange={e => setBulkText(e.target.value)}
            className="admin-input min-h-44 w-full resize-y px-4 py-3 text-sm"
            placeholder={t("s0130")}
            disabled={bulkImporting}
          />
          <div className="flex flex-col gap-3 rounded-2xl border border-white/75 bg-background/55 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="text-sm text-muted-foreground">{t("s0143")} <span className="font-black text-foreground">{parsedBulkAccounts.length}</span> {t("s0144")}</div>
            <div className="flex flex-nowrap gap-2">
              <Button variant="ghost" onClick={() => setBulkText("")} disabled={!bulkText || bulkImporting}>{t("s0145")}</Button>
              <Button onClick={handleBulkImport} disabled={!parsedBulkAccounts.length || bulkImporting}>
                {bulkImporting ? <RefreshCw className="mr-2 size-4 animate-spin" /> : <UploadCloud className="mr-2 size-4" />}
                {t("accounts.importAccount")}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-4 pt-2 xl:flex-row xl:items-start">
        <div className="flex shrink-0 items-center gap-3">
          <h3 className="text-2xl font-black">{t("s0146")}</h3>
          <span className="inline-flex items-center justify-center rounded-full bg-muted px-3 py-1 text-xs font-black">{filteredAccounts.length}</span>
        </div>
        <div className="account-filter-row xl:justify-end">
          <div className="flex h-11 min-w-[260px] items-center gap-2 rounded-2xl border border-white/75 bg-card/80 px-3 shadow-sm">
            <Search className="size-4 text-muted-foreground" />
            <input value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder={t("s0131")} />
          </div>
          <select value={serviceFilter} onChange={e => setServiceFilter(e.target.value)} className="h-11 rounded-2xl border border-white/75 bg-card/80 px-4 text-sm shadow-sm outline-none">
            <option value="all">{t("s0147")}</option>
            {serviceOptions.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={planFilter} onChange={e => setPlanFilter(e.target.value)} className="h-11 rounded-2xl border border-white/75 bg-card/80 px-4 text-sm shadow-sm outline-none">
            <option value="all">{t("s0148")}</option>
            {planOptions.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-11 rounded-2xl border border-white/75 bg-card/80 px-4 text-sm shadow-sm outline-none">
            <option value="all">{t("s0149")}</option>
            <option value="valid">{t("s0068")}</option>
            <option value="pending_activation">{t("s0069")}</option>
            <option value="rate_limited">{t("s0070")}</option>
            <option value="banned">{t("s0071")}</option>
            <option value="auth_error">{t("s0072")}</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-[30px] border border-white/75 bg-card/86 shadow-[var(--shadow-lift)]">
        <div className="flex flex-col gap-3 border-b border-border/50 px-5 py-4 text-sm xl:flex-row xl:items-center xl:justify-between">
          <Button variant="ghost" size="sm" onClick={handleDeleteAbnormal} disabled={!accounts.some(acc => acc.status_code !== "valid" && !acc.valid)} className="text-rose-600 hover:text-rose-600">
            <Trash2 className="mr-2 size-4" /> {t("accounts.removeAbnormal")}
          </Button>
          <div className="account-selected-action-row xl:justify-end">
            <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold text-muted-foreground">{t("accounts.selectedCount", { count: selectedAccounts.length })}</span>
            <Button variant="ghost" size="sm" onClick={handleVerifySelected} disabled={!selectedAccounts.length}>
              <RefreshCw className="mr-2 size-4" /> {t("accounts.refreshSelectedLabel")}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDeleteSelected} disabled={!selectedAccounts.length} className="text-rose-600 hover:text-rose-600">
              <Trash2 className="mr-2 size-4" /> {t("accounts.deleteSelected")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => exportAccounts("selected", "json")} disabled={!selectedAccounts.length}>
              <Download className="mr-2 size-4" /> {t("accounts.exportSelectedJson")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => exportAccounts("selected", "zip")} disabled={!selectedAccounts.length}>
              <Download className="mr-2 size-4" /> {t("accounts.exportSelectedZip")}
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] text-left text-sm">
            <thead className="border-b bg-muted/25 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="w-14 px-5 py-4">
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} aria-label={t("s0132")} />
                </th>
                <th className="px-4 py-4 font-bold">TOKEN</th>
                <th className="px-4 py-4 font-bold">{t("s0150")}</th>
                <th className="px-4 py-4 font-bold">{t("s0151")}</th>
                <th className="px-4 py-4 font-bold">{t("s0152")}</th>
                <th className="px-4 py-4 font-bold">{t("s0153")}</th>
                <th className="px-4 py-4 font-bold">{t("s0117")}</th>
                <th className="px-4 py-4 font-bold">{t("s0154")}</th>
                <th className="px-4 py-4 text-right font-bold">{t("s0155")}</th>
                <th className="px-4 py-4 text-right font-bold">{t("s0156")}</th>
                <th className="px-5 py-4 text-right font-bold">{t("s0157")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {filteredAccounts.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-6 py-12 text-center text-muted-foreground">{t("s0133")}</td>
                </tr>
              )}
              {filteredAccounts.map(acc => (
                <tr key={acc.email} className="transition-colors hover:bg-black/5 dark:hover:bg-white/5">
                  <td className="px-5 py-4 align-middle">
                    <input type="checkbox" checked={selected.has(acc.email)} onChange={() => toggleSelected(acc.email)} aria-label={t("accounts.selectEmail", { email: acc.email })} />
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="max-w-[260px] truncate font-mono text-xs text-foreground/80">{maskedToken(acc.token)}</span>
                      <button type="button" onClick={() => handleCopyToken(acc)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("s0134")}>
                        <Clipboard className="size-4" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <span className="inline-flex rounded-full border bg-background/75 px-3 py-1 text-xs font-black">{serviceOf(acc)}</span>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="font-mono text-sm">{planOf(acc)}</div>
                    <div className="text-xs text-muted-foreground">{t("accounts.planSuffix", { service: serviceOf(acc) })}</div>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${statusStyle(effectiveStatusCode(acc))}`}>
                      <CheckCircle2 className="mr-1 size-3.5" />
                      {statusText(acc)}
                    </span>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="max-w-[280px] truncate font-mono text-sm text-foreground/90" title={acc.email}>{acc.email}</div>
                    {acc.source === "env" && (
                      <div className="mt-1 inline-flex w-fit items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300" title={acc.env_name || t("s0135")}>
                        <Lock className="size-3" /> {t("accounts.envInjected")}
                      </div>
                    )}
                    <div className="max-w-[280px] truncate text-xs text-muted-foreground" title={statusNote(acc)}>
                      {acc.username || t("s0136")}
                    </div>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <span className="inline-flex rounded-full border border-sky-400/40 bg-sky-500/10 px-3 py-1 font-mono text-sm font-bold text-sky-700 dark:text-sky-300">
                      {quotaOf(acc)}
                    </span>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="text-sm">{recoveryText(acc)}</div>
                    <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={statusNote(acc)}>{statusNote(acc) || "-"}</div>
                  </td>
                  <td className="px-4 py-4 text-right align-middle font-mono">{successOf(acc)}</td>
                  <td className="px-4 py-4 text-right align-middle font-mono">{failureOf(acc)}</td>
                  <td className="px-5 py-4 align-middle text-right">
                    <div className="flex items-center justify-end gap-1">
                      {effectiveStatusCode(acc) !== "valid" && effectiveStatusCode(acc) !== "rate_limited" && effectiveStatusCode(acc) !== "banned" && (
                        <IconButton title={t("s0137")} onClick={() => handleActivate(acc.email)}>
                          <MailWarning className="size-4" />
                        </IconButton>
                      )}
                      <IconButton title={t("s0138")} onClick={() => void handleEditAccount(acc)}>
                        <Edit3 className="size-4" />
                      </IconButton>
                      <IconButton title={t("s0139")} onClick={() => handleVerify(acc.email)} disabled={verifying === acc.email}>
                        {verifying === acc.email ? <RefreshCw className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                      </IconButton>
                      <IconButton title={acc.source === "env" ? t("s0140") : t("s0141")} onClick={() => handleDelete(acc)} disabled={acc.source === "env"} danger>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function MetricCard({ icon, label, value, tone = "neutral" }: { icon: ReactNode; label: string; value: number; tone?: "neutral" | "emerald" | "orange" | "rose" | "blue" }) {
  const toneClass = {
    neutral: "text-foreground",
    emerald: "text-emerald-600 dark:text-emerald-300",
    orange: "text-orange-600 dark:text-orange-300",
    rose: "text-rose-600 dark:text-rose-300",
    blue: "text-blue-600 dark:text-blue-300",
  }[tone]
  return (
    <div className="rounded-[28px] border border-white/75 bg-card/82 p-5 shadow-[var(--shadow-soft)]">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{label}</span>
        <span className="opacity-65">{icon}</span>
      </div>
      <div className={`mt-5 text-4xl font-black tracking-tight ${toneClass}`}>{value}</div>
    </div>
  )
}

function IconButton({ children, title, onClick, disabled, danger }: { children: ReactNode; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-grid size-9 place-items-center rounded-xl border border-transparent text-muted-foreground transition hover:border-white/75 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45 ${
        danger ? "hover:text-rose-600" : ""
      }`}
    >
      {children}
    </button>
  )
}
