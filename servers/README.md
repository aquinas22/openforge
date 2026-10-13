# OpenForge SSH servers

This directory contains the deployment backend used by OpenForge's Servers
page. It provisions dedicated Minecraft servers over key-authenticated OpenSSH,
under the remote user's ~/minecraft-servers/<slug> directory.

In the app, choose **Servers → Add server → Over SSH → Set up a server**.
Enter the host (for example server.noahroe.site), SSH username, and optionally
a private key file. An empty key field uses ssh-agent and OpenSSH's default
keys. Passphrase-protected keys should be loaded with ssh-add first.

The host needs Linux, Python 3.9 or newer, tmux, enough storage, and outbound
HTTPS access. OpenForge installs a matching Temurin JDK inside the server
directory when the system Java version does not match. This works on Linux x64
and ARM64 without sudo. Other POSIX hosts can use an already-installed matching
Java runtime.

Choose a source, version, folder name, RAM, and Minecraft port, then accept the
Minecraft EULA and press **Set up server**. After installation, use **Start**,
**Stop**, **Tail log**, and the console command field. Opening the server in the
app also refreshes its status every five seconds. Allow the selected Minecraft
port through the host's firewall if players need to connect from outside.

**Scan host** lists folders already in ~/minecraft-servers. Servers created
by OpenForge can be added back using their saved metadata. For other server
folders, choose **Existing server** and configure its start script and control
method. Removing an entry from the app preserves all remote files.

## Sources

- **Vanilla:** downloads Mojang's server jar with its published SHA-1 and uses
  the Java version specified in Mojang's version metadata.
- **Modrinth:** reads the .mrpack index, downloads required/default server
  files with their published hashes, omits unsupported/optional server files,
  and applies common overrides followed by server-overrides. Client overrides
  are excluded.
- **CurseForge:** uses the server distribution linked to the selected client
  release through serverPackFileId. Minecraft and loader versions come from
  that release's manifest. A wrapped server directory is flattened. The
  existing CurseForge key/proxy configuration is used locally; credentials and
  private keys are never uploaded. Releases without linked server files are
  refused. Server distributions that contain only a third-party bootstrap
  installer, rather than the server's mods/configs, are not supported.

Fabric, Quilt, Forge, and NeoForge are installed using their official
installers and pinned pack loader versions. Modern Forge/NeoForge servers use
their generated unix_args.txt; legacy Forge uses its generated server jar.
OpenForge generates openforge-start.sh and does not execute pack-provided
shell scripts.

## Frontend API

The shared contracts live in src/shared/ipc.ts and src/shared/types.ts.
src/preload/index.ts exposes these methods on window.openforge:

| Method | Purpose |
| --- | --- |
| inspectRemoteHost(target) | Check Python/tmux, available disk space, and server folders without creating directories. |
| deployRemoteServer(input) | Resolve a source, transfer server files, provision Java/loader, and persist an SSH server configuration. |
| onServerDeployment(callback) | Receive progress for a particular requestId. |
| cancelServerDeployment(requestId) | Cancel resolution, downloads, or the active SSH installation. |
| importRemoteServer(target, slug) | Reconnect to a server with OpenForge metadata. |
| Existing server methods | Start, stop, send commands, refresh status, and tail logs. |

index.ts orchestrates SSH and generates tmux configurations. plan.ts
resolves source metadata and validates pack contents. remote.ts contains the
Python agent embedded in the Electron main bundle. The source, JSON request,
and ZIP bytes travel through SSH stdin, avoiding command-line size limits and
requiring no remote agent installation.

## Installation behavior

Each installation uses a unique staging directory and a per-server filesystem
lock. Downloads and uploaded archives are verified before installation, archive
paths and symlinks are checked, and the completed directory is published only
after Java and the loader are ready. Existing server directories are never
overwritten. Failures and ordinary cancellation remove staging files; an
unrecoverable connection loss or host shutdown can leave a hidden staging
directory, which is excluded from the server list. A successfully published
server can always be recovered with **Scan host**, even if the desktop app
disconnects before saving its configuration.

Run npm run verify:servers for isolated tests of the actual planner, SSH
payload, Python extraction, source handling, checksums, and recovery behavior.
npm run check also runs the launcher's existing verification suite.

Protocol references: [Modrinth pack format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack),
[CurseForge file API](https://docs.curseforge.com/rest-api/),
[Fabric server installation](https://wiki.fabricmc.net/install),
[Quilt server installation](https://quiltmc.org/en/install/server/),
[NeoForge server installation](https://docs.neoforged.net/user/docs/server/),
and [Adoptium API](https://github.com/adoptium/api.adoptium.net/blob/main/docs/cookbook.adoc).
