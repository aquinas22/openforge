/**
 * Bundled Python agent, sent over SSH stdin on every call. It needs only the
 * remote Python standard library; no daemon, pip packages, scp, or sudo.
 * Keep this a string so Electron's packaged main process includes the agent.
 */
export const REMOTE_AGENT = String.raw`
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

PREFIX = "OPENFORGE:"
ROOT = Path.home() / "minecraft-servers"
USER_AGENT = "OpenForge/2.2.0 (github.com/aquinas22/openforge)"
MAX_ARCHIVE = 8 * 1024 ** 3
child = None

def emit(kind, **data):
    print(PREFIX + json.dumps(dict(kind=kind, **data)), flush=True)

def progress(phase, message):
    emit("progress", phase=phase, message=message)

def slug_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value):
        raise ValueError("Invalid server directory name.")
    return value

def root_checked(create=False):
    if ROOT.is_symlink():
        raise ValueError("~/minecraft-servers must be a real directory, not a symlink.")
    if create:
        ROOT.mkdir(mode=0o700, exist_ok=True)
    return ROOT

def safe_path(root, name, reserved=False):
    if not isinstance(name, str) or not name or len(name) > 1000 or re.search(r"[\x00-\x1f\\:]", name):
        raise ValueError("Unsafe archive path.")
    pieces = name.split("/")
    if name.startswith("/") or any(p in ("", ".", "..") for p in pieces):
        raise ValueError("Archive path escapes the server directory.")
    if not reserved and (any(p.startswith(".openforge") for p in pieces) or name == "openforge-start.sh"):
        raise ValueError("Archive uses a reserved OpenForge path.")
    result = root.joinpath(*pieces)
    current = root
    for part in pieces:
        current = current / part
        if current.is_symlink():
            raise ValueError("Refusing to follow a symlink.")
    return result

def url_open(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise ValueError("Downloads must use HTTPS.")
    response = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=60)
    if urllib.parse.urlparse(response.url).scheme != "https":
        response.close()
        raise ValueError("Download redirected away from HTTPS.")
    return response

def download(task, root, reserved=False):
    dest = safe_path(root, task["path"], reserved)
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    for url in task["urls"]:
        for attempt in range(3):
            part = dest.with_name(dest.name + ".part")
            try:
                hashes = {alg: hashlib.new(alg) for alg in ("sha1", "sha256", "sha512") if task.get(alg)}
                size = 0
                with url_open(url) as response, part.open("wb") as output:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        size += len(block)
                        if size > MAX_ARCHIVE:
                            raise ValueError("Download exceeds the size limit.")
                        output.write(block)
                        for digest in hashes.values():
                            digest.update(block)
                if task.get("size") and size != task["size"]:
                    raise ValueError("Downloaded file size does not match.")
                if any(digest.hexdigest() != task[alg].lower() for alg, digest in hashes.items()):
                    raise ValueError("Downloaded file checksum does not match.")
                part.replace(dest)
                return dest
            except Exception as error:
                part.unlink(missing_ok=True)
                last_error = error
                if attempt < 2:
                    time.sleep(attempt + 1)
    raise RuntimeError("Could not download " + task["path"] + ": " + str(last_error))

def extract_zip(archive, dest):
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > 100000 or sum(item.file_size for item in entries) > MAX_ARCHIVE:
            raise ValueError("Archive exceeds the extraction limit.")
        paths = []
        seen = set()
        for item in entries:
            path = safe_path(dest, item.filename.rstrip("/"))
            mode = stat.S_IFMT(item.external_attr >> 16)
            if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or item.file_size > 512 * 1024 ** 2:
                raise ValueError("Archive contains a symlink, special file, or oversized entry.")
            if item.filename in seen:
                raise ValueError("Archive contains duplicate paths.")
            seen.add(item.filename)
            paths.append((item, path))
        for item, path in paths:
            if item.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with package.open(item) as source, path.open("wb") as output:
                    shutil.copyfileobj(source, output)

def java_major(java):
    try:
        result = subprocess.run([str(java), "-version"], capture_output=True, text=True, timeout=15)
        match = re.search(r'version "(\d+)(?:\.(\d+))?', result.stderr + result.stdout)
        if result.returncode == 0 and match:
            return int(match[2]) if match[1] == "1" else int(match[1])
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None

def provision_java(major, stage):
    available = shutil.which("java")
    if available and java_major(available) == major:
        return str(Path(available).resolve())
    progress("java", "Installing Java " + str(major) + " for this server")
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "aarch64", "arm64": "aarch64"}.get(platform.machine().lower())
    if platform.system() != "Linux" or not arch:
        raise RuntimeError("Automatic Java installation requires Linux x64 or ARM64. Install matching Java on this host first.")
    endpoint = "https://api.adoptium.net/v3/assets/latest/" + str(major) + "/hotspot?" + urllib.parse.urlencode(
        {"architecture": arch, "image_type": "jdk", "os": "linux", "vendor": "eclipse"})
    with url_open(endpoint) as response:
        assets = json.load(response)
    if not assets:
        raise RuntimeError("No Java runtime available for this host.")
    package = assets[0]["binary"]["package"]
    archive = download({"path": ".openforge-java.tar.gz", "urls": [package["link"]], "sha256": package["checksum"], "size": package.get("size")}, stage, True)
    java_root = stage / ".openforge-java"
    java_root.mkdir()
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) > 100000 or sum(item.size for item in members) > MAX_ARCHIVE:
            raise ValueError("Java archive is too large.")
        for member in members:
            if not member.isfile() and not member.isdir() and not member.issym():
                raise ValueError("Java archive contains a hard link or special file.")
            target = safe_path(java_root, member.name.rstrip("/"), True)
            if member.issym():
                # Temurin archives may contain internal library symlinks.
                if Path(member.linkname).is_absolute():
                    raise ValueError("Java archive contains an absolute symlink.")
                try:
                    (target.parent / member.linkname).resolve().relative_to(java_root)
                except ValueError:
                    raise ValueError("Java symlink escapes the runtime directory.")
        for member in members:
            if member.issym():
                continue
            target = safe_path(java_root, member.name.rstrip("/"), True)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)
        for member in members:
            if member.issym():
                target = safe_path(java_root, member.name.rstrip("/"), True)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
    archive.unlink()
    candidates = list(java_root.glob("*/bin/java"))
    if len(candidates) != 1 or java_major(candidates[0]) != major:
        raise RuntimeError("The downloaded Java runtime did not validate.")
    return "./" + candidates[0].relative_to(stage).as_posix()

def run_installer(args, stage):
    global child
    # Installer output is kept out of the machine-readable progress protocol.
    with (stage / ".openforge-install.log").open("w") as output:
        child = subprocess.Popen(args, cwd=stage, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=1200)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Loader installation timed out.")
        finally:
            child = None
    if code != 0:
        detail = (stage / ".openforge-install.log").read_text(errors="replace")[-3000:]
        raise RuntimeError("Loader installer failed (exit " + str(code) + "). " + detail)

def install_loader(plan, java, stage):
    deployment = plan["deployment"]
    loader = deployment["loader"]
    if loader == "vanilla":
        return ["-jar", "server.jar", "nogui"]
    progress("loader", "Installing " + loader + " " + deployment["loaderVersion"])
    installer = download(plan["loader"], stage, True)
    common = [java, "-Djava.awt.headless=true", "-jar", str(installer)]
    if loader in ("forge", "neoforge"):
        run_installer(common + ["--installServer"], stage)
        base = "net/minecraftforge/forge" if loader == "forge" else ("net/neoforged/forge" if deployment["mcVersion"] == "1.20.1" else "net/neoforged/neoforge")
        version = deployment["loaderVersion"]
        if loader == "forge" or deployment["mcVersion"] == "1.20.1":
            if not version.startswith(deployment["mcVersion"] + "-"):
                version = deployment["mcVersion"] + "-" + version
        args = stage / "libraries" / base / version / "unix_args.txt"
        if args.is_file():
            return ["@" + args.relative_to(stage).as_posix(), "nogui"]
        jars = [p for p in stage.glob("*forge-" + version + "*.jar") if "installer" not in p.name.lower()]
        if len(jars) == 1:
            return ["-jar", jars[0].name, "nogui"]
    elif loader == "fabric":
        run_installer(common + ["server", "-mcversion", deployment["mcVersion"], "-loader", deployment["loaderVersion"], "-dir", str(stage)], stage)
        launch = [p for p in stage.glob("fabric-server-launch*.jar")]
        if len(launch) == 1:
            return ["-jar", launch[0].name, "nogui"]
    elif loader == "quilt":
        run_installer(common + ["install", "server", deployment["mcVersion"], deployment["loaderVersion"], "--install-dir=."], stage)
        if (stage / "quilt-server-launch.jar").is_file():
            return ["-jar", "quilt-server-launch.jar", "nogui"]
    raise RuntimeError("The loader installer did not produce a supported server launcher.")

def inspect():
    root_checked()
    servers = []
    if ROOT.is_dir():
        for directory in sorted(ROOT.iterdir()):
            if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", directory.name):
                continue
            item = {"slug": directory.name, "name": directory.name, "directory": "~/minecraft-servers/" + directory.name}
            metadata = directory / ".openforge-server.json"
            if metadata.is_file() and not metadata.is_symlink() and metadata.stat().st_size < 65536:
                try:
                    saved = json.loads(metadata.read_text())
                    if saved.get("schema") == 1 and saved["deployment"]["slug"] == directory.name:
                        item.update(name=saved["name"], deployment=saved["deployment"])
                except (ValueError, KeyError, TypeError):
                    pass
            servers.append(item)
    java = shutil.which("java")
    emit("result", value={"root": "~/minecraft-servers", "pythonVersion": platform.python_version(),
        "javaVersion": str(java_major(java)) if java and java_major(java) else None, "tmux": bool(shutil.which("tmux")),
        "freeDiskMb": shutil.disk_usage(ROOT if ROOT.exists() else Path.home()).free // 1024 ** 2, "servers": servers})

def cancelled(signum, frame):
    global child
    if child is not None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass
    raise RuntimeError("Deployment cancelled or SSH disconnected.")

def deploy(request):
    plan = request["plan"]
    deployment = plan["deployment"]
    slug = slug_name(deployment["slug"])
    if plan["schema"] != 1 or deployment["loader"] not in ("vanilla", "fabric", "quilt", "forge", "neoforge"):
        raise ValueError("Unsupported deployment plan.")
    for key, lower, upper in (("ramMb", 512, 262144), ("gamePort", 1, 65535), ("javaMajor", 8, 100)):
        if not isinstance(deployment[key], int) or not lower <= deployment[key] <= upper:
            raise ValueError("Invalid deployment setting: " + key)
    if not shutil.which("tmux"):
        raise RuntimeError("Install tmux on the SSH server first (for example: sudo apt install tmux).")
    root_checked(True)
    target = ROOT / slug
    if target.exists() or target.is_symlink():
        raise RuntimeError("That server directory already exists. Choose another name or import it.")
    locks = ROOT / ".openforge-locks"
    if locks.is_symlink():
        raise ValueError("Unsafe deployment lock directory.")
    locks.mkdir(mode=0o700, exist_ok=True)
    lock_path = locks / (slug + ".lock")
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another deployment is already installing this server.")
        stage = Path(tempfile.mkdtemp(prefix=".openforge-staging-", dir=ROOT))
        try:
            archive = stage / ".openforge-upload.zip"
            size = 0
            digest = hashlib.sha256()
            progress("uploading", "Receiving server files over SSH")
            with archive.open("wb") as output:
                while True:
                    block = sys.stdin.buffer.read(1024 * 1024)
                    if not block:
                        break
                    size += len(block)
                    if size > MAX_ARCHIVE:
                        raise ValueError("Upload is too large.")
                    output.write(block)
                    digest.update(block)
            if size != request["archiveSize"] or digest.hexdigest() != request["archiveSha256"]:
                raise ValueError("The uploaded archive failed its checksum.")
            progress("downloading", "Downloading server dependencies")
            # A bounded pool keeps large packs fast without overwhelming the CDN.
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(download, task, stage) for task in plan["files"] if task["path"] != "server.jar"]
                for index, future in enumerate(concurrent.futures.as_completed(futures)):
                    future.result()
                    progress("downloading", "Downloaded " + str(index + 1) + "/" + str(len(futures)) + " server files")
            progress("extracting", "Extracting server files")
            extract_zip(archive, stage)
            archive.unlink()
            vanilla = next(task for task in plan["files"] if task["path"] == "server.jar")
            download(vanilla, stage)
            java = provision_java(deployment["javaMajor"], stage)
            launch_args = install_loader(plan, java, stage)
            java_dir = str(Path(java).parent) if not java.startswith("./") else java.rsplit("/", 1)[0]
            ram = deployment["ramMb"]
            script = "#!/bin/sh\nset -eu\ncd -- \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"\n"
            script += "export JAVA_HOME=" + shlex.quote(java_dir.rsplit("/", 1)[0]) + "\n"
            script += "export PATH=" + shlex.quote(java_dir) + ":\"$PATH\"\n"
            script += "exec " + shlex.quote(java) + " -Xms" + str(min(ram, 1024)) + "M -Xmx" + str(ram) + "M " + " ".join(shlex.quote(arg) for arg in launch_args) + "\n"
            (stage / "openforge-start.sh").write_text(script)
            (stage / "openforge-start.sh").chmod(0o700)
            (stage / "eula.txt").write_text("# Accepted in OpenForge\n# https://aka.ms/MinecraftEULA\neula=true\n")
            properties = stage / "server.properties"
            existing = properties.read_text(errors="replace") if properties.exists() else ""
            existing = re.sub(r"(?m)^\s*server-port\s*[=:].*$", "", existing)
            properties.write_text(existing.rstrip() + "\nserver-port=" + str(deployment["gamePort"]) + "\n")
            (stage / "logs").mkdir(exist_ok=True)
            (stage / "logs" / "latest.log").touch(exist_ok=True)
            metadata = {"schema": 1, "name": plan["name"], "deployment": deployment}
            (stage / ".openforge-server.json").write_text(json.dumps(metadata, indent=2))
            # A directory reservation prevents rename from replacing an existing
            # empty directory created by another client while we were installing.
            target.mkdir(mode=0o700)
            try:
                stage.rename(target)
            except BaseException:
                target.rmdir()
                raise
            progress("ready", "Server installed. Press Start when you are ready.")
            emit("result", value={"slug": slug, "name": plan["name"], "directory": "~/minecraft-servers/" + slug, "deployment": deployment})
        finally:
            if stage.exists():
                shutil.rmtree(stage)

def main():
    if sys.version_info < (3, 9):
        raise RuntimeError("OpenForge needs Python 3.9 or newer on the SSH server.")
    for event in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(event, cancelled)
    line = sys.stdin.buffer.readline(4 * 1024 * 1024 + 1)
    if len(line) > 4 * 1024 * 1024:
        raise ValueError("Deployment metadata is too large.")
    request = json.loads(line)
    if request["action"] == "inspect":
        inspect()
    elif request["action"] == "deploy":
        deploy(request)
    else:
        raise ValueError("Unknown server operation.")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=str(error))
        sys.exit(1)
`
