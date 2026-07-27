// Smoke test for the real launcher core (bundled with esbuild, run under node).
// Exercises the pure algorithms + the live external contracts the app relies on.
import { offlineUuid, isValidUsername } from '../src/main/core/auth'
import { mavenToPath, nativeClassifier, isAllowed, currentOsName } from '../src/main/core/rules'
import { fetchVersionManifest, fetchVersionDetail } from '../src/main/core/manifest'
import { CfClient, forgeCdnUrl } from '../src/main/core/curseforge'

let failures = 0
function ok(cond: boolean, label: string, extra = ''): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '  — ' + extra : ''}`)
  if (!cond) failures++
}

async function main(): Promise<void> {
  console.log('\n▪ Offline auth')
  const u = offlineUuid('Player')
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u), 'UUID is well-formed', u)
  ok(u[14] === '3', 'version nibble is 3 (name-based MD5)', `got ${u[14]}`)
  ok(['8', '9', 'a', 'b'].includes(u[19]), 'IETF variant bits set', `got ${u[19]}`)
  ok(offlineUuid('Player') === u, 'deterministic per username')
  ok(offlineUuid('Steve') !== u, 'differs across usernames')
  ok(isValidUsername('Steve_99') && !isValidUsername('bad name!'), 'username validation')

  console.log('\n▪ Rules / maven')
  ok(
    mavenToPath('net.fabricmc:fabric-loader:0.15.0') ===
      'net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar',
    'maven coordinate -> path'
  )
  ok(
    mavenToPath('org.lwjgl:lwjgl:3.3.1:natives-windows') ===
      'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
    'maven coordinate with classifier'
  )
  ok(mavenToPath('de.oceanlabs.mcp:mcp_config:1.20.1@zip').endsWith('mcp_config-1.20.1.zip'), 'maven @ext override')
  ok(isAllowed(undefined) === true, 'no rules => allowed')
  ok(
    isAllowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }]) === true ||
      process.platform === 'darwin',
    'allow + disallow-osx on non-mac'
  )
  ok(nativeClassifier({ name: 'x', natives: { windows: 'natives-windows' } }) !== undefined, 'native classifier resolves')
  const modernNative = `natives-${currentOsName() === 'osx' ? 'macos' : currentOsName()}${
    process.arch === 'arm64' ? '-arm64' : ''
  }`
  ok(
    nativeClassifier({
      name: `org.lwjgl:lwjgl:3.3.3:${modernNative}`,
      downloads: { artifact: { url: 'x', sha1: 'x', size: 1 } }
    }) === modernNative,
    'modern native-coordinate classifier resolves'
  )

  console.log('\n▪ Mojang manifest (live)')
  const manifest = await fetchVersionManifest()
  const latest = manifest.latest.release
  ok(Boolean(latest), 'has latest release', latest)
  const entry = manifest.versions.find((v) => v.id === latest)!
  const detail = await fetchVersionDetail(entry.url)
  ok(Boolean(detail.downloads?.client?.url), 'version JSON has client download')
  ok(detail.libraries.length > 0, 'version JSON has libraries', `${detail.libraries.length} libs`)
  ok(Boolean(detail.assetIndex?.url), 'version JSON has asset index')
  ok(Boolean(detail.javaVersion?.majorVersion), 'declares required Java', `Java ${detail.javaVersion?.majorVersion}`)
  ok(Boolean(detail.arguments || detail.minecraftArguments), 'has launch arguments')

  console.log('\n▪ forgecdn URL pattern')
  ok(
    forgeCdnUrl(4567890, 'cool mod.jar') === 'https://mediafilez.forgecdn.net/files/4567/890/cool%20mod.jar',
    'splits fileId + encodes name'
  )

  console.log('\n▪ CurseForge via proxy (live, servercraft @ :3847)')
  try {
    const cf = new CfClient('http://localhost:3847', '')
    const search = await cf.search({ query: 'all the mods', sort: 'popular' })
    ok(search.packs.length > 0, 'search returns modpacks', `${search.packs.length} results`)
    const first = search.packs[0]
    ok(Boolean(first.name && first.id), 'pack has id + name', first.name)
    const mod = await cf.getMod(first.id)
    ok(mod.id === first.id, 'getMod round-trips')
    const files = await cf.getFiles(first.id, 0)
    ok(files.length > 0, 'getFiles returns files', `${files.length} files`)
    const withUrl = files.find((f) => f.downloadUrl) ?? files[0]
    const cdn = withUrl.downloadUrl ?? forgeCdnUrl(withUrl.id, withUrl.fileName)
    const head = await fetch(cdn, { method: 'HEAD' })
    ok(head.ok || head.status === 403, 'resolved a real download URL', `${cdn.slice(0, 60)}… -> ${head.status}`)
  } catch (e) {
    ok(false, 'proxy reachable', (e as Error).message)
  }

  console.log(`\n${failures === 0 ? '✅ all smoke checks passed' : `❌ ${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
