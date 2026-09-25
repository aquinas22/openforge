import type { Instance } from '@shared/types'
import { Sprite, blockFor } from './bits'

/** The instance's picture: its pack icon or custom image, else its block. */
export function InstanceIcon({ inst, size }: { inst: Instance; size: number }): JSX.Element {
  return (
    <span className="slot editor-icon" style={{ width: size, height: size }}>
      {inst.iconUrl ? <img src={inst.iconUrl} alt="" /> : <Sprite src={blockFor(inst)} size={Math.round(size * 0.7)} />}
    </span>
  )
}
