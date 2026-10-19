import { t } from "./i18n"
import { API_BASE } from "./api"
import { getAuthHeader } from "./auth"

export type ModelCapability = {
  thinking?: boolean
  search?: boolean
  vision?: boolean
  deep_research?: boolean
  image_gen?: boolean
  video_gen?: boolean
  web_dev?: boolean
  slides?: boolean
}

export type ModelOption = {
  id: string
  base_model?: string
  family?: string
  mode?: string
  display_name?: string
  capabilities?: ModelCapability
}

export type ModelGroup = {
  family: string
  models: ModelOption[]
}

export const FALLBACK_CHAT_MODELS: ModelOption[] = [
  { id: "qwen3.6-plus", base_model: "qwen3.6-plus", family: "qwen3.6", mode: "chat", display_name: "qwen3.6-plus", capabilities: {} },
  { id: "qwen3.6-plus-thinking", base_model: "qwen3.6-plus", family: "qwen3.6", mode: "thinking", display_name: "qwen3.6-plus thinking", capabilities: { thinking: true } },
  { id: "qwen3.6-plus-search", base_model: "qwen3.6-plus", family: "qwen3.6", mode: "search", display_name: "qwen3.6-plus search", capabilities: { search: true } },
]

export const FALLBACK_IMAGE_MODELS: ModelOption[] = [
  { id: "qwen3.6-plus-image", base_model: "qwen3.6-plus", family: "qwen3.6", mode: "image", display_name: "qwen3.6-plus image", capabilities: { image_gen: true } },
]

export const FALLBACK_VIDEO_MODELS: ModelOption[] = [
  { id: "qwen3.6-plus-video", base_model: "qwen3.6-plus", family: "qwen3.6", mode: "video", display_name: "qwen3.6-plus video", capabilities: { video_gen: true } },
]

export const CAPABILITY_LABELS: Array<{ key: keyof ModelCapability; label: string }> = [
  { key: "thinking", label: "models.capThinking" },
  { key: "search", label: "models.capSearch" },
  { key: "vision", label: t("s0322") },
  { key: "deep_research", label: "models.capDeepResearch" },
  { key: "image_gen", label: "models.capImage" },
  { key: "video_gen", label: "models.capVideo" },
  { key: "web_dev", label: "models.capWebDev" },
  { key: "slides", label: "models.capSlides" },
]

const MODEL_MODE_SUFFIX_RE = /-(thinking|search|deep-research|deep_research|image|video|webdev|web-dev|slides|t2i|t2v)$/i
const TEXT_TEST_MODES = new Set(["chat", "thinking", "search", "deep_research"])
const GENERATION_MODES = new Set(["image", "video", "webdev", "slides"])
const MODE_NAME_SUFFIX: Record<string, string> = {
  thinking: "thinking",
  search: "search",
  deep_research: "deep_research",
  image: "image",
  video: "video",
  webdev: "webdev",
  slides: "slides",
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function modelMode(option: ModelOption): string {
  return option.mode || inferModeFromId(option.id)
}

function inferModeFromId(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.endsWith("-thinking")) return "thinking"
  if (id.endsWith("-search")) return "search"
  if (id.endsWith("-deep-research") || id.endsWith("-deep_research")) return "deep_research"
  if (id.endsWith("-image") || id.endsWith("-t2i")) return "image"
  if (id.endsWith("-video") || id.endsWith("-t2v")) return "video"
  if (id.endsWith("-webdev") || id.endsWith("-web-dev")) return "webdev"
  if (id.endsWith("-slides")) return "slides"
  return "chat"
}

function familyOf(option: ModelOption): string {
  if (option.family) return option.family
  const base = option.base_model || option.id.replace(MODEL_MODE_SUFFIX_RE, "")
  if (base.startsWith("qwen3.")) {
    const parts = base.split("-", 1)[0].split(".")
    if (parts.length >= 2) return parts.slice(0, 2).join(".")
  }
  return base.split("-", 1)[0] || "Qwen"
}

export function normalizeModelOption(value: unknown): ModelOption | null {
  if (typeof value === "string" && value) return { id: value, mode: inferModeFromId(value), capabilities: {} }
  const record = asRecord(value)
  const id = asText(record.id)
  if (!id) return null
  return {
    id,
    base_model: asText(record.base_model) || undefined,
    family: asText(record.family) || undefined,
    mode: asText(record.mode) || inferModeFromId(id),
    display_name: asText(record.display_name) || undefined,
    capabilities: asRecord(record.capabilities) as ModelCapability,
  }
}

export async function fetchModelOptions(): Promise<ModelOption[]> {
  const response = await fetch(`${API_BASE}/v1/models`, { headers: getAuthHeader() })
  if (!response.ok) return []
  const payload = await response.json()
  const rawItems = Array.isArray(payload?.data) ? payload.data : []
  return rawItems
    .map(normalizeModelOption)
    .filter((item: ModelOption | null): item is ModelOption => Boolean(item?.id))
}

export function isBaseModelOption(option: ModelOption): boolean {
  return option.base_model ? option.id === option.base_model : !MODEL_MODE_SUFFIX_RE.test(option.id)
}

export function isThinkingVariant(modelId: string): boolean {
  return /-thinking$/i.test(modelId)
}

export function capabilityBadges(option?: ModelOption): string[] {
  if (!option?.capabilities) return []
  return CAPABILITY_LABELS.filter(item => option.capabilities?.[item.key]).map(item => t(item.label))
}

export function filterTextTestModels(options: ModelOption[]): ModelOption[] {
  const filtered = options.filter(option => {
    const mode = modelMode(option)
    return TEXT_TEST_MODES.has(mode) && !GENERATION_MODES.has(mode)
  })
  const baseModels = filtered.filter(option => modelMode(option) === "chat")
  const existingIds = new Set(filtered.map(option => option.id))
  const searchVariants = baseModels
    .map(option => ({
      ...option,
      id: option.id.endsWith("-search") ? option.id : `${option.id}-search`,
      base_model: option.base_model || option.id,
      mode: "search",
      display_name: `${option.display_name || option.id} search`,
      capabilities: { search: true },
    }))
    .filter(option => !existingIds.has(option.id))
  const withSearch = [...filtered, ...searchVariants]
  return withSearch.length ? withSearch : FALLBACK_CHAT_MODELS
}

export function filterImageModels(options: ModelOption[]): ModelOption[] {
  const explicit = options.filter(option => modelMode(option) === "image")
  if (explicit.length) return explicit
  const capable = options
    .filter(option => option.capabilities?.image_gen && !GENERATION_MODES.has(modelMode(option)))
    .map(option => ({
      ...option,
      id: option.id.endsWith("-image") ? option.id : `${option.id}-image`,
      base_model: option.base_model || option.id,
      mode: "image",
      display_name: `${option.display_name || option.id} image`,
      capabilities: { image_gen: true },
    }))
  return capable.length ? capable : FALLBACK_IMAGE_MODELS
}

export function filterVideoModels(options: ModelOption[]): ModelOption[] {
  const explicit = options.filter(option => modelMode(option) === "video")
  if (explicit.length) return explicit
  const capable = options
    .filter(option => option.capabilities?.video_gen && !GENERATION_MODES.has(modelMode(option)))
    .map(option => ({
      ...option,
      id: option.id.endsWith("-video") ? option.id : `${option.id}-video`,
      base_model: option.base_model || option.id,
      mode: "video",
      display_name: `${option.display_name || option.id} video`,
      capabilities: { video_gen: true },
    }))
  return capable.length ? capable : FALLBACK_VIDEO_MODELS
}

export function chooseDefaultModel(options: ModelOption[], currentModel?: string, preferredId?: string): string {
  if (currentModel && options.some(option => option.id === currentModel)) return currentModel
  if (preferredId && options.some(option => option.id === preferredId)) return preferredId
  const base = options.find(isBaseModelOption)
  return base?.id || options[0]?.id || preferredId || "qwen3.6-plus"
}

export function groupModelOptions(options: ModelOption[]): ModelGroup[] {
  const groups = new Map<string, ModelOption[]>()
  options.forEach(option => {
    const family = familyOf(option)
    groups.set(family, [...(groups.get(family) || []), option])
  })
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, models]) => ({
      family,
      models: models.sort((a, b) => a.id.localeCompare(b.id)),
    }))
}

export function formatModeLabel(mode?: string): string {
  switch (mode) {
    case "thinking": return t("models.modeThinking")
    case "search": return t("models.modeSearch")
    case "deep_research": return t("models.modeDeepResearch")
    case "image": return t("models.modeImage")
    case "video": return t("models.modeVideo")
    case "webdev": return t("models.modeWebDev")
    case "slides": return t("models.modeSlides")
    default: return t("models.modeChat")
  }
}

export function formatModelName(option: ModelOption): string {
  const mode = modelMode(option)
  const suffix = MODE_NAME_SUFFIX[mode]
  const rawName = option.display_name || option.id
  const name = suffix ? rawName.replace(new RegExp(`\\s+${suffix}$`, "i"), "") : rawName
  return name === option.id ? option.id : `${name} (${option.id})`
}

export function formatModelOptionLabel(option: ModelOption): string {
  return `${formatModelName(option)} · ${formatModeLabel(modelMode(option))}`
}
