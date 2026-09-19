# Openforge

A beautiful, fast Minecraft launcher for Windows 11. Modpacks, texture packs, shaders, and mods
from **both Modrinth and CurseForge**, real Microsoft sign-in, and a Java runtime it manages for
you — so a new player can go from a fresh install to playing Homestead or All the Mods without
installing a JDK, pasting an API key, or reading a wiki page.

Built with Electron + React + TypeScript.

![Openforge](build/icon.png)

## What it does

### Content, from everywhere

- **Two providers, one interface.** Modrinth and CurseForge are normalized into the same shapes, so
  a pack, a mod, a texture pack, and a shader all look and install the same way regardless of where
  they came from.
- **Modrinth needs no setup.** No API key, no proxy, no account. This is the default source, and it
  carries most modern packs — Homestead included.
- **CurseForge installs fast.** With a direct API key, Openforge resolves modpack files through the
  bulk endpoints: a 400-mod pack like All the Mods resolves in one or two requests instead of four
  hundred. That is the difference between an install measured in seconds and one measured in
  minutes (and one that trips rate limits).
- **Texture packs, shaders, and data packs are first-class**, not an afterthought. Browse and install
  them exactly like mods, into the right folder, with a newly added texture pack switched on in
  `options.txt` automatically.
- **Import and export.** Drop in a `.mrpack` or a CurseForge pack zip; export any instance as either
  format to share it.

### Packs that update without eating your world

Every pack install records exactly which files it wrote. Updating replaces the pack's mods and
configs and removes files the previous release shipped that the new one dropped — while `saves/`,
`screenshots/`, `logs/`, `crash-reports/`, and `backups/` are never touched, and mods you added by
hand are never pruned. One-click world backups are a tab away.

### Java, handled

Minecraft pins an exact Java major version per release (8, 17, 21, and 25 for the newest builds),
and a pack built for one will not start on another. Openforge detects what you already have —
including runtimes the official launcher installed — and downloads the right Eclipse Temurin build
when nothing fits. Checksum-verified, kept beside the game files, removable from Settings.

### Online play, properly

- **Microsoft sign-in** via the OAuth 2.0 device code flow: you finish in your own browser, the
  launcher never sees a password, and there is no embedded webview. The full chain is implemented —
  Microsoft identity → Xbox Live → XSTS → Minecraft services — including entitlement and profile
  checks, silent token refresh, and specific messages for the failures players can actually fix
  (no Xbox profile, child account, no Java Edition licence).
- **Tokens are encrypted at rest** with Electron `safeStorage` (DPAPI on Windows), so a copied
  `accounts.json` is useless on another machine. Where the platform offers no encryption, Openforge
  refuses to persist the refresh token rather than writing a credential in plain text.
- **Multiple accounts**, Microsoft and offline side by side, switchable in one click.
- **Quick Play**: jump straight into a saved world or a server address from the instance drawer.
- **Or hand off** to the official Minecraft Launcher if you would rather it own authentication.

### The engine

- **Real vanilla installs** — live Mojang manifest, client jar, OS-ruled libraries, assets, extracted
  natives, all hash-verified through a concurrent download pool.
- **Every loader**: Fabric and **Quilt** (from their meta services), **Forge / NeoForge** (by running
  the official installer headlessly, so patch processors run exactly as the vanilla launcher does).
- **Downloads that cannot corrupt an install.** Bytes land in a `.part` file and are renamed into
  place only after the declared hash matches, so an interrupted download never leaves a truncated
  jar that later looks valid — the cause of the most baffling modpack crashes.
- **Mirrors and graceful degradation.** Dead CDN entries fall through to alternates; a pack whose
  author opted out of third-party distribution produces an actionable list of links rather than a
  number you can do nothing about.
- **Per-instance everything** — own mods, worlds, configs, RAM, JVM flags, and Java override.
- **Chromium's network stack.** Every request runs through Electron's `net`, so the system proxy,
  PAC scripts, and this computer's certificate store all apply. Settings → Network runs a per-service
  connection check and names HTTPS interception when it sees it.

## Design

Openforge is built around an open forge-gate mark: dark iron around a warm portal with a single mint
spark. Variable Inter handles the interface, JetBrains Mono carries technical metadata, both bundled
for offline use. Six biome themes each have original 3D/painterly forge landscapes, dedicated
material palettes, and theme-specific lighting. The Daylight theme is a first-class light interface
rather than a color inversion.

Existing installs are migrated automatically from earlier Openforge, Ars Fodina, and Aurora Launcher
data directories, including settings, instances, worlds, and managed-mod records. A 1.x offline
username becomes your first account.

## Requirements

- **Windows 11** (also runs on macOS/Linux for development)
- **Node.js 20+** and **npm** (to build)
- **Java** is no longer a prerequisite — Openforge fetches the runtime each pack needs. You can still
  point it at your own JDK in Settings.

## Getting started

```bash
npm install        # installs deps + the Electron binary
npm run dev        # hot-reloading dev app
```

## Verifying

```bash
npm run check      # typecheck both projects, then run the core verification suite
```

`scripts/verify.ts` bundles and runs the **real** core modules under Node against a local HTTP server
that stands in for the Modrinth CDN and a CurseForge proxy. That means the whole modpack path —
resolve, download, hash-verify, apply overrides, prune on update — is proven without touching the
internet, including:

- a pack update that removes a dropped mod while leaving the player's world byte-for-byte intact,
- a hand-added mod surviving that same update,
- a `../` zip-slip entry being refused,
- a hash mismatch failing the download and leaving no file or `.part` behind,
- a dead primary URL falling through to a mirror,
- client-unsupported (server-only) mods being skipped,
- `options.txt` merging texture packs without duplicating or clobbering other settings.

Live service reachability is probed at the end and **reported, not asserted**, so the suite is green
on an offline or restricted network.

## Building the Windows app

```bash
npm run dist            # NSIS installer + portable .exe (x64)  -> release/<version>/
npm run dist:portable   # portable .exe only
```

### One-click Windows build

Install **Node.js 20 LTS or newer** from <https://nodejs.org>, then double-click `build-windows.cmd`.
It installs the locked dependencies, type-checks the project, and builds both the installer and the
portable executable. You do not need Visual Studio or a JDK to package the launcher.

### Build Windows releases on a Linux server

```bash
npm run release:windows:linux
```

Needs Node.js 20+, npm, and Wine. Cross-built artifacts are unsigned and do not receive the
configured icon/version resource, so build on Windows when you need final signing and executable
metadata.

## Setting up Microsoft sign-in

Microsoft grants Minecraft sign-in only to a registered Azure application, and Openforge ships no
shared client ID of its own. To sign in natively:

1. Create a free app registration in the Azure portal (supported account type: **personal Microsoft
   accounts**; platform: **public client / native**, with device-code flow allowed).
2. Paste its **Application (client) ID** into Settings → Microsoft sign-in.
3. Open the account menu and choose **Sign in** — a code appears, you enter it once in your browser.

Leave the field empty and online play uses the Minecraft Launcher hand-off instead, which needs no
setup at all.

## CurseForge setup

Modrinth works with no configuration. CurseForge needs one of:

1. **Direct key (recommended)** — paste a free key from <https://console.curseforge.com>. This is the
   only mode that unlocks bulk resolution, which large packs very much want.
2. **Proxy** — point Openforge at a ServerCraft-style server that holds the key server-side. It calls
   `/api/cf/search`, `/api/cf/packs/:id`, and `/api/cf/packs/:id/files`.

Openforge never ships an API key inside the desktop app.

## Architecture

```
src/
  main/                    Electron main process (Node) — all privileged work
    index.ts               window + lifecycle
    ipc.ts                 IPC orchestration, running-game registry
    core/
      paths.ts             filesystem layout
      store.ts             JSON persistence (settings / instances) + 1.x migration
      accounts.ts          account book; tokens encrypted with safeStorage
      auth.ts              deterministic offline UUIDs
      msauth.ts            Microsoft -> Xbox Live -> XSTS -> Minecraft services
      network.ts           proxy configuration for Chromium's stack
      http.ts              transport, atomic hash-verified downloads, mirrors
      manifest.ts          Mojang version manifest + version JSON types
      rules.ts             OS/allow-disallow rules, native classifiers, maven paths
      installer.ts         resolve + install (client, libs, assets, natives)
      fabric.ts            Fabric + Quilt loader install
      forge.ts             Forge / NeoForge headless install + version listing
      java.ts              Java discovery + version selection
      javaprovision.ts     Eclipse Temurin download/extract/probe
      launcher.ts          JVM command-line build + spawn, Quick Play
      modrinth.ts          Modrinth v2 client
      curseforge.ts        CurseForge client (proxy or direct) + bulk endpoints
      packinstall.ts       .mrpack + CurseForge pack install, update pruning
      content.ts           mods / texture packs / shaders / data packs
      worlds.ts            world listing + backups
      official-launcher.ts hand-off to the Minecraft Launcher
  preload/index.ts         contextBridge — exposes window.openforge
  shared/                  types + IPC contract shared by main & renderer
  renderer/                React UI (Vite)
```

The renderer is fully sandboxed from the OS: it never touches the filesystem or network directly —
every action funnels through the preload bridge into the main process.

## Known limitations

- **Microsoft sign-in needs your own Azure client ID** (above). This is a Microsoft policy, not a
  gap in the implementation; the flow itself is complete.
- **Forge / NeoForge** install by running the official installer, so they need network access and a
  Java matching the Minecraft version. Openforge provisions that automatically.
- **A few CurseForge projects opt out of third-party distribution.** Those are listed with direct
  links in the instance drawer so you can fetch them by hand; everything else installs normally.
- **Networks that inspect HTTPS** (many schools and workplaces) will block Mojang, Modrinth, and
  CurseForge with an untrusted certificate. Openforge reports this precisely in Settings → Network
  and never disables certificate verification to work around it — install the organisation's root
  certificate into the Windows trusted-root store, or use a different network.

## License

MIT
