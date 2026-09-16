import { useMemo } from 'react'
import type { Instance, ThemeId } from '@shared/types'

import logoUrl from '../assets/art/openforge-mark-512.png'
import artTerra from '../assets/art/forge-terra.webp'
import artInfernum from '../assets/art/forge-infernum.webp'
import artFinis from '../assets/art/forge-finis.webp'
import artTenebrae from '../assets/art/forge-tenebrae.webp'
import artGlacies from '../assets/art/forge-glacies.webp'
import artLux from '../assets/art/forge-lux.webp'
import blockGrass from '../assets/pixel/block-grass.png'
import blockCrafting from '../assets/pixel/block-crafting.png'
import blockFurnace from '../assets/pixel/block-furnace.png'
import blockEmerald from '../assets/pixel/block-emerald.png'
import blockNetherrack from '../assets/pixel/block-netherrack.png'
import blockEndstone from '../assets/pixel/block-endstone.png'
import blockSculk from '../assets/pixel/block-sculk.png'
import blockIce from '../assets/pixel/block-ice.png'
import iconChest from '../assets/pixel/icon-chest.png'
import iconCompass from '../assets/pixel/icon-compass.png'
import iconPickaxe from '../assets/pixel/icon-pickaxe.png'

export const sprites = {
  logo: logoUrl,
  grass: blockGrass,
  crafting: blockCrafting,
  furnace: blockFurnace,
  emerald: blockEmerald,
  netherrack: blockNetherrack,
  endstone: blockEndstone,
  sculk: blockSculk,
  ice: blockIce,
  chest: iconChest,
  compass: iconCompass,
  pickaxe: iconPickaxe
}

/** The open forge gate: a warm portal cut into a block of forged iron. */
export function Logo({ size = 26 }: { size?: number }): JSX.Element {
  return <img className="brand-mark" src={sprites.logo} width={size} height={size} alt="" aria-hidden />
}

/** A pixel sprite at an exact multiple of its 64px grid. */
export function Sprite({
  src,
  size = 32,
  alt = ''
}: {
  src: string
  size?: number
  alt?: string
}): JSX.Element {
  return (
    <img
      className="pixel"
      src={src}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
    />
  )
}

/**
 * Pick a block to stand in for an instance that has no CurseForge artwork.
 * The loader decides the block, so the library reads as a row of ore samples.
 */
export function blockFor(inst: Pick<Instance, 'loader' | 'source' | 'id'>): string {
  if (inst.source === 'curseforge') return sprites.chest
  switch (inst.loader) {
    case 'fabric':
      return sprites.crafting
    case 'forge':
      return sprites.furnace
    case 'neoforge':
      return sprites.emerald
    default:
      return sprites.grass
  }
}

/** AI-authored forge landscapes, used by the theme picker and world plates. */
export const themeArt: Record<ThemeId, string> = {
  terra: artTerra,
  infernum: artInfernum,
  finis: artFinis,
  tenebrae: artTenebrae,
  glacies: artGlacies,
  lux: artLux
}

/** Deterministic blocky avatar for an offline player (no skin server needed). */
export function Avatar({ name, size = 40 }: { name: string; size?: number }): JSX.Element {
  const cells = useMemo(() => {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    const grid = 5
    const out: boolean[] = []
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < Math.ceil(grid / 2); x++) {
        const on = ((h >> ((y * 3 + x) % 31)) & 1) === 1
        out[y * grid + x] = on
        out[y * grid + (grid - 1 - x)] = on // mirror for symmetry
      }
    }
    return out
  }, [name])

  const grid = 5
  const px = size / grid
  // Painted from theme tokens rather than a random hue, so the sigil always
  // belongs to the biome the player is looking at.
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      aria-label={`${name} avatar`}
    >
      <rect width={size} height={size} fill="var(--bedrock)" />
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={(i % grid) * px}
            y={Math.floor(i / grid) * px}
            width={px}
            height={px}
            fill="var(--vein)"
          />
        ) : null
      )}
    </svg>
  )
}

/** The current forge landscape behind the workspace. */
export function WorldBackground(): JSX.Element {
  return (
    <div className="world-bg" aria-hidden>
      <div className="world-plate" />
      <div className="world-wash" />
    </div>
  )
}
