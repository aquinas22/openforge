import { Check, Loader2, TriangleAlert } from 'lucide-react'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** The quiet status line that replaces a Save button on auto-saving forms. */
export function SaveIndicator({ state }: { state: SaveState }): JSX.Element {
  return (
    <div className={`save-indicator ${state}`} role="status" aria-live="polite">
      {state === 'saving' ? (
        <>
          <Loader2 size={13} className="spin" /> Saving…
        </>
      ) : state === 'saved' ? (
        <>
          <Check size={13} /> Saved
        </>
      ) : state === 'error' ? (
        <>
          <TriangleAlert size={13} /> Not saved
        </>
      ) : (
        <>Changes save automatically</>
      )}
    </div>
  )
}
