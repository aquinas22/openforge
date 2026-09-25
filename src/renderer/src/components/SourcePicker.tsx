import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { ProviderStatus } from '@shared/ipc'
import type { Provider } from '@shared/types'

const NAMES: Record<Provider, string> = { curseforge: 'CurseForge', modrinth: 'Modrinth' }

/** One line on what each source is like right now. */
function hintFor(provider: Provider, status: ProviderStatus): string {
  if (provider === 'modrinth') return 'Open catalogue, no setup'
  switch (status.curseforge.mode) {
    case 'builtin':
      return 'Largest catalogue, fast installs'
    case 'direct':
      return 'Your own key, fast installs'
    case 'proxy':
      return 'Through your proxy'
    default:
      return 'Unavailable - add a key in Settings'
  }
}

/**
 * "Source: CurseForge v" - a compact select for the content provider, used by
 * Discover and by the instance content panel. CurseForge is listed first
 * because it is the default whenever it is available.
 */
export function SourcePicker({
  value,
  onChange,
  status,
  label = 'Source'
}: {
  value: Provider
  onChange: (provider: Provider) => void
  status: ProviderStatus
  label?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  const options: Provider[] = ['curseforge', 'modrinth']
  const enabled = (provider: Provider): boolean => provider === 'modrinth' || status.curseforge.available

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const pick = (provider: Provider): void => {
    if (!enabled(provider)) return
    setOpen(false)
    if (provider !== value) onChange(provider)
  }

  return (
    <div className="source-picker" ref={root}>
      <button
        type="button"
        className="source-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const next = options[(options.indexOf(value) + 1) % options.length]
            if (enabled(next)) onChange(next)
          }
        }}
      >
        <span className="source-picker-label">{label}:</span>
        <span className={`source-dot ${value}`} aria-hidden="true" />
        <strong>{NAMES[value]}</strong>
        <ChevronDown size={14} className="source-picker-caret" />
      </button>
      {open && (
        <ul className="source-picker-menu" role="listbox" id={listId} aria-label={label}>
          {options.map((provider) => (
            <li
              key={provider}
              role="option"
              aria-selected={provider === value}
              aria-disabled={!enabled(provider)}
              className={`${provider === value ? 'selected' : ''}${enabled(provider) ? '' : ' disabled'}`}
              onClick={() => pick(provider)}
            >
              <span className={`source-dot ${provider}`} aria-hidden="true" />
              <span className="source-picker-copy">
                <strong>{NAMES[provider]}</strong>
                <small>{hintFor(provider, status)}</small>
              </span>
              {provider === value && <Check size={14} className="source-picker-check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
