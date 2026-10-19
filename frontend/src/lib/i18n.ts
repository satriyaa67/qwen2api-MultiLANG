/**
 * Lightweight i18n layer for the qwen2API WebUI.
 *
 * Supports three languages: zh (original), en (English), tr (Türkçe).
 * English and Turkish UI strings were translated from the original Chinese
 * during development (the DeepL API key was unavailable at the time); they
 * live in frontend/src/i18n/translations.json and can be refined with any
 * translation service.
 *
 * - `t(key, vars?)` is a plain function; it reads the current language at
 *   call time (safe for event handlers and module helpers).
 * - `useT()` is a React hook for components that render translated text; it
 *   re-renders the component when the language changes.
 * - `LanguageSwitcher` (components/LanguageSwitcher.tsx) changes the language.
 */
import { useSyncExternalStore } from "react"
import translations from "../i18n/translations.json"

export type Lang = "zh" | "en" | "tr"

export const LANGS: readonly Lang[] = ["zh", "en", "tr"]
export const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "English", tr: "Türkçe" }
export const LANG_STORAGE_KEY = "qwen2api_lang"

const dict = translations as Record<Lang, Record<string, string>>

function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (stored === "zh" || stored === "en" || stored === "tr") return stored
    const nav = (navigator.language || "").toLowerCase()
    if (nav.startsWith("tr")) return "tr"
    if (nav.startsWith("en")) return "en"
  } catch {
    // localStorage unavailable; keep the original default.
  }
  return "zh"
}

let currentLang: Lang = detectInitialLang()

const listeners = new Set<() => void>()

export function getLang(): Lang {
  return currentLang
}

export function setLang(lang: Lang): void {
  if (!LANGS.includes(lang) || lang === currentLang) return
  currentLang = lang
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    // Ignore storage failures; the in-memory language still switches.
  }
  listeners.forEach(fn => fn())
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const current = dict[currentLang] ?? {}
  let text = current[key] ?? dict.en[key] ?? dict.zh[key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
  const lang = useSyncExternalStore(subscribeLang, getLang)
  return { lang, setLang }
}

export function useT(): { lang: Lang; setLang: (lang: Lang) => void; t: typeof t } {
  const { lang, setLang } = useLang()
  return { lang, setLang, t }
}
