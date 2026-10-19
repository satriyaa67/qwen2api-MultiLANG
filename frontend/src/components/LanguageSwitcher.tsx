import { Globe } from "lucide-react"
import { LANG_LABELS, LANGS, useLang, type Lang } from "../lib/i18n"

export default function LanguageSwitcher() {
  const { lang, setLang } = useLang()
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-white/75 bg-card/70 px-2.5 py-1 text-xs font-bold text-muted-foreground shadow-sm">
      <Globe className="size-3.5" />
      <select
        value={lang}
        onChange={e => setLang(e.target.value as Lang)}
        aria-label={LANG_LABELS[lang]}
        className="cursor-pointer bg-transparent text-xs font-bold text-foreground outline-none"
      >
        {LANGS.map(l => (
          <option key={l} value={l}>
            {LANG_LABELS[l]}
          </option>
        ))}
      </select>
    </div>
  )
}
