/**
 * Exercise the shipped TypeScript planner, SSH transport, and Python agent
 * against an isolated fake SSH host and fixture CDN. No remote account needed.
 */
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AGENT_COMMAND, agentInput, deployRemoteServer, importRemoteServer, inspectRemoteHost } from '../servers'
import { curseManifest, mrpackPlan, safePackPath, serverPackOverrides, validateDeployInput } from '../servers/plan'
import { CfClient } from '../src/main/core/curseforge'
import { setTransport } from '../src/main/core/http'
import { runSsh } from '../src/main/core/servers/sshrun'
import { buildSshArgs } from '../src/shared/ssh'
import type { DeployRemoteServerInput } from '../src/shared/ipc'

const root = mkdtempSync(join(tmpdir(), 'openforge-servers-verify-'))
const bin = join(root, 'bin')
mkdirSync(bin)
const originalPath = process.env.PATH
let assertions = 0
function check(label: string, run: () => void): void { run(); assertions++; console.log('  ✓ ' + label) }
const hash = (data: Buffer, algorithm = 'sha1'): string => createHash(algorithm).update(data).digest('hex')
const fixtures = new Map<string, Buffer>()
const addJson = (url: string, value: unknown): void => { fixtures.set(url, Buffer.from(JSON.stringify(value))) }
const target = { host: 'server.noahroe.site', port: 22, user: 'minecraft', identityFile: '' }
const baseInput: DeployRemoteServerInput = { requestId: 'test-request', target, name: 'Test server', slug: 'vanilla', source: 'vanilla', mcVersion: '1.20.1', ramMb: 2048, gamePort: 25565, acceptEula: true }

// The shim runs the real SSH payload through Python with an isolated Path.home()
// and HTTPS fixtures. It never reads or changes the actual user's home folder.
writeFileSync(join(root, 'ssh-host.py'), String.raw`
import base64, io, json, pathlib, subprocess, sys, urllib.request
test_root = pathlib.Path(sys.argv[1])
pathlib.Path.home = classmethod(lambda cls: test_root)
fixtures = json.loads((test_root / "fixtures.json").read_text())
class Fixture(io.BytesIO):
    def __init__(self, url):
        super().__init__(base64.b64decode(fixtures[url]))
        self.url = url
urllib.request.urlopen = lambda request, timeout=60: Fixture(request.full_url)
length = int(sys.stdin.buffer.readline())
source = sys.stdin.buffer.read(length)
namespace = {"__name__": "openforge_fixture"}
exec(compile(source, "<openforge>", "exec"), namespace)
try:
    namespace["main"]()
except Exception as error:
    namespace["emit"]("error", message=str(error))
    sys.exit(1)
`)
writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexec python3 ' + JSON.stringify(join(root, 'ssh-host.py')) + ' ' + JSON.stringify(root) + '\n', { mode: 0o755 })
writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const fakeJava = String.raw`#!/usr/bin/env python3
import os, pathlib, sys
if "-version" in sys.argv:
    print('openjdk version "21.0.0"', file=sys.stderr)
    sys.exit(0)
root = pathlib.Path.cwd()
if "--installServer" in sys.argv:
    # Produce real installer filenames for modern Forge / NeoForge.
    if "neoforge" in pathlib.Path(sys.argv[sys.argv.index("-jar") + 1]).read_text():
        path = root / "libraries/net/neoforged/neoforge/21.1.1/unix_args.txt"
    else:
        path = root / "libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("fake-main-class")
elif "install" in sys.argv and "server" in sys.argv:
    # Quilt uses the loader version as a positional argument.
    assert sys.argv[sys.argv.index("server") + 2] == "0.27.0"
    assert "--install-dir=." in sys.argv
    (root / "quilt-server-launch.jar").write_text("fake-quilt-launcher")
elif "server" in sys.argv:
    (root / "fabric-server-launch.jar").write_text("fake-fabric-launcher")
print("fixture Java invocation:", sys.argv)
`
writeFileSync(join(bin, 'java'), fakeJava, { mode: 0o755 })
process.env.PATH = bin + ':' + originalPath
function syncFixtures(): void {
  writeFileSync(join(root, 'fixtures.json'), JSON.stringify(Object.fromEntries([...fixtures].map(([url, value]) => [url, value.toString('base64')]))))
}
setTransport(async (url) => {
  const data = fixtures.get(url)
  return data ? new Response(new Uint8Array(data), { status: 200 }) : new Response('No fixture: ' + url, { status: 404 })
})

const serverJar = Buffer.from('fixture vanilla server')
fixtures.set('https://fixture.invalid/server.jar', serverJar)
addJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
  latest: { release: '1.20.1', snapshot: '1.20.1' },
  versions: [{ id: '1.20.1', url: 'https://fixture.invalid/version.json', type: 'release' }]
})
addJson('https://fixture.invalid/version.json', {
  id: '1.20.1', javaVersion: { majorVersion: 21 }, libraries: [],
  downloads: { server: { url: 'https://fixture.invalid/server.jar', sha1: hash(serverJar), size: serverJar.length } }
})
const mod = Buffer.from('server mod jar')
fixtures.set('https://cdn.modrinth.com/mod.jar', mod)
const pack = new AdmZip()
pack.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
  formatVersion: 1, game: 'minecraft', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.0' },
  files: [
    { path: 'mods/server.jar', downloads: ['https://cdn.modrinth.com/mod.jar'], hashes: { sha512: hash(mod, 'sha512') }, fileSize: mod.length, env: { server: 'required' } },
    { path: 'mods/client.jar', downloads: ['https://cdn.modrinth.com/missing.jar'], hashes: { sha512: hash(mod, 'sha512') }, fileSize: mod.length, env: { server: 'unsupported' } },
    { path: 'mods/optional.jar', downloads: ['https://cdn.modrinth.com/missing.jar'], hashes: { sha512: hash(mod, 'sha512') }, fileSize: mod.length, env: { server: 'optional' } }
  ]
})))
pack.addFile('overrides/config/side.txt', Buffer.from('common'))
pack.addFile('server-overrides/config/side.txt', Buffer.from('server'))
pack.addFile('client-overrides/config/client.txt', Buffer.from('client'))
const packData = pack.toBuffer()
fixtures.set('https://fixture.invalid/pack.mrpack', packData)
addJson('https://api.modrinth.com/v2/project/testpack', { id: 'testpack', slug: 'testpack', title: 'Test Pack', project_type: 'modpack' })
addJson('https://api.modrinth.com/v2/version/mr1', {
  id: 'mr1', project_id: 'testpack', name: 'Fixture pack', version_number: '1', date_published: '2026-01-01',
  files: [{ filename: 'pack.mrpack', url: 'https://fixture.invalid/pack.mrpack', size: packData.length, primary: true, hashes: { sha512: hash(packData, 'sha512') } }]
})
addJson('https://meta.fabricmc.net/v2/versions/installer', [{ version: '1.0.0', stable: true }])
fixtures.set('https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.0/fabric-installer-1.0.0.jar', Buffer.from('fabric installer'))

const cfClient = new CfClient('', 'fixture-key')
const cfManifest = new AdmZip()
cfManifest.addFile('manifest.json', Buffer.from(JSON.stringify({ minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] } })))
const cfData = cfManifest.toBuffer()
const serverPack = new AdmZip()
serverPack.addFile('ServerFiles/mods/fixture.jar', mod)
serverPack.addFile('ServerFiles/config/server.txt', Buffer.from('server config'))
serverPack.addFile('ServerFiles/run.sh', Buffer.from('touch UNSAFE_PACK_SCRIPT_RAN'))
const serverData = serverPack.toBuffer()
addJson('https://api.curseforge.com/v1/mods/100', { data: { id: 100, classId: 4471, name: 'CF Fixture', slug: 'cf' } })
const cfFile = (id: number, data: Buffer, isServerPack: boolean): unknown => ({
  data: { id, modId: 100, fileName: id + '.zip', displayName: id + '.zip', fileLength: data.length,
    downloadUrl: 'https://fixture.invalid/' + id + '.zip', isServerPack, serverPackFileId: isServerPack ? null : 102,
    hashes: [{ algo: 1, value: hash(data) }] }
})
addJson('https://api.curseforge.com/v1/mods/100/files/101', cfFile(101, cfData, false))
addJson('https://api.curseforge.com/v1/mods/100/files/102', cfFile(102, serverData, true))
fixtures.set('https://fixture.invalid/101.zip', cfData)
fixtures.set('https://fixture.invalid/102.zip', serverData)
fixtures.set('https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar', Buffer.from('forge installer'))
syncFixtures()

try {
  check('Unsafe server folder names, paths, EULA and numeric settings are rejected', () => {
    for (const slug of ['../world', '-option', 'UPPER', 'hello/world', 'a;touch bad', '']) assert.throws(() => validateDeployInput({ ...baseInput, slug }))
    for (const path of ['../world', '/etc/passwd', 'C:/temp', 'mods\\escape', 'mods/../world', '.openforge-server.json', 'openforge-start.sh']) assert.throws(() => safePackPath(path))
    assert.throws(() => validateDeployInput({ ...baseInput, acceptEula: false }))
    assert.throws(() => validateDeployInput({ ...baseInput, gamePort: 65536 }))
    assert.throws(() => validateDeployInput({ ...baseInput, ramMb: NaN }))
  })
  const mr = mrpackPlan(pack)
  check('Modrinth installs only required server files and applies server override precedence', () => {
    assert.equal(mr.files.length, 1)
    assert.equal(mr.files[0].path, 'mods/server.jar')
    assert.equal(mr.overrides.readAsText('config/side.txt'), 'server')
    assert.equal(mr.overrides.getEntry('config/client.txt'), null)
    assert.equal(mr.loader, 'fabric')
  })
  check('CurseForge keeps loader metadata and flattens wrapped server archives', () => {
    assert.equal(curseManifest(cfManifest).loaderVersion, '47.2.0')
    assert.equal(serverPackOverrides(serverPack).readAsText('config/server.txt'), 'server config')
  })
  const host = await inspectRemoteHost(target)
  check('Real SSH payload performs read-only host inspection without creating the root', () => {
    assert.equal(host.tmux, true)
    assert.equal(host.servers.length, 0)
    assert.equal(existsSync(join(root, 'minecraft-servers')), false)
  })
  const vanilla = await deployRemoteServer(baseInput, { cf: cfClient, report: () => {} })
  const vanillaDir = join(root, 'minecraft-servers', 'vanilla')
  check('Vanilla deploy downloads, writes EULA/port/memory and registers a managed tmux server', () => {
    assert.equal(readFileSync(join(vanillaDir, 'server.jar')).toString(), serverJar.toString())
    assert.match(readFileSync(join(vanillaDir, 'eula.txt'), 'utf8'), /eula=true/)
    assert.match(readFileSync(join(vanillaDir, 'server.properties'), 'utf8'), /server-port=25565/)
    assert.match(readFileSync(join(vanillaDir, 'openforge-start.sh'), 'utf8'), /-Xmx2048M/)
    assert.equal(vanilla.session, 'openforge-vanilla')
    assert.equal(vanilla.serverDir, '~/minecraft-servers/vanilla')
    assert.equal(spawnSync('sh', ['-n', join(vanillaDir, 'openforge-start.sh')]).status, 0)
  })
  await assert.rejects(() => deployRemoteServer(baseInput, { cf: cfClient, report: () => {} }), /already exists/)
  check('Existing directories are preserved and managed servers can be rediscovered/imported', () => assert.equal(readFileSync(join(vanillaDir, 'server.jar')).toString(), serverJar.toString()))
  assert.equal((await importRemoteServer(target, 'vanilla')).deployment?.mcVersion, '1.20.1')
  const fabric = await deployRemoteServer({ ...baseInput, slug: 'fabric', source: 'modrinth', projectId: 'testpack', versionId: 'mr1' }, { cf: cfClient, report: () => {} })
  check('Modrinth deployment installs the pinned Fabric loader and excludes client-only files', () => {
    const dir = join(root, 'minecraft-servers', 'fabric')
    assert.equal(fabric.deployment?.loaderVersion, '0.16.0')
    assert.equal(readFileSync(join(dir, 'mods/server.jar')).toString(), mod.toString())
    assert.equal(existsSync(join(dir, 'mods/client.jar')), false)
    assert.equal(readFileSync(join(dir, 'config/side.txt'), 'utf8'), 'server')
    assert.match(readFileSync(join(dir, 'openforge-start.sh'), 'utf8'), /fabric-server-launch.jar/)
  })
  const forge = await deployRemoteServer({ ...baseInput, slug: 'forge', source: 'curseforge', projectId: '100', versionId: '101' }, { cf: cfClient, report: () => {} })
  check('CurseForge selects linked server files and uses official Forge arguments without executing pack scripts', () => {
    const dir = join(root, 'minecraft-servers', 'forge')
    assert.equal(forge.deployment?.loader, 'forge')
    assert.equal(readFileSync(join(dir, 'mods/fixture.jar')).toString(), mod.toString())
    assert.match(readFileSync(join(dir, 'openforge-start.sh'), 'utf8'), /unix_args.txt/)
    assert.equal(existsSync(join(dir, 'UNSAFE_PACK_SCRIPT_RAN')), false)
  })
  addJson('https://api.curseforge.com/v1/mods/100/files/103', { data: { id: 103, modId: 100, fileName: 'client.zip' } })
  await assert.rejects(() => deployRemoteServer({ ...baseInput, slug: 'client-only', source: 'curseforge', projectId: '100', versionId: '103' }, { cf: cfClient, report: () => {} }), /no linked server pack/)
  check('CurseForge client-only packs fail before any remote directory is created', () => assert.equal(existsSync(join(root, 'minecraft-servers', 'client-only')), false))
  for (const [loader, dependency, version] of [['neoforge', 'neoforge', '21.1.1'], ['quilt', 'quilt-loader', '0.27.0']] as const) {
    const variant = new AdmZip(pack.toBuffer())
    const index = JSON.parse(variant.readAsText('modrinth.index.json'))
    index.dependencies = { minecraft: '1.20.1', [dependency]: version }
    variant.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)))
    const bytes = variant.toBuffer()
    const id = 'mr-' + loader
    const url = 'https://fixture.invalid/' + id + '.mrpack'
    fixtures.set(url, bytes)
    addJson('https://api.modrinth.com/v2/version/' + id, {
      id, project_id: 'testpack', name: id, version_number: '1', date_published: '2026-01-01',
      files: [{ filename: id + '.mrpack', url, size: bytes.length, primary: true, hashes: { sha512: hash(bytes, 'sha512') } }]
    })
    if (loader === 'neoforge') {
      // Use a post-1.20.1 Minecraft version to test modern NeoForge coordinates.
      index.dependencies.minecraft = '1.21.1'
      variant.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)))
      const updated = variant.toBuffer()
      fixtures.set(url, updated)
      addJson('https://api.modrinth.com/v2/version/' + id, {
        id, project_id: 'testpack', name: id, version_number: '1', date_published: '2026-01-01',
        files: [{ filename: id + '.mrpack', url, size: updated.length, hashes: { sha512: hash(updated, 'sha512') } }]
      })
      addJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
        latest: { release: '1.21.1', snapshot: '1.21.1' },
        versions: ['1.20.1', '1.21.1'].map((id) => ({ id, url: 'https://fixture.invalid/version.json', type: 'release' }))
      })
      fixtures.set('https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.1/neoforge-21.1.1-installer.jar', Buffer.from('neoforge installer'))
    } else {
      fixtures.set('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml', Buffer.from('<metadata><versioning><release>1.0.0</release></versioning></metadata>'))
      fixtures.set('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/1.0.0/quilt-installer-1.0.0.jar', Buffer.from('quilt installer'))
    }
    syncFixtures()
    const installed = await deployRemoteServer({ ...baseInput, slug: loader, source: 'modrinth', projectId: 'testpack', versionId: id }, { cf: cfClient, report: () => {} })
    check('Pinned ' + loader + ' loader installation produces a relocatable launcher', () => {
      assert.equal(installed.deployment?.loader, loader)
      assert.equal(installed.deployment?.loaderVersion, version)
      assert.match(readFileSync(join(root, 'minecraft-servers', loader, 'openforge-start.sh'), 'utf8'), loader === 'quilt' ? /quilt-server-launch.jar/ : /neoforged\/neoforge\/21.1.1\/unix_args.txt/)
    })
  }
  // Exercise the real rootless JDK download, checksum and tar extraction.
  const tarScript = String.raw`
import io, sys, tarfile
script = b'#!/bin/sh\nprintf \'openjdk version "17.0.0"\\n\' >&2\nexit 0\n'
with tarfile.open(fileobj=sys.stdout.buffer, mode="w:gz") as archive:
    item = tarfile.TarInfo("jdk17/bin/java")
    item.mode = 0o755
    item.size = len(script)
    archive.addfile(item, io.BytesIO(script))
    link = tarfile.TarInfo("jdk17/java-link")
    link.type = tarfile.SYMTYPE
    link.linkname = "bin/java"
    archive.addfile(link)
`
  const jdk = spawnSync('python3', ['-c', tarScript], { timeout: 5000 })
  assert.equal(jdk.status, 0)
  fixtures.set('https://fixture.invalid/java.tar.gz', jdk.stdout)
  addJson('https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse', [
    { binary: { package: { link: 'https://fixture.invalid/java.tar.gz', size: jdk.stdout.length, checksum: hash(jdk.stdout, 'sha256') } } }
  ])
  addJson('https://fixture.invalid/version.json', {
    id: '1.20.1', javaVersion: { majorVersion: 17 }, libraries: [],
    downloads: { server: { url: 'https://fixture.invalid/server.jar', sha1: hash(serverJar), size: serverJar.length } }
  })
  syncFixtures()
  await deployRemoteServer({ ...baseInput, slug: 'managed-java' }, { cf: cfClient, report: () => {} })
  check('Matching Java installs without sudo, accepts safe internal runtime symlinks, and works after staging is moved', () => {
    const dir = join(root, 'minecraft-servers', 'managed-java')
    assert.equal(existsSync(join(dir, '.openforge-java/jdk17/bin/java')), true)
    assert.match(readFileSync(join(dir, 'openforge-start.sh'), 'utf8'), /exec \.\/\.openforge-java\/jdk17\/bin\/java/)
    assert.equal(spawnSync('sh', [join(dir, 'openforge-start.sh')], { timeout: 5000 }).status, 0)
  })
  const badJar = Buffer.from('corrupt server download')
  fixtures.set('https://fixture.invalid/server.jar', badJar)
  syncFixtures()
  await assert.rejects(() => deployRemoteServer({ ...baseInput, slug: 'corrupt' }, { cf: cfClient, report: () => {} }), /size does not match|checksum does not match/)
  check('Failed download verification cleans staging and never publishes a broken server', () => {
    assert.equal(existsSync(join(root, 'minecraft-servers', 'corrupt')), false)
    assert.equal(readdirSync(join(root, 'minecraft-servers')).some((name) => name.startsWith('.openforge-staging-')), false)
  })
  fixtures.set('https://fixture.invalid/server.jar', serverJar)
  syncFixtures()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => deployRemoteServer({ ...baseInput, slug: 'cancelled' }, { cf: cfClient, report: () => {}, signal: controller.signal }), /cancelled/)
  check('Cancellation prevents publication', () => assert.equal(existsSync(join(root, 'minecraft-servers', 'cancelled')), false))
  // Send a deliberately invalid uploaded ZIP to the real Python extraction path.
  const malicious = new AdmZip()
  malicious.addFile('mods/link', Buffer.from('/tmp'))
  const entry = malicious.getEntry('mods/link')!
  entry.attr = (0o120777 << 16) >>> 0
  const bytes = malicious.toBuffer()
  const result = await runSsh(buildSshArgs(target, AGENT_COMMAND), 20_000, {
    input: agentInput({ action: 'deploy', plan: { schema: 1, name: 'Bad archive', deployment: { ...vanilla.deployment, slug: 'bad-archive' }, files: [] }, archiveSize: bytes.length, archiveSha256: hash(bytes, 'sha256') }, bytes)
  })
  check('The remote extraction layer independently rejects symlink archives and cleans staging', () => {
    assert.equal(result.code, 1)
    assert.match(result.stdout, /symlink/)
    assert.equal(existsSync(join(root, 'minecraft-servers', 'bad-archive')), false)
  })
  console.log('\n' + assertions + ' server deployment checks passed.')
} finally {
  setTransport(null)
  process.env.PATH = originalPath
  await rm(root, { recursive: true, force: true })
}
