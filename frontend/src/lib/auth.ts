import { t } from "./i18n"
/**
 * 规范化用户粘贴的管理凭证。
 *
 * 浏览器不能直接读取后端 data/api_keys.json；这里仅处理用户已经粘贴到
 * 控制台的值，避免把 "Bearer xxx"、Authorization 头或 JSON 片段原样保存。
 */
export function normalizeApiKey(input: string): string {
  let value = String(input || "").trim()
  if (!value) return ""

  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === "string") return normalizeApiKey(parsed)
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>
      const direct = record.key || record.api_key || record.apiKey || record.token
      if (typeof direct === "string") return normalizeApiKey(direct)
      if (Array.isArray(record.keys) && typeof record.keys[0] === "string") {
        return normalizeApiKey(record.keys[0])
      }
    }
  } catch {
    // 普通 key 文本不是 JSON，继续按 header/text 形式解析。
  }

  value = value.replace(/^[\s"'`]+|[\s"'`,]+$/g, "").trim()

  const headerMatch =
    value.match(/^(?:authorization\s*:\s*)?bearer\s+(.+)$/i) ||
    value.match(/^x-api-key\s*:\s*(.+)$/i)
  if (headerMatch?.[1]) {
    value = headerMatch[1].trim()
  } else {
    const embedded =
      value.match(/(?:authorization\s*:\s*)bearer\s+([^\s"'`,]+)/i) ||
      value.match(/(?:^|\s)bearer\s+([^\s"'`,]+)/i) ||
      value.match(/x-api-key\s*:\s*([^\s"'`,]+)/i)
    if (embedded?.[1]) value = embedded[1].trim()
  }

  return value.replace(/^[\s"'`]+|[\s"'`,]+$/g, "").trim()
}

export function getStoredApiKey(): string {
  try {
    const stored = localStorage.getItem('qwen2api_key')
    if (stored && stored.trim()) return normalizeApiKey(stored)
  } catch {
    // localStorage 不可用时返回空凭证，由服务端明确拒绝未授权请求。
  }
  return normalizeApiKey((import.meta.env.VITE_DEFAULT_ADMIN_KEY as string | undefined) || '')
}

export function setStoredApiKey(input: string): string {
  const key = normalizeApiKey(input)
  if (!key) return ""
  localStorage.setItem('qwen2api_key', key)
  return key
}

export function clearStoredApiKey() {
  localStorage.removeItem('qwen2api_key')
}

export function getAuthHeader(): Record<string, string> {
  const key = getStoredApiKey()
  if (!key) return {}
  return { Authorization: `Bearer ${key}` }
}

export async function adminRequestErrorMessage(res: Response): Promise<string> {
  let detail = ""
  try {
    const data = await res.clone().json()
    detail = String(data.detail || data.error || data.message || "").trim()
  } catch {
    // 非 JSON 错误响应只根据 HTTP 状态提示。
  }

  if (res.status === 401) {
    return t("auth.noSessionKey")
  }
  if (res.status === 403) {
    return t("auth.keyMismatch")
  }
  if (detail) return detail
  return t("auth.requestFailed", { status: res.status })
}
