/**
 * Verification suite for the launcher core.
 *
 * Bundled with esbuild and run under plain Node, so it exercises the real
 * modules the app ships - not reimplementations of them. Everything that can be
 * proven without the internet is proven against a local HTTP server that stands
 * in for the Modrinth CDN and a CurseForge proxy, which means the whole modpack
 * install path (resolve -> download -> verify -> overrides -> prune) is covered
 * even on a network that blocks the real services.
 *
 * Live connectivity is probed at the end and reported, never asserted.
 */
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'

import { offlineUuid, isValidUsername } from '../src/main/core/auth'
import { mavenToPath, nativeClassifier, isAllowed, currentOsName } from '../src/main/core/rules'
import { downloadFile } from '../src/main/core/http'
import { CfClient, forgeCdnUrl, forgeCdnMirrors } from '../src/main/core/curseforge'
import { installMrpackArchive, installCurseForgeArchive, parseLoaderId, readPackIndex } from '../src/main/core/packinstall'
import { enableResourcePacks, FOLDER } from '../src/main/core/content'
import { pickJava } from '../src/main/core/java'
import { provisionableMajor, SUPPORTED_MAJORS } from '../src/main/core/javaprovision'
import { dashUuid } from '../src/main/core/msauth'
import type { Reporter } from '../src/main/core/installer'
import { installVersion, isVersionReady, mergeVersions } from '../src/main/core/installer'
import type { GamePaths } from '../src/main/core/paths'
import type { VersionDetail } from '../src/main/core/manifest'
import { friendlyKeyName, readKeyBindings, resetKeyBindings } from '../src/main/core/options'
import {
  buildCleanupPlan,
  configOwner,
  installedModIds,
  isOrphanConfig,
  listConfigFiles,
  modIdFromJson,
  modIdsFromToml,
  planCleanup
} from '../src/main/core/cleanup'
import { stampIsFresh, stampKey } from '../src/main/core/stamp'
import { installerUrl, processorOutputs, resolveProfileValue } from '../src/main/core/forge'
import { stageFromLogLine } from '../src/main/core/launcher'
import { gcArgs, recommendedRamMb, tunedJvmArgs } from '../src/shared/tuning'
import { diagnoseCrash, explainError } from '../src/shared/errors'

let failures = 0
let checks = 0

function ok(cond: boolean, label: string, extra = ''): void {
  checks++
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '  — ' + extra : ''}`)
  if (!cond) failures++
}

function section(title: string): void {
  console.log(`\n▪ ${title}`)
}

const quiet: Reporter = () => undefined
const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')
const sha512 = (buf: Buffer): string => createHash('sha512').update(buf).digest('hex')

// -- Local stand-in for the CDNs and the CurseForge proxy ---------------------

interface Fixture {
  server: Server
  base: string
  files: Map<string, Buffer>
}

async function startFixtureServer(): Promise<Fixture> {
  const files = new Map<string, Buffer>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const body = files.get(url.pathname)
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}`, files }
}

function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `openforge-verify-${label}-`))
}

// -- Suites -------------------------------------------------------------------

function pureAlgorithms(): void {
  section('Offline identity')
  const u = offlineUuid('Player')
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u), 'UUID is well-formed', u)
  ok(u[14] === '3', 'version nibble is 3 (name-based MD5)', `got ${u[14]}`)
  ok(['8', '9', 'a', 'b'].includes(u[19]), 'IETF variant bits set', `got ${u[19]}`)
  ok(offlineUuid('Player') === u, 'deterministic per username')
  ok(offlineUuid('Steve') !== u, 'differs across usernames')
  ok(isValidUsername('Steve_99') && !isValidUsername('bad name!'), 'username validation')
  ok(
    dashUuid('069a79f444e94726a5befca90e38aaf5') === '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    'Minecraft profile id gains dashes'
  )

  section('Rules / maven')
  ok(
    mavenToPath('net.fabricmc:fabric-loader:0.15.0') ===
      'net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar',
    'maven coordinate -> path'
  )
  ok(
    mavenToPath('org.lwjgl:lwjgl:3.3.3:natives-windows') ===
      'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
    'classified coordinate -> path'
  )
  ok(isAllowed(undefined), 'no rules means allowed')
  ok(!isAllowed([{ action: 'disallow' }]), 'bare disallow blocks')
  ok(
    isAllowed([{ action: 'allow', os: { name: currentOsName() as never } }]),
    'os rule matches this platform',
    currentOsName()
  )
  ok(
    nativeClassifier({ name: 'org.lwjgl:lwjgl:3.3.3', natives: { windows: 'natives-windows' } }) ===
      (currentOsName() === 'windows' ? 'natives-windows' : null),
    'native classifier follows the platform'
  )

  section('Loader identifiers')
  ok(parseLoaderId('forge-47.2.0').type === 'forge', 'forge id')
  ok(parseLoaderId('neoforge-20.4.190').type === 'neoforge', 'neoforge id')
  ok(parseLoaderId('fabric-0.15.0').version === '0.15.0', 'fabric version extracted')
  ok(parseLoaderId('quilt-0.24.0').type === 'quilt', 'quilt is its own loader, not coerced to fabric')

  section('CurseForge CDN paths')
  ok(
    forgeCdnUrl(4567890, 'cool-mod.jar') === 'https://mediafilez.forgecdn.net/files/4567/890/cool-mod.jar',
    'file id splits into the CDN path'
  )
  ok(forgeCdnMirrors(4567890, 'cool-mod.jar').length === 2, 'two fallback mirrors are offered')

  section('Java selection')
  const runtimes = [
    { path: 'a', version: '1.8.0_392', majorVersion: 8 },
    { path: 'b', version: '17.0.9', majorVersion: 17 },
    { path: 'c', version: '21.0.2', majorVersion: 21 }
  ]
  ok(pickJava(runtimes, 17)?.majorVersion === 17, 'exact major wins')
  ok(pickJava(runtimes, 16)?.majorVersion === 17, 'falls up to the nearest newer runtime')
  ok(pickJava(runtimes, 25) === null, 'never falls back to an older runtime')
  ok(pickJava([], 17) === null, 'no runtimes means no choice')
  ok(provisionableMajor(16) === 17, 'a required 16 provisions Java 17')
  ok(provisionableMajor(21) === 21, 'an exact supported major is kept')
  ok(SUPPORTED_MAJORS.some((entry) => entry.major === 8), 'Java 8 is still offered for old packs')
}

async function downloadIntegrity(fixture: Fixture): Promise<void> {
  section('Download integrity')
  const dir = makeTempDir('dl')
  const payload = Buffer.from('a genuine mod jar would go here')
  fixture.files.set('/good.jar', payload)

  const good = join(dir, 'good.jar')
  await downloadFile({ url: `${fixture.base}/good.jar`, dest: good, sha512: sha512(payload) })
  ok(existsSync(good), 'a verified file lands at its destination')
  ok(readFileSync(good).equals(payload), 'contents match the source')

  const bad = join(dir, 'bad.jar')
  let threw = false
  try {
    await downloadFile({ url: `${fixture.base}/good.jar`, dest: bad, sha512: sha512(Buffer.from('other')) }, 1)
  } catch {
    threw = true
  }
  ok(threw, 'a hash mismatch fails the download')
  ok(!existsSync(bad), 'a failed download leaves no file behind')
  ok(!existsSync(`${bad}.part`), 'the partial file is cleaned up too')

  const missing = join(dir, 'missing.jar')
  threw = false
  try {
    await downloadFile({ url: `${fixture.base}/nope.jar`, dest: missing }, 1)
  } catch {
    threw = true
  }
  ok(threw, 'a 404 fails rather than writing the error body to disk')
  ok(!existsSync(missing), '404 leaves no file')

  // A mirror list should rescue a dead primary url.
  const mirrored = join(dir, 'mirrored.jar')
  await downloadFile({
    url: `${fixture.base}/dead.jar`,
    mirrors: [`${fixture.base}/good.jar`],
    dest: mirrored,
    sha1: sha1(payload)
  })
  ok(existsSync(mirrored), 'a dead primary url falls through to a mirror')

  await rm(dir, { recursive: true, force: true })
}

function buildMrpack(fixture: Fixture, opts: { modName: string; includeSecond: boolean }): string {
  const zip = new AdmZip()
  const files = [
    {
      path: `mods/${opts.modName}`,
      hashes: { sha512: sha512(fixture.files.get('/cdn/mod-a.jar')!) },
      env: { client: 'required', server: 'required' },
      downloads: [`${fixture.base}/cdn/mod-a.jar`],
      fileSize: fixture.files.get('/cdn/mod-a.jar')!.length
    },
    // A server-only mod must be skipped on a client install.
    {
      path: 'mods/server-only.jar',
      hashes: { sha512: sha512(fixture.files.get('/cdn/mod-b.jar')!) },
      env: { client: 'unsupported', server: 'required' },
      downloads: [`${fixture.base}/cdn/mod-b.jar`],
      fileSize: fixture.files.get('/cdn/mod-b.jar')!.length
    }
  ]
  if (opts.includeSecond) {
    files.push({
      path: 'mods/extra.jar',
      hashes: { sha512: sha512(fixture.files.get('/cdn/mod-b.jar')!) },
      env: { client: 'required', server: 'required' },
      downloads: [`${fixture.base}/cdn/mod-b.jar`],
      fileSize: fixture.files.get('/cdn/mod-b.jar')!.length
    })
  }

  zip.addFile(
    'modrinth.index.json',
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        versionId: opts.includeSecond ? '1.0.0' : '1.1.0',
        name: 'Test Homestead',
        files,
        dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.7' }
      })
    )
  )
  zip.addFile('overrides/config/pack.toml', Buffer.from('setting = true'))
  zip.addFile('overrides/resourcepacks/looks.zip', Buffer.from('a texture pack'))
  // A hostile entry that tries to climb out of the instance folder.
  zip.addFile('overrides/../../escaped.txt', Buffer.from('should never be written'))

  const path = join(makeTempDir('mrpack'), 'pack.mrpack')
  zip.writeZip(path)
  return path
}

async function modrinthPackInstall(fixture: Fixture): Promise<void> {
  section('Modrinth .mrpack install')
  fixture.files.set('/cdn/mod-a.jar', Buffer.from('mod A payload'))
  fixture.files.set('/cdn/mod-b.jar', Buffer.from('mod B payload'))

  const instanceDir = makeTempDir('instance')
  const first = buildMrpack(fixture, { modName: 'alpha.jar', includeSecond: true })

  const result = await installMrpackArchive({
    archivePath: first,
    instanceDir,
    report: quiet,
    concurrency: 4,
    provider: 'modrinth',
    projectId: 'homestead',
    versionId: 'v1',
    cleanupArchive: false
  })

  ok(result.mcVersion === '1.20.1', 'Minecraft version read from dependencies', result.mcVersion)
  ok(result.loader === 'fabric', 'fabric-loader maps to the fabric loader')
  ok(result.loaderVersion === '0.15.7', 'loader version carried through')
  ok(result.failed === 0, 'every client file downloaded')
  ok(existsSync(join(instanceDir, 'mods', 'alpha.jar')), 'mod jar installed')
  ok(existsSync(join(instanceDir, 'mods', 'extra.jar')), 'second mod jar installed')
  ok(!existsSync(join(instanceDir, 'mods', 'server-only.jar')), 'client-unsupported mod is skipped')
  ok(existsSync(join(instanceDir, 'config', 'pack.toml')), 'overrides applied')
  ok(
    existsSync(join(instanceDir, 'resourcepacks', 'looks.zip')),
    'texture packs shipped in overrides land in resourcepacks/'
  )
  ok(!existsSync(join(instanceDir, '..', 'escaped.txt')), 'zip-slip entry refused')

  const index = await readPackIndex(instanceDir)
  ok(index !== null, 'pack index written')
  ok((index?.files.length ?? 0) >= 4, 'index records every file the pack wrote', String(index?.files.length))

  // -- Update: the player's world must survive, the dropped mod must not ----
  section('Modpack update')
  const savesDir = join(instanceDir, 'saves', 'My Base')
  mkdirSync(savesDir, { recursive: true })
  writeFileSync(join(savesDir, 'level.dat'), 'precious')
  writeFileSync(join(instanceDir, 'mods', 'hand-added.jar'), 'added by the player')

  const second = buildMrpack(fixture, { modName: 'alpha.jar', includeSecond: false })
  await installMrpackArchive({
    archivePath: second,
    instanceDir,
    report: quiet,
    concurrency: 4,
    provider: 'modrinth',
    projectId: 'homestead',
    versionId: 'v2',
    cleanupArchive: false
  })

  ok(existsSync(join(savesDir, 'level.dat')), 'the world survives a pack update')
  ok(
    readFileSync(join(savesDir, 'level.dat'), 'utf8') === 'precious',
    'the world is untouched, not just present'
  )
  ok(!existsSync(join(instanceDir, 'mods', 'extra.jar')), 'a mod dropped by the new release is removed')
  ok(existsSync(join(instanceDir, 'mods', 'alpha.jar')), 'a mod kept by the new release stays')
  ok(
    existsSync(join(instanceDir, 'mods', 'hand-added.jar')),
    'a mod the player added by hand is never pruned'
  )

  await rm(instanceDir, { recursive: true, force: true })
}

async function curseForgePackInstall(fixture: Fixture): Promise<void> {
  section('CurseForge pack install (via proxy transport)')
  const modJar = Buffer.from('curseforge mod payload')
  fixture.files.set('/cdn/cf-mod.jar', modJar)

  // Stand in for a servercraft-style proxy: only the two routes CfClient uses.
  const proxy = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/cf/packs/777/files') {
      res.end(
        JSON.stringify({
          files: [
            {
              id: 9001,
              modId: 777,
              displayName: 'Cool Mod 1.0',
              fileName: 'cool-mod.jar',
              fileDate: '2026-01-01T00:00:00Z',
              fileLength: modJar.length,
              releaseType: 1,
              downloadUrl: `${fixture.base}/cdn/cf-mod.jar`,
              gameVersions: ['1.20.1', 'Forge'],
              dependencies: []
            }
          ]
        })
      )
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  const cf = new CfClient(proxyBase, '')

  ok(cf.available, 'proxy transport reports available')
  ok(cf.mode === 'proxy', 'proxy mode selected over an empty key')
  ok(!cf.supportsBulk, 'bulk resolution is correctly reported as unavailable on a proxy')

  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
        name: 'Test All the Mods',
        version: '1.2.3',
        files: [
          { projectID: 777, fileID: 9001, required: true },
          // A mod the manifest marks optional must not block the install.
          { projectID: 778, fileID: 9002, required: false }
        ],
        overrides: 'overrides'
      })
    )
  )
  zip.addFile('overrides/config/atm.cfg', Buffer.from('tweaks'))
  const archivePath = join(makeTempDir('cfpack'), 'pack.zip')
  zip.writeZip(archivePath)

  const instanceDir = makeTempDir('cfinstance')
  const result = await installCurseForgeArchive({
    cf,
    archivePath,
    instanceDir,
    report: quiet,
    concurrency: 4,
    projectId: '777',
    versionId: '9001',
    cleanupArchive: false
  })

  ok(result.mcVersion === '1.20.1', 'Minecraft version read from the manifest')
  ok(result.loader === 'forge', 'forge loader parsed from modLoaders')
  ok(result.loaderVersion === '47.2.0', 'loader version parsed')
  ok(result.packVersion === '1.2.3', 'pack version carried through')
  ok(existsSync(join(instanceDir, 'mods', 'cool-mod.jar')), 'mod resolved through the proxy and downloaded')
  ok(existsSync(join(instanceDir, 'config', 'atm.cfg')), 'overrides applied')
  ok(result.totalFiles === 1, 'optional files are excluded from the required set', String(result.totalFiles))

  proxy.close()
  await rm(instanceDir, { recursive: true, force: true })
}

async function resourcePackWiring(): Promise<void> {
  section('Texture pack activation')
  const instanceDir = makeTempDir('rp')
  ok(FOLDER.resourcepack === 'resourcepacks', 'texture packs target resourcepacks/')
  ok(FOLDER.shader === 'shaderpacks', 'shaders target shaderpacks/')

  await enableResourcePacks(instanceDir, ['looks.zip'])
  let options = readFileSync(join(instanceDir, 'options.txt'), 'utf8')
  ok(options.includes('resourcePacks:'), 'options.txt gains a resourcePacks line')
  ok(options.includes('"vanilla"'), 'vanilla stays in the list')
  ok(options.includes('"file/looks.zip"'), 'the new pack is enabled')

  // A second call must merge, not clobber, and must not duplicate.
  writeFileSync(
    join(instanceDir, 'options.txt'),
    'fov:0.5\nresourcePacks:["vanilla","file/looks.zip"]\nlang:en_us\n'
  )
  await enableResourcePacks(instanceDir, ['looks.zip', 'second.zip'])
  options = readFileSync(join(instanceDir, 'options.txt'), 'utf8')
  ok(options.includes('fov:0.5') && options.includes('lang:en_us'), 'other settings are preserved')
  ok(options.split('file/looks.zip').length === 2, 'an already-enabled pack is not duplicated')
  ok(options.includes('file/second.zip'), 'the newly added pack is appended')

  await rm(instanceDir, { recursive: true, force: true })
}

async function liveConnectivity(): Promise<void> {
  section('Live service reachability (informational)')
  const targets: [string, string][] = [
    ['Mojang manifest', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'],
    ['Modrinth API', 'https://api.modrinth.com/v2/tag/loader'],
    ['Fabric meta', 'https://meta.fabricmc.net/v2/versions/game'],
    ['Adoptium', 'https://api.adoptium.net/v3/info/available_releases'],
    ['CurseForge CDN', 'https://mediafilez.forgecdn.net/']
  ]
  for (const [name, url] of targets) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Openforge/2.0.0 verify' },
        signal: AbortSignal.timeout(12_000)
      })
      console.log(`  · ${name}: HTTP ${res.status}`)
    } catch (err) {
      const cause = (err as { cause?: Error }).cause?.message ?? (err as Error).message
      console.log(`  · ${name}: unreachable — ${cause}`)
    }
  }
  console.log('    (network reachability is reported, not asserted)')
}

// -- Key bindings, configs, cleanup, install stamps -----------------------------

const OPTIONS_SAMPLE = [
  'version:3955',
  'fov:0.25',
  'key_key.attack:key.mouse.left',
  'key_key.jump:key.keyboard.space',
  'key_key.sneak:key.keyboard.left.shift',
  'key_key.drop:key.keyboard.r',
  'key_key.jei.showRecipe:key.keyboard.r',
  'key_key.jei.showUses:key.keyboard.r:SHIFT',
  'key_key.sodium.menu:key.keyboard.unknown',
  'key_key.smoothCamera:key.keyboard.unknown',
  'key_key.hotbar.1:key.keyboard.1',
  'soundCategory_master:1.0'
].join('\r\n')

function keyBindingSuite(): void {
  section('Key bindings (options.txt)')
  const report = readKeyBindings(OPTIONS_SAMPLE)
  ok(report.exists && !report.legacy, 'a modern options.txt is recognised')
  ok(report.bindings.length === 9, 'every key_ line becomes a binding', String(report.bindings.length))
  const jump = report.bindings.find((b) => b.id === 'key.jump')
  ok(jump?.label === 'Jump' && jump.keyLabel === 'Space' && jump.isDefault, 'vanilla binding labelled, default detected')
  const drop = report.bindings.find((b) => b.id === 'key.drop')
  ok(drop?.isDefault === false && drop.defaultLabel === 'Q', 'a changed vanilla binding shows its default')
  const uses = report.bindings.find((b) => b.id === 'key.jei.showUses')
  ok(uses?.modifier === 'SHIFT' && uses.keyLabel === 'Shift + R', 'Forge key modifiers are parsed')
  ok(uses?.category === 'jei' && uses.label === 'Show Uses', 'modded binding grouped by namespace')
  ok(friendlyKeyName('key.keyboard.left.control') === 'Left Ctrl', 'left.control reads as Left Ctrl')
  ok(friendlyKeyName('key.keyboard.keypad.7') === 'Numpad 7', 'keypad keys are named')
  ok(friendlyKeyName('key.mouse.4') === 'Mouse 4', 'extra mouse buttons are named')
  ok(friendlyKeyName('57') === 'Space', 'legacy LWJGL codes are named')

  section('Key binding conflicts')
  ok(report.conflicts.length === 1, 'one conflicting key found', JSON.stringify(report.conflicts))
  ok(
    report.conflicts[0]?.ids.sort().join(',') === 'key.drop,key.jei.showRecipe',
    'R is shared by Drop and Show Recipe'
  )
  ok(!report.conflicts.some((c) => c.ids.includes('key.jei.showUses')), 'Shift+R does not clash with plain R')
  ok(!report.conflicts.some((c) => c.ids.includes('key.sodium.menu')), 'unbound keys never conflict')
  ok(report.bindings.find((b) => b.id === 'key.drop')?.conflict === true, 'conflicting rows are flagged')

  section('Key binding reset')
  const one = resetKeyBindings(OPTIONS_SAMPLE, ['key.drop'])
  ok(one.includes('key_key.drop:key.keyboard.q'), 'a vanilla binding is written back to its default')
  ok(one.includes('key_key.jei.showRecipe:key.keyboard.r'), 'other bindings are untouched')
  ok(one.includes('fov:0.25') && one.includes('soundCategory_master:1.0'), 'non-key settings are preserved')
  ok(one.includes('\r\n') && !/[^\r]\n/.test(one), 'CRLF line endings are kept')
  const all = resetKeyBindings(OPTIONS_SAMPLE, null)
  ok(!all.includes('key.jei.showRecipe'), 'reset all removes modded bindings (the game restores their defaults)')
  ok(all.includes('key_key.drop:key.keyboard.q') && all.includes('key_key.jump:key.keyboard.space'), 'reset all restores vanilla defaults')
  ok(readKeyBindings(all).conflicts.length === 0, 'no conflicts remain after reset all')
  const legacy = readKeyBindings('key_key.jump:57\nkey_key.drop:16\n')
  ok(legacy.legacy && legacy.bindings[0].keyLabel === 'Space', 'pre-1.13 numeric bindings are read')
  ok(!resetKeyBindings('key_key.jump:57\nkey_key.drop:19\n', ['key.drop']).includes('key.drop'), 'legacy reset removes the line')
  ok(!readKeyBindings(null).exists, 'a missing options.txt reports exists=false')
}

function cleanupPlanningSuite(): void {
  section('Mod config ownership')
  ok(modIdsFromToml('[[mods]]\nmodId="jei"\n[[mods]]\n  modId = \'jei_addon\'').join(',') === 'jei,jei_addon', 'mods.toml ids read')
  ok(modIdFromJson('{"id":"sodium"}') === 'sodium', 'fabric.mod.json id read')
  ok(modIdFromJson('{"quilt_loader":{"id":"qsl"}}') === 'qsl', 'quilt.mod.json id read')
  ok(configOwner('config/jei/jei-client.ini') === 'jei', 'a config folder names its owner')
  ok(configOwner('config/sodium-options.json') === 'sodium', 'file stem with -options suffix')
  ok(configOwner('config/create-common.toml') === 'create', 'file stem with -common suffix')
  const installed = ['jei', 'sodium', 'create', 'cloth-config-fabric-11.1.106']
  ok(!isOrphanConfig('config/jei/jei-client.ini', installed), 'config of an installed mod is kept')
  ok(!isOrphanConfig('config/cloth-config.json', installed), 'jar-in-jar bundled libraries count as installed')
  ok(!isOrphanConfig('config/forge-client.toml', installed), 'loader configs are never orphans')
  ok(isOrphanConfig('config/journeymap/journeymap.core.config', installed), 'config of a removed mod is flagged')
  ok(!isOrphanConfig('config/ab.json', installed), 'names under three letters are never flagged')

  section('Cleanup plan')
  const plan = buildCleanupPlan(
    [
      { relPath: 'logs', bytes: 5000, files: 3 },
      { relPath: 'crash-reports', bytes: 0, files: 0 },
      { relPath: '.cache', bytes: 1200, files: 2 }
    ],
    [{ relPath: 'config/journeymap', bytes: 800, files: 4 }]
  )
  ok(plan.items.length === 3, 'empty folders are left out of the plan', plan.items.map((i) => i.relPath).join(','))
  ok(plan.totalBytes === 7000, 'plan totals the sizes', String(plan.totalBytes))
  ok(plan.items.find((i) => i.relPath === 'logs')?.recommended === true, 'logs are pre-selected')
  const orphan = plan.items.find((i) => i.category === 'orphan-config')
  ok(orphan?.recommended === false, 'heuristic orphan configs are never pre-selected')
  ok(!plan.items.some((i) => /saves|screenshots|mods/.test(i.relPath)), 'worlds, screenshots and mods are never planned')
}

async function cleanupScanSuite(): Promise<void> {
  section('Cleanup scan on a real folder')
  const dir = makeTempDir('cleanup')
  const mkfile = (rel: string, body = 'x'): void => {
    const path = join(dir, ...rel.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  const jar = new AdmZip()
  jar.addFile('META-INF/mods.toml', Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="create"\n'))
  mkdirSync(join(dir, 'mods'), { recursive: true })
  jar.writeZip(join(dir, 'mods', 'create-1.20.1-0.5.1.jar'))
  mkfile('config/create-client.toml')
  mkfile('config/journeymap/journeymap.core.config', 'abcdef')
  mkfile('logs/latest.log', '0123456789')
  mkfile('saves/World/level.dat')
  const plan = await planCleanup(dir, true)
  const paths = plan.items.map((i) => i.relPath)
  ok(paths.includes('logs'), 'logs folder is planned', paths.join(','))
  ok(paths.includes('config/journeymap'), 'orphaned mod config folder is planned as one item')
  ok(!paths.some((p) => p.startsWith('config/create')), 'config of the installed mod is kept')
  ok(!paths.some((p) => p.startsWith('saves')), 'worlds are never planned')
  ok(plan.items.find((i) => i.relPath === 'logs')?.bytes === 10, 'sizes are measured')
  const ids = await installedModIds(dir)
  ok(ids.includes('create') && existsSync(join(dir, '.openforge', 'modids.json')), 'mod ids read from the jar and cached')
  const configs = await listConfigFiles(dir, ids)
  ok(configs.length === 2 && configs.some((c) => c.orphan) && configs.some((c) => !c.orphan), 'config listing marks orphans')
  await rm(dir, { recursive: true, force: true })
}

function stampSuite(): void {
  section('Install stamps')
  const disk = new Map<string, { size: number; mtimeMs: number }>([
    ['a.jar', { size: 10, mtimeMs: 1000.4 }],
    ['b.jar', { size: 20, mtimeMs: 2000 }]
  ])
  const stat = (path: string): { size: number; mtimeMs: number } | null => disk.get(path) ?? null
  const key = stampKey(['ready', 'x'])
  ok(key === stampKey(['ready', 'x']) && key !== stampKey(['ready', 'y']), 'stamp keys are stable and input-sensitive')
  ok(stampKey([undefined]) !== stampKey(['']), 'undefined and empty string produce different keys')
  const stamp = {
    schema: 1 as const,
    key,
    createdAt: '',
    files: [
      { path: 'a.jar', size: 10, mtimeMs: 1000.9 },
      { path: 'b.jar', size: 20, mtimeMs: 2000 }
    ]
  }
  ok(stampIsFresh(stamp, key, stat).fresh, 'an unchanged disk keeps the stamp fresh')
  ok(!stampIsFresh(stamp, stampKey(['other']), stat).fresh, 'a changed definition invalidates the stamp')
  ok(!stampIsFresh(null, key, stat).fresh, 'no stamp means not fresh')
  disk.set('b.jar', { size: 21, mtimeMs: 2000 })
  ok(stampIsFresh(stamp, key, stat).reason?.startsWith('size changed') === true, 'a resized file is caught')
  disk.delete('a.jar')
  ok(stampIsFresh(stamp, key, stat).reason?.startsWith('missing') === true, 'a deleted file is caught')
}

async function stampedInstallSuite(fixture: Fixture): Promise<void> {
  section('Stamped install and warm-launch check')
  const root = makeTempDir('install')
  const paths = new FakeGamePaths(root) as unknown as GamePaths
  const client = Buffer.from('client jar bytes')
  const lib = Buffer.from('library jar bytes')
  const objA = Buffer.from('asset a')
  const index = Buffer.from(
    JSON.stringify({ objects: { 'a.txt': { hash: sha1(objA), size: objA.length }, 'b.txt': { hash: sha1(objA), size: objA.length } } })
  )
  fixture.files.set('/client.jar', client)
  fixture.files.set('/lib.jar', lib)
  fixture.files.set('/index.json', index)
  const version = {
    id: 'test-1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'test',
    assetIndex: { id: 'test', sha1: sha1(index), size: index.length, totalSize: 0, url: `${fixture.base}/index.json` },
    downloads: { client: { sha1: sha1(client), size: client.length, url: `${fixture.base}/client.jar` } },
    libraries: [
      {
        name: 'com.example:lib:1.0',
        downloads: { artifact: { path: 'com/example/lib/1.0/lib-1.0.jar', sha1: sha1(lib), size: lib.length, url: `${fixture.base}/lib.jar` } }
      }
    ],
    arguments: { game: [], jvm: [] }
  }
  mkdirSync(join(root, 'versions', 'test-1'), { recursive: true })
  writeFileSync(join(root, 'versions', 'test-1', 'test-1.json'), JSON.stringify(version))
  // The asset objects are served from the Mojang CDN path; the fixture stands in.
  const assetUrl = `/${sha1(objA).slice(0, 2)}/${sha1(objA)}`
  fixture.files.set(assetUrl, objA)
  let installed: VersionDetail | null = null
  try {
    installed = await installVersion(paths, 'test-1', quiet, 4, 'quick', { resourcesBase: fixture.base })
  } catch (err) {
    ok(false, 'fixture install completes', (err as Error).message)
  }
  if (installed) {
    ok(existsSync(join(root, 'libraries', 'com/example/lib/1.0/lib-1.0.jar')), 'library downloaded')
    ok(existsSync(join(root, 'assets', 'objects', sha1(objA).slice(0, 2), sha1(objA))), 'shared asset object downloaded once')
    ok((await isVersionReady(paths, installed)).fresh, 'a finished install is ready without any re-check')
    writeFileSync(join(root, 'libraries', 'com/example/lib/1.0/lib-1.0.jar'), 'tampered, and longer than before')
    const after = await isVersionReady(paths, installed)
    ok(!after.fresh, 'a modified library makes the warm check fall back to repair', after.reason)
    await installVersion(paths, 'test-1', quiet, 4, 'full', { resourcesBase: fixture.base })
    ok(
      readFileSync(join(root, 'libraries', 'com/example/lib/1.0/lib-1.0.jar')).equals(lib) &&
        (await isVersionReady(paths, installed)).fresh,
      'a full repair restores the file and the stamp'
    )
  }
  await rm(root, { recursive: true, force: true })
}

function loaderProfileSuite(): void {
  section('Forge/NeoForge install profile')
  const ctx = { libraries: '/g/libraries', minecraftJar: '/g/versions/1.21.1/1.21.1.jar', root: '/g' }
  const profile = {
    data: {
      PATCHED: { client: '[net.neoforged:neoforge:21.1.1:client]', server: '[x:y:1]' },
      PATCHED_SHA: { client: "'0123456789abcdef0123456789abcdef01234567'" },
      MC_OFF: { client: '[net.minecraft:client:1.21.1:official]' }
    },
    processors: [
      { jar: 'a', outputs: { '{PATCHED}': '{PATCHED_SHA}' } },
      { jar: 'b', sides: ['server'], outputs: { '{MC_SERVER}': "'ffff'" } },
      { jar: 'c', sides: ['client'], outputs: { '{MC_OFF}': "'not-a-sha'" } }
    ]
  }
  const outputs = processorOutputs(profile, ctx)
  const norm = (p: string): string => p.replace(/\\/g, '/')
  ok(outputs.length === 2, 'server-only processors are skipped', outputs.map((o) => norm(o.path)).join(','))
  ok(
    norm(outputs[0].path) === '/g/libraries/net/neoforged/neoforge/21.1.1/neoforge-21.1.1-client.jar',
    'data references resolve to library paths'
  )
  ok(outputs[0].sha1 === '0123456789abcdef0123456789abcdef01234567', 'declared output hashes are carried')
  ok(outputs[1].sha1 === undefined, 'values that are not sha1 hashes are ignored')
  ok(resolveProfileValue('{MINECRAFT_JAR}', profile.data, ctx) === ctx.minecraftJar, 'built-in MINECRAFT_JAR resolves')
  ok(
    installerUrl('neoforge', '1.21.1', '21.1.1').endsWith('/neoforge/21.1.1/neoforge-21.1.1-installer.jar'),
    'NeoForge installer url'
  )
  ok(
    installerUrl('forge', '1.20.1', '47.2.0').endsWith('/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar'),
    'Forge installer url'
  )

  section('Version merging')
  const legacyChild = { id: 'forge-1.12.2', inheritsFrom: '1.12.2', type: 'release', mainClass: 'net.minecraft.launchwrapper.Launch', libraries: [], minecraftArguments: '--tweakClass x' }
  const legacyParent = { id: '1.12.2', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], minecraftArguments: '--username ${auth_player_name}' }
  const merged = mergeVersions(legacyChild, legacyParent)
  ok(merged.arguments === undefined, 'a legacy loader profile stays legacy (keeps its classpath and natives)')
  ok(merged.minecraftArguments === '--tweakClass x', 'the loader supplies the legacy argument string')
  const modern = mergeVersions(
    { ...legacyChild, minecraftArguments: undefined, arguments: { game: ['--fml'], jvm: ['-DignoreList=x'] } },
    { ...legacyParent, minecraftArguments: undefined, arguments: { game: ['--username'], jvm: ['-cp'] } }
  )
  ok(modern.arguments?.game.join(' ') === '--username --fml', 'modern arguments are concatenated parent first')
}

function tuningSuite(): void {
  section('JVM defaults')
  ok(recommendedRamMb({ totalMemoryMb: 16384, maxRamMb: 12288, loader: 'vanilla' }) === 3072, 'vanilla on 16 GB gets 3 GB')
  ok(recommendedRamMb({ totalMemoryMb: 16384, maxRamMb: 12288, loader: 'neoforge', modCount: 40 }) === 4096, 'a small modpack gets 4 GB')
  ok(recommendedRamMb({ totalMemoryMb: 32768, maxRamMb: 24576, loader: 'forge', modCount: 250 }) === 8192, 'a large modpack gets 8 GB')
  ok(recommendedRamMb({ totalMemoryMb: 8192, maxRamMb: 6144, loader: 'neoforge', modCount: 300 }) === 4096, 'never more than half of system RAM')
  const tuned = tunedJvmArgs({ javaMajor: 21, ramMb: 6144, loader: 'neoforge', userArgs: '' })
  ok(tuned[0] === '-Xmx6144M' && tuned[1] === '-Xms3072M', 'modded launches commit half the heap up front')
  ok(tuned.includes('-XX:+UseG1GC') && tuned.includes('-XX:G1HeapRegionSize=8M'), 'G1 tuned for Java 17+')
  ok(gcArgs(8).includes('-XX:G1HeapRegionSize=32M') && !gcArgs(8).includes('-XX:+PerfDisableSharedMem'), 'Java 8 gets Mojang-style G1 flags')
  ok(!tunedJvmArgs({ javaMajor: 21, ramMb: 4096, loader: 'fabric', userArgs: '-XX:+UseZGC' }).some((a) => a.includes('G1')), 'a user-chosen GC is respected')
  ok(tunedJvmArgs({ javaMajor: 21, ramMb: 4096, loader: 'vanilla', userArgs: '' })[1] === '-Xms1024M', 'vanilla keeps a small initial heap')

  section('Launch stages and error help')
  ok(stageFromLogLine('[main/INFO]: Loading 212 mods:') === 'loading', 'Fabric mod loading detected')
  ok(stageFromLogLine('[Render thread/INFO] [com.mojang.blaze3d.audio.Library/]: OpenAL initialized on device x') === 'ready', 'OpenAL init means in game')
  ok(stageFromLogLine('[Render thread/INFO]: Sound engine started') === 'ready', 'sound engine start means in game')
  ok(stageFromLogLine('random line') === null, 'ordinary lines are ignored')
  ok(diagnoseCrash(['java.lang.OutOfMemoryError: Java heap space'])?.action === 'memory', 'out of memory suggests more memory')
  ok(
    diagnoseCrash(['class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader'])?.action === 'java',
    'old Forge on new Java suggests Java settings'
  )
  ok(diagnoseCrash(['Missing or unsupported mandatory dependencies:'])?.action === 'console', 'missing dependency points at the console')
  ok(diagnoseCrash(['all good']) === null, 'no diagnosis without a known cause')
  ok(explainError('This version of Minecraft needs Java 21 or newer.')?.action === 'java', 'missing Java offers Java settings')
  ok(explainError('Add an account before playing.')?.action === 'accounts', 'no account offers the account menu')
}

/** GamePaths without Electron: the same layout, rooted anywhere. */
class FakeGamePaths {
  constructor(public readonly root: string) {}
  get versions(): string { return join(this.root, 'versions') }
  versionDir(id: string): string { return join(this.versions, id) }
  versionJar(id: string): string { return join(this.versionDir(id), `${id}.jar`) }
  versionJson(id: string): string { return join(this.versionDir(id), `${id}.json`) }
  get libraries(): string { return join(this.root, 'libraries') }
  library(path: string): string { return join(this.libraries, path) }
  get assets(): string { return join(this.root, 'assets') }
  assetIndex(id: string): string { return join(this.assets, 'indexes', `${id}.json`) }
  assetObject(hash: string): string { return join(this.assets, 'objects', hash.substring(0, 2), hash) }
  get assetsVirtual(): string { return join(this.assets, 'virtual') }
  nativesDir(versionId: string): string { return join(this.root, 'natives', versionId) }
  get instances(): string { return join(this.root, 'instances') }
  instanceDir(instanceId: string): string { return join(this.instances, instanceId) }
}

async function main(): Promise<void> {
  console.log('Openforge core verification')
  const fixture = await startFixtureServer()
  try {
    pureAlgorithms()
    await downloadIntegrity(fixture)
    await modrinthPackInstall(fixture)
    await curseForgePackInstall(fixture)
    await resourcePackWiring()
    keyBindingSuite()
    cleanupPlanningSuite()
    await cleanupScanSuite()
    stampSuite()
    await stampedInstallSuite(fixture)
    loaderProfileSuite()
    tuningSuite()
    await liveConnectivity()
  } finally {
    fixture.server.close()
  }

  console.log(
    `\n${failures === 0 ? '✓ all green' : '✗ failures'}: ${checks - failures}/${checks} checks passed`
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nverification crashed:', err)
  process.exit(1)
})
