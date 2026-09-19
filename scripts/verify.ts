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

async function main(): Promise<void> {
  console.log('Openforge core verification')
  const fixture = await startFixtureServer()
  try {
    pureAlgorithms()
    await downloadIntegrity(fixture)
    await modrinthPackInstall(fixture)
    await curseForgePackInstall(fixture)
    await resourcePackWiring()
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
