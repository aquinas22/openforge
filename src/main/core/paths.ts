import { app } from 'electron'
import { join } from 'node:path'

/**
 * Central filesystem layout. Everything the launcher writes lives under a single
 * game directory so instances are portable and easy to back up.
 *
 *   <gameDir>/
 *     versions/<id>/<id>.jar + <id>.json
 *     libraries/<maven path>
 *     assets/{indexes,objects,virtual}
 *     natives/<version>/
 *     instances/<instanceId>/  (the actual .minecraft working dir per instance)
 */

export function defaultGameDir(): string {
  return join(app.getPath('userData'), 'minecraft')
}

export function launcherConfigDir(): string {
  return app.getPath('userData')
}

export class GamePaths {
  constructor(public readonly root: string) {}

  get versions() {
    return join(this.root, 'versions')
  }
  versionDir(id: string) {
    return join(this.versions, id)
  }
  versionJar(id: string) {
    return join(this.versionDir(id), `${id}.jar`)
  }
  versionJson(id: string) {
    return join(this.versionDir(id), `${id}.json`)
  }
  get libraries() {
    return join(this.root, 'libraries')
  }
  library(path: string) {
    return join(this.libraries, path)
  }
  get assets() {
    return join(this.root, 'assets')
  }
  assetIndex(id: string) {
    return join(this.assets, 'indexes', `${id}.json`)
  }
  assetObject(hash: string) {
    return join(this.assets, 'objects', hash.substring(0, 2), hash)
  }
  get assetsVirtual() {
    return join(this.assets, 'virtual')
  }
  nativesDir(versionId: string) {
    return join(this.root, 'natives', versionId)
  }
  get instances() {
    return join(this.root, 'instances')
  }
  instanceDir(instanceId: string) {
    return join(this.instances, instanceId)
  }
}
