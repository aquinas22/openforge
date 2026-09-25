# Openforge

A beautiful, fast Minecraft launcher for Windows 11. Modpacks, texture packs, shaders, and mods
from **both CurseForge and Modrinth**, offline play for people who own the game, a one-click hand-off
to the official Minecraft Launcher, and a Java runtime it manages for
you — so a new player can go from a fresh install to playing Homestead or All the Mods without
installing a JDK, pasting an API key, or reading a wiki page.

Built with Electron + React + TypeScript.

![Openforge](build/icon.png)

## What it does

### Content, from everywhere

- **Two providers, one interface.** Modrinth and CurseForge are normalized into the same shapes, so
  a pack, a mod, a texture pack, and a shader all look and install the same way regardless of where
  they came from.
- **CurseForge first, Modrinth always.** Release builds carry a CurseForge key, so CurseForge is the
  default source; Discover and the instance editor fall back to Modrinth (no key, no setup) only
  while CurseForge is unavailable, and remember whichever source you pick.
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

### Playing

- **Offline, for owners.** Openforge starts the game itself with an offline profile (the UUID is the
  standard `OfflinePlayer:<name>` MD5 v3, so the same name keeps the same worlds). This is only
  unlocked on a PC where the official Minecraft Launcher has a signed-in account with a Java Edition
  profile (`%APPDATA%\.minecraft\launcher_accounts*.json`); otherwise Openforge explains why and
  offers to open the launcher. Only the presence of such an account is read - never tokens.
- **Or hand off** to the official Minecraft Launcher (classic install or the Microsoft Store / Xbox
  app) for online servers and Realms: Openforge prepares the instance and the launcher signs you in.
- **Quick Play**: jump straight into a saved world or a server address from the instance drawer.
- **Microsoft sign-in inside Openforge is switched off** until an approved Azure app registration
  exists. The code is kept, unreachable; [docs/microsoft-auth-plan.md](docs/microsoft-auth-plan.md)
  is the plan for turning it back on.

### Editing an instance

One **Edit** button opens Mods, Resource packs, Shaders, Data packs and Settings. Search CurseForge
or Modrinth inline, filtered to the instance's version and loader, and add with one click (required
dependencies come along and are listed); toggle, update or remove what is installed; drop `.jar` or
`.zip` files straight onto a tab. Settings save as you type. Changing the Minecraft version or
loader first checks every mod against the new target, then switches mods to matching builds.

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
  PAC scripts, and this computer's certificate store all apply. Settings → Content providers →
  Advanced runs a per-service
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

## CurseForge setup

Release builds ship a built-in CurseForge key (injected at build time from `OPENFORGE_CF_KEY`,
never logged, and never sent to the renderer), so CurseForge works with no setup. Builds from source
without that variable have no key, and Discover uses Modrinth until you add one of these under
Settings → Content providers → Advanced:

1. **Your own key** — paste a free key from <https://console.curseforge.com>. It overrides the
   built-in key and also unlocks bulk resolution, which large packs very much want.
2. **Proxy** — point Openforge at a ServerCraft-style server that holds the key server-side. It calls
   `/api/cf/search`, `/api/cf/packs/:id`, and `/api/cf/packs/:id/files`.

Priority is proxy, then your own key, then the built-in key.

## Architecture

```
src/
  main/                    Electron main process (Node) — all privileged work
    index.ts               window + lifecycle
    ipc.ts                 IPC orchestration, running-game registry
    core/
      paths.ts             filesystem layout
      store.ts             JSON persistence (settings / instances) + 1.x migration
      accounts.ts          account book (offline profiles; Microsoft accounts kept, hidden)
      ownership.ts         offline-play gate: official launcher account detection
      auth.ts              deterministic offline UUIDs
      msauth.ts            Microsoft -> Xbox Live -> XSTS -> Minecraft (switched off)
      features.ts          MICROSOFT_SIGN_IN_ENABLED switch
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

- **No Microsoft sign-in inside Openforge yet.** New Azure apps need Mojang's approval before they can
  call the Minecraft services; until then online play goes through the official launcher.
- **Forge / NeoForge** install by running the official installer, so they need network access and a
  Java matching the Minecraft version. Openforge provisions that automatically.
- **A few CurseForge projects opt out of third-party distribution.** Those are listed with direct
  links in the instance drawer so you can fetch them by hand; everything else installs normally.
- **Networks that inspect HTTPS** (many schools and workplaces) will block Mojang, Modrinth, and
  CurseForge with an untrusted certificate. Openforge reports this precisely in its connection check
  and never disables certificate verification to work around it — install the organisation's root
  certificate into the Windows trusted-root store, or use a different network.

## License

MIT
