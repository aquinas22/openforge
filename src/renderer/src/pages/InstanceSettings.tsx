import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, FolderOpen, Gauge, ImagePlus, Loader2, RotateCcw, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store/store'
import { cleanError, loaderLabel } from '../util'
import { LOADERS, type Instance, type LoaderType, type RetargetPlan } from '@shared/types'
import { recommendedRamMb } from '@shared/tuning'
import { SaveIndicator, type SaveState } from '../components/SaveIndicator'
import { InstanceIcon } from '../components/InstanceIcon'

const DEBOUNCE_MS = 400

/** Resize a picked image to a 128 px square PNG data URL, cover-cropped. */
async function iconFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not read that image.')
  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  bitmap.close()
  return canvas.toDataURL('image/png')
}

/**
 * The instance's own settings. Everything saves as it changes, like the app's
 * Settings, except the Minecraft version and loader: those check the mods
 * against the new target first and only apply once confirmed.
 */
export function InstanceSettings({
  inst,
  locked,
  running
}: {
  inst: Instance
  locked: boolean
  running: boolean
}): JSX.Element {
  const refreshInstances = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)
  const settings = useStore((s) => s.settings)
  const systemInfo = useStore((s) => s.systemInfo)
  const java = useStore((s) => s.java)

  // -- Auto-saved fields ---------------------------------------------------------
  const [name, setName] = useState(inst.name)
  const [jvmArgs, setJvmArgs] = useState(inst.jvmArgs ?? '')
  const [ramDraft, setRamDraft] = useState<number | null>(null)
  const [state, setState] = useState<SaveState>('idle')
  const pending = useRef<Partial<Instance>>({})
  const timer = useRef<number | undefined>(undefined)
  const fade = useRef<number | undefined>(undefined)
  const [modCount, setModCount] = useState<number | undefined>(undefined)

  useEffect(() => {
    api
      .listContent(inst.id, 'mod')
      .then((mods) => setModCount(mods.length))
      .catch(() => undefined)
  }, [inst.id])

  const flush = useCallback((): void => {
    window.clearTimeout(timer.current)
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    setState('saving')
    api
      .updateInstance(inst.id, patch)
      .then(async () => {
        await refreshInstances()
        setState('saved')
        window.clearTimeout(fade.current)
        fade.current = window.setTimeout(() => setState('idle'), 2200)
      })
      .catch((e) => {
        setState('error')
        toast(cleanError(e), 'error')
      })
  }, [inst.id, refreshInstances, toast])

  const save = useCallback(
    (patch: Partial<Instance>, when: 'now' | 'settle' = 'now'): void => {
      pending.current = { ...pending.current, ...patch }
      window.clearTimeout(timer.current)
      if (when === 'now') flush()
      else timer.current = window.setTimeout(flush, DEBOUNCE_MS)
    },
    [flush]
  )

  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(
    () => () => {
      flushRef.current()
      window.clearTimeout(fade.current)
    },
    []
  )

  // -- Memory ---------------------------------------------------------------------
  const maxRam = systemInfo?.maxRamMb ?? 4096
  const globalRam = settings?.ramMb ?? 4096
  const recommended = recommendedRamMb({
    totalMemoryMb: systemInfo?.totalMemoryMb ?? 8192,
    maxRamMb: maxRam,
    loader: inst.loader,
    modCount
  })
  const automaticRam = inst.loader === 'vanilla' ? globalRam : Math.max(globalRam, recommended)
  const autoRam = inst.ramMb === undefined && ramDraft === null
  const shownRam = ramDraft ?? inst.ramMb ?? automaticRam

  // -- Java -------------------------------------------------------------------------
  const javaChoices = useMemo(() => {
    const list = java.map((j) => ({ path: j.path, label: `Java ${j.majorVersion} (${j.version})${j.managed ? ' - managed' : ''}` }))
    if (inst.javaPath && !list.some((j) => j.path === inst.javaPath)) list.push({ path: inst.javaPath, label: inst.javaPath })
    return list
  }, [java, inst.javaPath])

  return (
    <div className="instance-settings">
      <div className="between instance-settings-head">
        <p className="muted">Changes apply the next time this instance starts.</p>
        <SaveIndicator state={state} />
      </div>

      <section className="panel settings-block">
        <h3>Profile</h3>
        <div className="profile-grid">
          <div className="icon-edit">
            <InstanceIcon inst={inst} size={72} />
            <label className="btn sm">
              <ImagePlus size={14} /> Choose image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  try {
                    save({ iconUrl: await iconFromFile(file) })
                  } catch (err) {
                    toast(cleanError(err), 'error')
                  }
                }}
              />
            </label>
            {inst.iconUrl && (
              <button className="btn sm ghost" onClick={() => save({ iconUrl: '' })}>
                Remove
              </button>
            )}
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label htmlFor="inst-name">Name</label>
            <input
              id="inst-name"
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value)
                if (e.target.value.trim()) save({ name: e.target.value }, 'settle')
              }}
              onBlur={() => {
                if (!name.trim()) setName(inst.name)
                flush()
              }}
            />
            <div className="hint">Mods, packs, worlds and options are kept separately for each instance.</div>
          </div>
        </div>
      </section>

      <VersionSection inst={inst} locked={locked} />

      <section className="panel settings-block">
        <div className="between">
          <h3>Memory</h3>
          <span className="chip accent">
            {(shownRam / 1024).toFixed(1)} GB{autoRam ? ' · automatic' : ''}
          </span>
        </div>
        <input
          className="slider"
          type="range"
          aria-label="Memory for this instance"
          min={1024}
          max={maxRam}
          step={256}
          value={Math.min(shownRam, maxRam)}
          onChange={(e) => {
            const value = Number(e.target.value)
            setRamDraft(value)
            save({ ramMb: value }, 'settle')
          }}
          onPointerUp={flush}
          onKeyUp={flush}
        />
        <div className="between hint" style={{ marginTop: 5 }}>
          <span>1 GB</span>
          <span>{(maxRam / 1024).toFixed(1)} GB safe maximum</span>
        </div>
        <div className="ram-auto">
          <Gauge size={14} />
          <span>
            {inst.loader === 'vanilla'
              ? `Automatic uses your default of ${(globalRam / 1024).toFixed(1)} GB.`
              : `Automatic: ${(automaticRam / 1024).toFixed(1)} GB for ${
                  modCount !== undefined ? `${modCount} mods` : 'this pack'
                } on ${((systemInfo?.totalMemoryMb ?? 0) / 1024).toFixed(0)} GB of system memory.`}
          </span>
          {!autoRam && (
            <button
              className="btn sm ghost"
              onClick={() => {
                setRamDraft(null)
                save({ ramMb: 0 })
              }}
            >
              <RotateCcw size={13} /> Use automatic
            </button>
          )}
        </div>
      </section>

      <section className="panel settings-block">
        <h3>Java</h3>
        <div className="field">
          <label htmlFor="inst-java">Java runtime</label>
          <div className="input-row">
            <select
              id="inst-java"
              className="select"
              value={inst.javaPath ?? ''}
              onChange={(e) => save({ javaPath: e.target.value })}
            >
              <option value="">Automatic - the version this Minecraft needs (recommended)</option>
              {javaChoices.map((j) => (
                <option key={j.path} value={j.path}>
                  {j.label}
                </option>
              ))}
            </select>
            <button
              className="btn"
              title="Pick a java.exe"
              onClick={async () => {
                const path = await api.pickFile([{ name: 'Java', extensions: ['exe'] }])
                if (path) save({ javaPath: path })
              }}
            >
              <FolderOpen size={14} /> Browse
            </button>
          </div>
          <div className="hint">
            Leave on automatic unless a pack asks for a specific Java. A runtime that fails to start falls back to
            automatic.
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="inst-jvm">Extra JVM arguments</label>
          <textarea
            id="inst-jvm"
            className="input"
            rows={2}
            placeholder="-Dsomething=true"
            value={jvmArgs}
            onChange={(e) => {
              setJvmArgs(e.target.value)
              save({ jvmArgs: e.target.value }, 'settle')
            }}
            onBlur={flush}
          />
          <div className="hint">
            Added after the global arguments. Tuned G1 garbage-collector flags are included unless you choose your own
            -XX:+Use…GC.
          </div>
        </div>
      </section>
      {running && <div className="hint">This instance is running; it picks these up next time it starts.</div>}
    </div>
  )
}

// -- Minecraft version and loader ----------------------------------------------------

function VersionSection({ inst, locked }: { inst: Instance; locked: boolean }): JSX.Element {
  const versions = useStore((s) => s.versions)
  const refreshInstances = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)

  const [mcVersion, setMcVersion] = useState(inst.mcVersion)
  const [loader, setLoader] = useState<LoaderType>(inst.loader)
  const [loaderVersion, setLoaderVersion] = useState(inst.loaderVersion ?? '')
  const [loaderVersions, setLoaderVersions] = useState<{ version: string; stable: boolean }[]>([])
  const [loadingLv, setLoadingLv] = useState(false)
  const [snapshots, setSnapshots] = useState(false)
  const [plan, setPlan] = useState<RetargetPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [updateMods, setUpdateMods] = useState(true)
  const [disableMissing, setDisableMissing] = useState(true)

  const versionList = useMemo(() => {
    const list = versions.filter((v) => snapshots || v.type === 'release').map((v) => v.id)
    if (!list.includes(inst.mcVersion)) list.unshift(inst.mcVersion)
    return list
  }, [versions, snapshots, inst.mcVersion])

  // Loader builds for the chosen version; keep the current one when nothing changed.
  useEffect(() => {
    setPlan(null)
    if (loader === 'vanilla') {
      setLoaderVersions([])
      setLoaderVersion('')
      return
    }
    let cancelled = false
    setLoadingLv(true)
    api
      .loaderVersions(loader, mcVersion)
      .then((list) => {
        if (cancelled) return
        setLoaderVersions(list)
        const keep = loader === inst.loader && mcVersion === inst.mcVersion && inst.loaderVersion
        setLoaderVersion(keep ? inst.loaderVersion! : (list.find((v) => v.stable) ?? list[0])?.version ?? '')
      })
      .catch(() => !cancelled && setLoaderVersions([]))
      .finally(() => !cancelled && setLoadingLv(false))
    return () => {
      cancelled = true
    }
  }, [loader, mcVersion, inst.loader, inst.mcVersion, inst.loaderVersion])

  const targetChanged = mcVersion !== inst.mcVersion || loader !== inst.loader
  const changed = targetChanged || (loader !== 'vanilla' && Boolean(loaderVersion) && loaderVersion !== (inst.loaderVersion ?? ''))
  const needsLoaderVersion = loader === 'forge' || loader === 'neoforge'
  const ready = changed && !loadingLv && (!needsLoaderVersion || Boolean(loaderVersion))

  const reset = (): void => {
    setMcVersion(inst.mcVersion)
    setLoader(inst.loader)
    setLoaderVersion(inst.loaderVersion ?? '')
    setPlan(null)
  }

  async function review(): Promise<void> {
    setPlanning(true)
    try {
      setPlan(await api.planRetarget(inst.id, { mcVersion, loader }))
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setPlanning(false)
    }
  }

  async function apply(withMods: boolean): Promise<void> {
    setApplying(true)
    try {
      const result = await api.retargetInstance(inst.id, {
        mcVersion,
        loader,
        loaderVersion: loader === 'vanilla' ? undefined : loaderVersion,
        updateMods: withMods && updateMods,
        disableMissing: withMods && disableMissing
      })
      await refreshInstances()
      setPlan(null)
      const parts = [
        result.updated.length ? `${result.updated.length} mods switched to matching builds` : '',
        result.disabled.length ? `${result.disabled.length} disabled` : ''
      ].filter(Boolean)
      toast(
        `Now ${loaderLabel(loader)} ${mcVersion}${parts.length ? ` - ${parts.join(', ')}` : ''}. Press Play to install it.`,
        'success'
      )
      if (result.failed.length) toast(`Could not switch: ${result.failed.join('; ')}`, 'error')
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setApplying(false)
    }
  }

  const counts = plan
    ? {
        ok: plan.items.filter((i) => i.status === 'ok' && !i.unchanged).length,
        same: plan.items.filter((i) => i.status === 'ok' && i.unchanged).length,
        missing: plan.items.filter((i) => i.status === 'missing'),
        unknown: plan.items.filter((i) => i.status === 'unknown')
      }
    : null

  return (
    <section className="panel settings-block">
      <h3>Minecraft version and loader</h3>
      <div className="version-grid">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="inst-mc">Minecraft version</label>
          <select id="inst-mc" className="select" value={mcVersion} disabled={locked} onChange={(e) => setMcVersion(e.target.value)}>
            {versionList.slice(0, 300).map((v) => (
              <option key={v} value={v}>
                {v}
                {v === inst.mcVersion ? '  (current)' : ''}
              </option>
            ))}
          </select>
          <label className="check-row snapshot-toggle">
            <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} /> Include snapshots
          </label>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="inst-loader-version">{loader === 'vanilla' ? 'Loader version' : `${loaderLabel(loader)} version`}</label>
          <select
            id="inst-loader-version"
            className="select"
            value={loaderVersion}
            disabled={locked || loader === 'vanilla' || loadingLv}
            onChange={(e) => setLoaderVersion(e.target.value)}
          >
            {loader === 'vanilla' && <option value="">Not needed</option>}
            {loadingLv && <option value={loaderVersion}>Loading…</option>}
            {!loadingLv && loader !== 'vanilla' && loaderVersions.length === 0 && (
              <option value="">No builds for {mcVersion}</option>
            )}
            {!loadingLv &&
              loaderVersions.slice(0, 120).map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                  {v.stable ? '' : ' (beta)'}
                  {v.version === inst.loaderVersion && loader === inst.loader ? '  (current)' : ''}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Mod loader">
        {LOADERS.map((key) => (
          <button
            key={key}
            role="radio"
            aria-checked={loader === key}
            className={loader === key ? 'active' : ''}
            disabled={locked}
            onClick={() => setLoader(key)}
          >
            {loaderLabel(key)}
          </button>
        ))}
      </div>

      {changed && !plan && (
        <div className="retarget-bar">
          <span>
            {loaderLabel(inst.loader)} {inst.mcVersion}
            {inst.loaderVersion ? ` (${inst.loaderVersion})` : ''} <ArrowRight size={13} /> {loaderLabel(loader)} {mcVersion}
            {loaderVersion && loader !== 'vanilla' ? ` (${loaderVersion})` : ''}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" onClick={reset}>
              Cancel
            </button>
            {targetChanged ? (
              <button className="btn sm primary" disabled={!ready || planning || locked} onClick={review}>
                {planning ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Check mods
              </button>
            ) : (
              <button className="btn sm primary" disabled={!ready || applying || locked} onClick={() => apply(false)}>
                {applying ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Apply
              </button>
            )}
          </div>
        </div>
      )}
      {locked && changed && <div className="hint">Close the game (or wait for installs) before changing the version.</div>}
      {needsLoaderVersion && !loadingLv && loaderVersions.length === 0 && (
        <div className="hint" style={{ color: 'var(--gold)' }}>
          {loaderLabel(loader)} has no build for Minecraft {mcVersion}.
        </div>
      )}

      {plan && counts && (
        <div className="retarget-plan">
          {plan.detachesPack && (
            <div className="notice warn">
              <TriangleAlert size={16} />
              <div>
                <strong>This instance stops following its modpack</strong>
                <span>Its files stay as they are, but pack updates will no longer be offered.</span>
              </div>
            </div>
          )}
          {plan.items.length === 0 ? (
            <p className="dim">No mods to check. Nothing else needs to change.</p>
          ) : (
            <>
              <ul className="retarget-summary">
                <li className="ok">
                  <Check size={14} /> {counts.ok + counts.same} of {plan.items.length} mods have a build for{' '}
                  {loaderLabel(plan.loader)} {plan.mcVersion}
                  {counts.ok ? ` (${counts.ok} will be switched)` : ''}
                </li>
                {counts.missing.length > 0 && (
                  <li className="bad">
                    <TriangleAlert size={14} /> {counts.missing.length} have no build: {counts.missing.map((i) => i.displayName).join(', ')}
                  </li>
                )}
                {counts.unknown.length > 0 && (
                  <li className="unknown">
                    <TriangleAlert size={14} /> {counts.unknown.length} not recognised, check them yourself:{' '}
                    {counts.unknown.map((i) => i.displayName).join(', ')}
                  </li>
                )}
              </ul>
              <label className="check-row">
                <input type="checkbox" checked={updateMods} onChange={(e) => setUpdateMods(e.target.checked)} /> Switch mods to
                their matching builds (with required dependencies)
              </label>
              {counts.missing.length > 0 && (
                <label className="check-row">
                  <input type="checkbox" checked={disableMissing} onChange={(e) => setDisableMissing(e.target.checked)} />{' '}
                  Disable the {counts.missing.length} mods with no build (they are kept, not deleted)
                </label>
              )}
            </>
          )}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn sm ghost" onClick={reset} disabled={applying}>
              Cancel
            </button>
            <button className="btn sm primary" onClick={() => apply(true)} disabled={applying || locked}>
              {applying ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Apply change
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
