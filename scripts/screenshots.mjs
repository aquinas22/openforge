// Capture the README screenshots from a built Openforge, using only demo data.
//
//   npm run build            (with OPENFORGE_CF_KEY set if CurseForge results should show)
//   node scripts/screenshots.mjs
//
// The script seeds an isolated data folder with fake profiles, a fake
// options.txt, fake mod configs, a fake local server and a stand-in .minecraft
// folder whose launcher_accounts.json holds an obviously fake profile
// ("DemoPlayer"). It then starts the unpackaged app with OPENFORGE_USER_DATA and
// OPENFORGE_MINECRAFT_DIR pointing there (both ignored by packaged builds), so
// the real Openforge data folder and the real .minecraft are never read or
// written. It drives the window over the Chrome DevTools Protocol and writes
// PNGs to docs/screenshots/.
//
// Environment:
//   OPENFORGE_DEMO_DIR   where the demo data goes (default: <repo>/.demo). It is
//                        wiped and re-seeded on every run, so the script refuses
//                        any folder it did not create itself.
//   SCREENSHOT_PORT      remote debugging port (default 9222)
//   --seed-only          seed the demo folder and exit

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const demoRoot = resolve(process.env.OPENFORGE_DEMO_DIR || join(repo, '.demo'))
const outDir = join(repo, 'docs', 'screenshots')
const port = Number(process.env.SCREENSHOT_PORT || 9222)
const WIDTH = 1280
const HEIGHT = 800
const MARKER = '.openforge-demo'

const dataDir = join(demoRoot, 'data')
const gameDir = join(dataDir, 'minecraft')
const fakeMinecraftDir = join(demoRoot, 'dot-minecraft')
const serverDir = join(demoRoot, 'servers', 'cozy-smp')

// -- Safety -----------------------------------------------------------------------

function refuseRealData() {
  const appData = process.env.APPDATA ?? ''
  const forbidden = [join(appData, 'Openforge'), join(appData, '.minecraft')].filter((p) => appData && p)
  const norm = (p) => resolve(p).toLowerCase() + sep
  for (const real of forbidden) {
    if (norm(demoRoot).startsWith(norm(real)) || norm(real).startsWith(norm(demoRoot))) {
      throw new Error(`Refusing to use ${demoRoot}: it overlaps real launcher data.`)
    }
  }
  if (existsSync(demoRoot) && readdirSync(demoRoot).length > 0 && !existsSync(join(demoRoot, MARKER))) {
    throw new Error(`Refusing to wipe ${demoRoot}: it was not created by this script.`)
  }
}

// -- Demo data ---------------------------------------------------------------------

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()

const INSTANCES = [
  {
    id: 'demo-cozy-survival',
    name: 'Cozy Survival',
    mcVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: '21.1.77',
    launchVersion: 'neoforge-21.1.77',
    lastPlayed: hoursAgo(2),
    totalPlaySeconds: 38 * 3600 + 1200,
    mods: [
      ['sophisticated-backpacks', 'Sophisticated Backpacks', '3.20.17'],
      ['farmers-delight', "Farmer's Delight", '1.2.6'],
      ['jei', 'Just Enough Items', '19.21.0'],
      ['supplementaries', 'Supplementaries', '3.0.4'],
      ['xaeros-minimap', "Xaero's Minimap", '24.6.1'],
      ['sodium', 'Sodium', '0.6.5']
    ]
  },
  {
    id: 'demo-create-ab',
    name: 'Create: Above & Beyond',
    mcVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.3.0',
    launchVersion: '1.20.1-forge-47.3.0',
    lastPlayed: hoursAgo(26),
    totalPlaySeconds: 112 * 3600,
    options: true,
    mods: [
      ['create', 'Create', '0.5.1.j'],
      ['jei', 'Just Enough Items', '15.20.0'],
      ['ftb-quests', 'FTB Quests', '2001.4.9'],
      ['journeymap', 'JourneyMap', '5.10.3'],
      ['embeddium', 'Embeddium', '0.3.31'],
      ['createaddition', 'Create Crafts & Additions', '1.2.4'],
      ['storagedrawers', 'Storage Drawers', '12.9.13'],
      ['jade', 'Jade', '11.12.3'],
      ['appleskin', 'AppleSkin', '2.5.1'],
      ['mouse-tweaks', 'Mouse Tweaks', '2.25.1']
    ],
    configs: {
      'config/create-client.toml': '[client]\n\tenableTooltips = true\n\tenableOverstressedTooltip = true\n',
      'config/create-common.toml': '[worldgen]\n\tdisableWorldGen = false\n',
      'config/jei/jei-client.ini': '[appearance]\nMaxColumns = 9\n',
      'config/journeymap/journeymap.core.config': '{ "mappingEnabled": true }\n',
      'config/jade/plugins.json': '{ "minecraft": { "item_storage": true } }\n',
      'config/embeddium-options.json': '{ "quality": { "weather_quality": "FAST" } }\n',
      'config/ftbquests/client-config.snbt': '{ show_lock_icon: true }\n',
      'config/oldmod-settings.toml': '# left behind by a removed mod\n'
    }
  },
  {
    id: 'demo-vanilla-plus',
    name: 'Vanilla+',
    mcVersion: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.9',
    launchVersion: 'fabric-loader-0.16.9-1.21.1',
    lastPlayed: hoursAgo(72),
    totalPlaySeconds: 14 * 3600 + 600,
    mods: [
      ['fabric-api', 'Fabric API', '0.110.0'],
      ['sodium', 'Sodium', '0.6.5'],
      ['lithium', 'Lithium', '0.14.3'],
      ['iris', 'Iris Shaders', '1.8.1'],
      ['modmenu', 'Mod Menu', '11.0.3']
    ]
  },
  {
    id: 'demo-skyblock',
    name: 'Skyblock Weekend',
    mcVersion: '1.20.1',
    loader: 'fabric',
    loaderVersion: '0.16.9',
    launchVersion: 'fabric-loader-0.16.9-1.20.1',
    lastPlayed: hoursAgo(24 * 9),
    totalPlaySeconds: 6 * 3600,
    mods: [['fabric-api', 'Fabric API', '0.92.2']]
  },
  {
    id: 'demo-hardcore',
    name: 'Hardcore Nights',
    mcVersion: '1.21.4',
    loader: 'vanilla',
    launchVersion: '1.21.4',
    mods: []
  }
]

const VANILLA_KEYS = {
  'key.attack': 'key.mouse.left',
  'key.use': 'key.mouse.right',
  'key.forward': 'key.keyboard.w',
  'key.left': 'key.keyboard.a',
  'key.back': 'key.keyboard.s',
  'key.right': 'key.keyboard.d',
  'key.jump': 'key.keyboard.space',
  'key.sneak': 'key.keyboard.left.shift',
  'key.sprint': 'key.keyboard.left.control',
  'key.drop': 'key.keyboard.q',
  'key.inventory': 'key.keyboard.e',
  'key.chat': 'key.keyboard.t',
  'key.playerlist': 'key.keyboard.tab',
  'key.pickItem': 'key.mouse.middle',
  'key.command': 'key.keyboard.slash',
  'key.socialInteractions': 'key.keyboard.p',
  'key.screenshot': 'key.keyboard.f2',
  'key.togglePerspective': 'key.keyboard.f5',
  'key.smoothCamera': 'key.keyboard.unknown',
  'key.fullscreen': 'key.keyboard.f11',
  'key.spectatorOutlines': 'key.keyboard.unknown',
  'key.swapOffhand': 'key.keyboard.f',
  'key.saveToolbarActivator': 'key.keyboard.c',
  'key.loadToolbarActivator': 'key.keyboard.x',
  'key.advancements': 'key.keyboard.l',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`key.hotbar.${i + 1}`, `key.keyboard.${i + 1}`]))
}

// Two deliberate clashes: JEI's bookmark on A (Strafe Left) and FTB Quests on L (Advancements).
const MOD_KEYS = {
  'key.jei.bookmark': 'key.keyboard.a',
  'key.jei.showRecipe': 'key.keyboard.r',
  'key.jei.showUses': 'key.keyboard.u',
  'key.ftbquests.quests': 'key.keyboard.l',
  'key.journeymap.fullscreen': 'key.keyboard.j',
  'key.journeymap.create_waypoint': 'key.keyboard.b',
  'key.create.toolmenu': 'key.keyboard.left.alt',
  'key.create.rotate_menu': 'key.keyboard.unknown'
}

function optionsTxt() {
  const lines = ['version:3465', 'autoJump:false', 'fov:0.0', 'renderDistance:12', 'guiScale:0', 'lang:en_us']
  for (const [id, key] of Object.entries({ ...VANILLA_KEYS, ...MOD_KEYS })) lines.push(`key_${id}:${key}`)
  lines.push('soundCategory_master:0.8', 'soundCategory_music:0.4')
  return lines.join('\n') + '\n'
}

function fakeJar(modId, name, version, loader) {
  const zip = new AdmZip()
  if (loader === 'fabric' || loader === 'quilt') {
    const meta = { schemaVersion: 1, id: modId.replace(/-/g, '_'), version, name, description: 'Demo placeholder.' }
    zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta, null, 2)))
  } else {
    const toml = `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="demo"\n[[mods]]\nmodId="${modId.replace(/-/g, '')}"\nversion="${version}"\ndisplayName="${name}"\n`
    zip.addFile(loader === 'neoforge' ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml', Buffer.from(toml))
  }
  // Some bulk so sizes look like real jars.
  zip.addFile('assets/demo/padding.bin', Buffer.alloc(40_000 + Math.floor(Math.random() * 400_000), 7))
  return zip.toBuffer()
}

const FAKE_SERVER_PS1 = String.raw`# A stand-in Minecraft server for screenshots. Prints server-like output and
# answers a few console commands; it does not run Minecraft.
function T { (Get-Date).ToString('HH:mm:ss') }
function Say($thread, $msg) { [Console]::Out.WriteLine("[$(T)] [$thread/INFO]: $msg"); [Console]::Out.Flush() }
Say 'main' 'Environment: Environment[sessionHost=https://sessionserver.mojang.com, name=PROD]'
Start-Sleep -Milliseconds 300
Say 'Server thread' 'Starting minecraft server version 1.21.1'
Say 'Server thread' 'Loading properties'
Say 'Server thread' 'Default game type: SURVIVAL'
Say 'Server thread' 'Starting Minecraft server on *:25565'
Start-Sleep -Milliseconds 400
Say 'Server thread' 'Preparing level "world"'
foreach ($p in 12, 47, 83, 100) { Say 'Worker-Main-2' "Preparing spawn area: $p%"; Start-Sleep -Milliseconds 200 }
Say 'Server thread' 'Done (4.182s)! For help, type "help"'
Start-Sleep -Milliseconds 600
Say 'Server thread' 'Alex joined the game'
Start-Sleep -Milliseconds 300
Say 'Server thread' 'Steve joined the game'
Say 'Server thread' '<Alex> anyone up for the nether?'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()
  if ($cmd -eq 'stop') { Say 'Server thread' 'Stopping the server'; Say 'Server thread' 'Saving worlds'; break }
  elseif ($cmd -eq 'list') { Say 'Server thread' 'There are 2 of a max of 20 players online: Alex, Steve' }
  elseif ($cmd -like 'say *') { Say 'Server thread' ('[Server] ' + $cmd.Substring(4)) }
  elseif ($cmd) { Say 'Server thread' "Unknown or incomplete command: $cmd" }
}
`

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function seed() {
  refuseRealData()
  rmSync(demoRoot, { recursive: true, force: true })
  mkdirSync(demoRoot, { recursive: true })
  writeFileSync(join(demoRoot, MARKER), 'Demo data for scripts/screenshots.mjs. Safe to delete.\n')

  writeJson(join(dataDir, 'settings.json'), {
    settingsVersion: 2,
    gameDir,
    javaPath: '',
    autoJava: true,
    ramMb: 6144,
    theme: 'terra',
    uiStyle: 'modern',
    defaultProvider: 'curseforge',
    cfProxyUrl: '',
    cfApiKey: '',
    msClientId: '',
    launchMode: 'direct',
    closeLauncherOnLaunch: false,
    fullscreen: false,
    resolutionWidth: 1280,
    resolutionHeight: 720,
    downloadConcurrency: 16,
    proxyUrl: ''
  })

  writeJson(join(dataDir, 'accounts.json'), {
    activeId: 'demo-account',
    accounts: [
      {
        id: 'demo-account',
        kind: 'offline',
        username: 'DemoPlayer',
        uuid: '00000000-0000-3000-8000-000000000000',
        addedAt: hoursAgo(24 * 30)
      }
    ]
  })

  const created = hoursAgo(24 * 40)
  writeJson(join(dataDir, 'instances.json'), {
    instances: INSTANCES.map((i) => ({
      id: i.id,
      name: i.name,
      mcVersion: i.mcVersion,
      loader: i.loader,
      ...(i.loaderVersion ? { loaderVersion: i.loaderVersion } : {}),
      source: 'import',
      ramMb: i.loader === 'vanilla' ? 3072 : 6144,
      createdAt: created,
      installed: true,
      launchVersion: i.launchVersion,
      ...(i.lastPlayed ? { lastPlayed: i.lastPlayed, totalPlaySeconds: i.totalPlaySeconds } : {})
    }))
  })

  for (const inst of INSTANCES) {
    const dir = join(gameDir, 'instances', inst.id)
    mkdirSync(join(dir, 'mods'), { recursive: true })
    mkdirSync(join(dir, 'saves'), { recursive: true })
    const entries = []
    for (const [slug, name, version] of inst.mods) {
      const fileName = `${slug}-${version}.jar`
      writeFileSync(join(dir, 'mods', fileName), fakeJar(slug, name, version, inst.loader))
      entries.push({ kind: 'mod', fileName, name, version })
    }
    writeJson(join(dir, '.openforge-content.json'), { entries })
    if (inst.options) writeFileSync(join(dir, 'options.txt'), optionsTxt())
    for (const [rel, text] of Object.entries(inst.configs ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
  }

  // Stand-in for %APPDATA%\.minecraft: one fake launcher account, no tokens.
  writeJson(join(fakeMinecraftDir, 'launcher_accounts.json'), {
    accounts: {
      demo: {
        localId: 'demo',
        type: 'Xbox',
        username: 'demo@example.invalid',
        minecraftProfile: { id: '00000000000030008000000000000000', name: 'DemoPlayer' }
      }
    },
    activeAccountLocalId: 'demo',
    mojangClientToken: 'demo'
  })

  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'start.ps1'), FAKE_SERVER_PS1)
  writeFileSync(join(serverDir, 'eula.txt'), 'eula=true\n')
  writeFileSync(join(serverDir, 'server.properties'), 'motd=Cozy SMP\nmax-players=20\nserver-port=25565\n')
  writeJson(join(dataDir, 'servers.json'), {
    servers: [
      {
        id: 'demo-server-local',
        kind: 'local',
        name: 'Cozy SMP',
        createdAt: created,
        dir: serverDir,
        launch: 'script',
        file: 'start.ps1',
        javaPath: '',
        ramMb: 4096,
        jvmArgs: '',
        stopTimeoutSec: 20
      },
      {
        id: 'demo-server-ssh',
        kind: 'ssh',
        name: 'Friends Realm (VPS)',
        createdAt: created,
        host: 'mc.example.net',
        port: 22,
        user: 'minecraft',
        identityFile: '',
        control: 'tmux',
        session: 'minecraft',
        unit: 'minecraft',
        serverDir: '~/server',
        startScript: './run.sh',
        logPath: 'logs/latest.log',
        startCommand: '',
        stopCommand: '',
        statusCommand: '',
        sendCommand: '',
        tailCommand: ''
      }
    ]
  })
}

// -- CDP -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('The app did not expose a debugging target.')
}

function connect(url) {
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(url)
    let seq = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) fail(new Error(msg.error.message))
        else ok(msg.result)
      }
    }
    ws.onerror = () => reject(new Error('CDP connection failed'))
    ws.onopen = () =>
      resolveConn({
        send: (method, params = {}) =>
          new Promise((ok, fail) => {
            const id = ++seq
            pending.set(id, { ok, fail })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close()
      })
  })
}

async function main() {
  seed()
  console.log(`Seeded demo data in ${demoRoot}`)
  if (process.argv.includes('--seed-only')) return
  if (!existsSync(join(repo, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first.')
  mkdirSync(outDir, { recursive: true })

  const electron = require('electron') // the binary's path when required from Node
  const env = { ...process.env, OPENFORGE_USER_DATA: dataDir, OPENFORGE_MINECRAFT_DIR: fakeMinecraftDir }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: repo, env, stdio: 'ignore' })

  let cdp
  try {
    cdp = await connect(await waitForTarget())
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    }
    const waitFor = async (expression, what, timeout = 30_000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await evaluate(`Boolean(${expression})`).catch(() => false)) return
        await sleep(250)
      }
      throw new Error(`Timed out waiting for ${what}`)
    }
    // Click the first element matching `selector` whose text includes `text` (if given).
    const click = (selector, text = '') =>
      evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((e) => e.textContent.includes(${JSON.stringify(text)}))
        if (!el) throw new Error('No element for ' + ${JSON.stringify(selector + ' ' + text)})
        el.click()
        return true
      })()`)
    const key = (k, ctrl = false) =>
      evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${ctrl}, bubbles: true }))`)
    // Wait until every <img> on the page has finished loading (or failed).
    const imagesSettled = () =>
      waitFor(`[...document.images].every((img) => img.complete)`, 'images', 20_000).catch(() => undefined)
    const shot = async (name) => {
      await imagesSettled()
      await sleep(600)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(outDir, name), Buffer.from(data, 'base64'))
      console.log(`  wrote docs/screenshots/${name}`)
    }

    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
    await waitFor(`document.querySelector('.card-instance') && !document.querySelector('.boot-splash')`, 'the Library')

    // 1. Library
    await shot('library.png')

    // 2. Discover, CurseForge through the source picker
    await key('2', true)
    await waitFor(`document.querySelectorAll('.grid-cards > :not(.skeleton)').length >= 6`, 'Discover results', 45_000)
    const source = await evaluate(`document.querySelector('.source-picker-button')?.textContent ?? ''`)
    console.log(`  Discover source: ${source.replace('Source:', '').trim()}`)
    await click('.source-picker-button')
    await waitFor(`document.querySelector('.source-picker-menu')`, 'the source menu')
    await shot('discover.png')
    await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)

    // 3. Instance editor, Mods tab with + Add search open
    await key('1', true)
    await waitFor(`document.querySelector('.card-instance')`, 'the Library')
    await click('[aria-label="Edit Create: Above & Beyond"]')
    await waitFor(`document.querySelector('.editor')`, 'the editor')
    await click('.editor button[aria-expanded]', 'Add')
    await waitFor(`document.querySelectorAll('.editor .mod-info').length >= 5`, 'editor search results', 45_000)
    await shot('editor-mods.png')
    await key('Escape')
    await waitFor(`!document.querySelector('.editor')`, 'the editor to close')

    // 4. Setup tab, key bindings with conflicts
    await click('.card-instance', 'Create: Above & Beyond')
    await waitFor(`document.querySelector('.drawer')`, 'the drawer')
    await click('.drawer-tabs button', 'Setup')
    await waitFor(`document.querySelector('.keybind-row.conflict')`, 'key binding conflicts')
    await click('.drawer button', 'Show conflicts')
    await waitFor(`[...document.querySelectorAll('.keybind-row')].every((row) => row.classList.contains('conflict'))`, 'the conflict filter')
    await shot('setup-keybindings.png')
    await key('Escape')

    // 5. Servers, the fake local server running
    await key('3', true)
    await waitFor(`document.querySelector('.server-item')`, 'the server list')
    await click('.server-item', 'Cozy SMP')
    await click('.server-actions button', 'Start')
    await waitFor(`document.querySelector('.server-console')?.textContent.includes('Steve joined the game')`, 'server output', 30_000)
    await evaluate(`(() => {
      const input = document.querySelector('.server-input input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'list')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await click('.server-input button[type="submit"]')
    await waitFor(`document.querySelector('.server-console')?.textContent.includes('players online: Alex, Steve')`, 'list output')
    await shot('servers.png')
    await click('.server-actions button', 'Stop')
    await waitFor(`document.querySelector('.server-console')?.textContent.includes('Server exited')`, 'the server to stop', 30_000)

    // 6. Settings
    await key('4', true)
    await waitFor(`document.querySelector('.page') && document.querySelector('.page-title')?.textContent.includes('Settings')`, 'Settings')
    await shot('settings.png')
  } finally {
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      const browser = await connect(version.webSocketDebuggerUrl)
      await browser.send('Browser.close').catch(() => undefined)
      browser.close()
    } catch {
      /* already gone */
    }
    cdp?.close()
    await sleep(1500)
    if (app.exitCode === null && app.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
      else app.kill('SIGKILL')
    }
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
