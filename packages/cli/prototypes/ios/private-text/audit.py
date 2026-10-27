#!/usr/bin/env python3
"""Sentinel audit of pinned agent-device on a disposable iOS simulator.

Run from the repository root. The only retained artifact is the sanitized JSON
receipt. No secret, capture, user simulator, or shared runner cache is retained
or removed by name. This is research scaffolding, not a private input helper.
"""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[5]
CLI = ["nub", str(ROOT / "packages/cli/dist/node_modules/agent-device/bin/agent-device.mjs")]
BUNDLE = "dev.contingency.private-text-spike"
SESSION = "ios546"


def now():
    return datetime.datetime.now(datetime.UTC).isoformat()


def main():
    destination = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="contingency-ios-546-"))
    os.chmod(work, 0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_DEVICE_")}
    env.update(AGENT_DEVICE_STATE_DIR=str(work / "state"), AGENT_DEVICE_HOME=str(work / "home"), AGENT_DEVICE_IOS_RUNNER_DETACH="0", TMPDIR=str(work / "tmp"))
    (work / "tmp").mkdir()
    secret = secrets.token_hex(20).encode()
    patterns = {"utf8": secret, "utf16le": secret.decode().encode("utf-16le"), "base64": base64.b64encode(secret)}
    receipt = {"startedAt": now(), "agentDevice": "0.21.25", "sentinel": {"sha256": hashlib.sha256(secret).hexdigest(), "length": len(secret)}, "commands": [], "resources": [], "channels": {}, "cleanup": {}}
    owned = []
    captures = []
    udid = None
    daemon = None
    runner_pid = None
    runner_port = None
    results = []
    stop = threading.Event()
    sample_errors = []
    samples = {"count": 0, "fullMatches": 0, "fragmentMatches": 0, "runnerSamples": 0}

    def public_command(args):
        return [str(a).replace(str(work), "$WORK").replace(str(ROOT), "$REPO").replace(str(Path.home()), "~") for a in args]

    def run(args, timeout=180):
        p = subprocess.run([str(a) for a in args], env=env, capture_output=True, timeout=timeout, cwd=ROOT)
        receipt["commands"].append({"argv": public_command(args), "exitCode": p.returncode})
        if p.returncode:
            # Raw child output is never raised into a tool transcript.
            raise RuntimeError("command failed: " + str(args[0]))
        return p.stdout

    def scan(root):
        out = {"files": 0, "bytes": 0, "fullValueMatches": [], "fragmentMatches": [], "unreadable": []}
        if not root.exists():
            out["exists"] = False
            return out
        for path in root.rglob("*"):
            if not path.is_file() or path.is_symlink() or path.name == "sentinel":
                continue
            try:
                data = path.read_bytes()
                out["files"] += 1
                out["bytes"] += len(data)
                hits = {name: data.count(value) for name, value in patterns.items() if value in data}
                if hits:
                    out["fullValueMatches"].append({"path": str(path.relative_to(root)), "encodings": hits})
                longest = {"offset": 0, "length": 0}
                for offset in range(len(secret) - 7):
                    for length in range(8, len(secret) - offset + 1):
                        if secret[offset:offset + length] not in data:
                            break
                        if length > longest["length"]:
                            longest = {"offset": offset, "length": length}
                if longest["length"]:
                    out["fragmentMatches"].append({"path": str(path.relative_to(root)), "longest": longest})
            except OSError:
                out["unreadable"].append(str(path.relative_to(root)))
        return out

    def sample():
        try:
            while not stop.is_set():
                data = subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,args="])
                samples["count"] += 1
                samples["fullMatches"] += sum(data.count(value) for value in patterns.values())
                samples["fragmentMatches"] += int(any(secret[i:i + 8] in data for i in range(len(secret) - 7)))
                if runner_pid and re.search(rb"^\s*" + str(runner_pid).encode() + rb"\s", data, re.M):
                    samples["runnerSamples"] += 1
                stop.wait(0.05)
        except Exception as error:
            sample_errors.append(type(error).__name__)

    thread = threading.Thread(target=sample)
    try:
        receipt["memoryBeforeBoot"] = {"swap": run(["sysctl", "vm.swapusage"]).decode().strip(), "pressure": run(["memory_pressure"]).decode().splitlines()[-1]}
        version = json.loads((ROOT / "packages/cli/dist/node_modules/agent-device/package.json").read_text())["version"]
        if version != "0.21.25":
            raise RuntimeError("pinned version mismatch")
        run(["sh", "packages/cli/prototypes/ios/private-text/build.sh", work])
        udid = run(["xcrun", "simctl", "create", "contingency-ios-private-text-546", "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "com.apple.CoreSimulator.SimRuntime.iOS-26-5"]).decode().strip()
        receipt["simulator"] = {"udid": udid, "runtime": "iOS 26.5", "deviceType": "iPhone 17 Pro", "createdAt": now(), "stop": "simctl shutdown UDID; simctl delete UDID"}
        run(["xcrun", "simctl", "boot", udid])
        run(["xcrun", "simctl", "bootstatus", udid, "-b"])
        run(["xcrun", "simctl", "install", udid, work / "PrivateTextFixture.app"])
        (work / "open.json").write_bytes(run(CLI + ["open", BUNDLE, "--platform", "ios", "--udid", udid, "--session", SESSION, "--json", "--debug"]))
        daemon = json.loads((work / "state/daemon.json").read_text())
        receipt["resources"].append({"kind": "daemon", "pid": daemon["pid"], "port": daemon["port"], "startTime": daemon["processStartTime"], "stop": "pinned agent-device daemon stop --clean with owned state directory"})
        processes = run(["ps", "-axo", "pid=,ppid=,lstart=,args="]).decode()
        for line in processes.splitlines():
            if udid in line and "xcodebuild test-without-building" in line:
                runner_pid = int(line.split()[0])
                match = re.search(r"-xctestrun (.+?) -derivedDataPath", line)
                if match:
                    plist = Path(match.group(1))
                    runner_port = int(plist.stem.rsplit("-", 1)[1])
                    # These env plists are owned by the daemon PID and simulator.
                    owned.extend([plist, plist.with_suffix(".json")])
                receipt["resources"].append({"kind": "xcodebuild", "pid": runner_pid, "port": runner_port, "startTime": " ".join(line.split()[2:7]), "stop": "agent-device close and daemon stop --clean"})
        before = json.loads(run(CLI + ["snapshot", "-i", "--session", SESSION, "--json"]))
        target = next(n["ref"] for n in before["data"]["nodes"] if n.get("identifier") == "private-password" and n.get("type") == "SecureTextField")
        receipt["captureStartedAt"] = now()
        for name, args in [("host-unified", ["/usr/bin/log", "stream"]), ("sim-unified", ["xcrun", "simctl", "spawn", udid, "log", "stream"])]:
            directory = work / name
            directory.mkdir()
            output = open(directory / "stream.ndjson", "wb")
            args += ["--style", "ndjson", "--level", "debug"]
            p = subprocess.Popen(args, env=env, stdout=output, stderr=output, start_new_session=True)
            captures.append((p, output))
            receipt["resources"].append({"kind": name, "pid": p.pid, "startedAt": now(), "command": args, "stop": "SIGINT owned process group and wait"})
        thread.start()
        sentinel = work / "sentinel"
        with os.fdopen(os.open(sentinel, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(secret)
        request = {"token": daemon["token"], "command": "fill", "session": SESSION, "positionals": ["@" + target, sentinel.read_text()], "flags": {"debug": True}, "meta": {"requestId": "ios546-private-fill"}}
        with socket.create_connection(("127.0.0.1", daemon["port"]), timeout=180) as connection:
            connection.sendall(json.dumps(request).encode() + b"\n")
            with connection.makefile("rb") as stream:
                for line in stream:
                    parsed = json.loads(line)
                    if "ok" in parsed:
                        (work / "fill-response.ndjson").write_bytes(line)
                        receipt["fill"] = {"ok": parsed["ok"], "responseContainsSentinel": secret in line}
                        break
        container = Path(run(["xcrun", "simctl", "get_app_container", udid, BUNDLE, "data"]).decode().strip())
        readback = json.loads((container / "Documents/readback.json").read_text())
        receipt["readback"] = {**readback, "exactHashMatches": readback["sha256"] == receipt["sentinel"]["sha256"], "exactLengthMatches": readback["length"] == len(secret), "method": "fixture hashes actual UITextField.text on editingChanged"}
        snapshot = json.loads(run(CLI + ["snapshot", "-i", "--session", SESSION, "--json"]))
        receipt["secureSnapshot"] = [{"type": n["type"], "valueLength": len(n.get("value", "")), "valueIsMask": set(n.get("value", "")) <= {"•", "●", "*"}} for n in snapshot["data"]["nodes"] if n.get("type") == "SecureTextField"]
        receipt["channels"]["fixtureContainer"] = scan(container)
        receipt["memoryDuringRun"] = {"swap": run(["sysctl", "vm.swapusage"]).decode().strip(), "pressure": run(["memory_pressure"]).decode().splitlines()[-1]}
    except Exception as error:
        receipt["failure"] = type(error).__name__
    finally:
        stop.set()
        if thread.is_alive():
            thread.join()
        receipt["processArguments"] = {**samples, "samplingErrors": sample_errors}
        for p, output in captures:
            try:
                os.killpg(p.pid, signal.SIGINT)
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
            finally:
                output.close()
        if daemon is None and (work / "state/daemon.json").exists():
            daemon = json.loads((work / "state/daemon.json").read_text())
        if daemon:
            for args, name in [(["close", "--session", SESSION, "--json"], "sessionClose"), (["daemon", "stop", "--clean", "--json"], "daemonStop")]:
                try:
                    receipt["cleanup"][name] = json.loads(run(CLI + args))
                except Exception as error:
                    receipt["cleanup"][name] = {"failure": type(error).__name__}
        if udid:
            start = receipt.get("captureStartedAt", receipt["startedAt"])[:19].replace("T", " ") + "+0000"
            end = now()[:19].replace("T", " ") + "+0000"
            for name, prefix in [("host-persisted", ["/usr/bin/log", "show"]), ("sim-persisted", ["xcrun", "simctl", "spawn", udid, "log", "show"])]:
                directory = work / name
                directory.mkdir()
                try:
                    (directory / "show.ndjson").write_bytes(run(prefix + ["--start", start, "--end", end, "--style", "ndjson", "--info", "--debug"], 60))
                except Exception as error:
                    receipt["channels"][name] = {"failure": type(error).__name__}
            # Identify result ownership using the simulator UUID in diagnostics,
            # not the shared cache name or directory modification time.
            runner_root = Path.home() / ".agent-device/apple-runner"
            for path in runner_root.rglob("*.xcresult"):
                if any(udid in str(p) for p in path.glob("Staging/1_Test/Diagnostics/*")):
                    results.append(path)
                    receipt["channels"]["ownedXcresult"] = scan(path)
                    receipt["xcresultExport"] = {}
                    for kind in ["console", "action"]:
                        p = subprocess.run(["xcrun", "xcresulttool", "get", "log", "--path", str(path), "--type", kind], capture_output=True)
                        receipt["xcresultExport"][kind] = {"exitCode": p.returncode, "rootIdMissing": b"root ID is missing" in p.stderr}
            roots = {"simulatorLogs": Path.home() / "Library/Logs/CoreSimulator" / udid, "simulatorDiagnostics": Path.home() / "Library/Developer/CoreSimulator/Devices" / udid / "data/Library/Logs", "hostDiagnosticReports": Path.home() / "Library/Logs/DiagnosticReports", "systemDiagnosticReports": Path("/Library/Logs/DiagnosticReports"), "contingencyProject": ROOT / ".contingency", "contingencyHome": Path.home() / ".contingency"}
            for name, root in roots.items():
                receipt["channels"][name] = scan(root)
            for name in ["host-unified", "sim-unified", "host-persisted", "sim-persisted", "state"]:
                receipt["channels"][name] = scan(work / name)
            receipt["channels"]["ownedWork"] = scan(work)
            for operation in ["shutdown", "delete"]:
                try:
                    run(["xcrun", "simctl", operation, udid])
                    receipt["cleanup"]["simulator" + operation.title()] = True
                except Exception as error:
                    receipt["cleanup"]["simulator" + operation.title()] = type(error).__name__
            receipt["cleanup"]["simulatorAbsent"] = udid.encode() not in run(["xcrun", "simctl", "list", "devices", "--json"])
        for path in results + owned:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        receipt["cleanup"]["ownedResultBundlesRemoved"] = len(results)
        for resource in receipt["resources"]:
            resource["exited"] = subprocess.run(["ps", "-p", str(resource["pid"])], capture_output=True).returncode != 0
            if resource.get("port"):
                resource["portClosed"] = subprocess.run(["lsof", "-nP", "-iTCP:" + str(resource["port"]), "-sTCP:LISTEN"], capture_output=True).returncode != 0
        shutil.rmtree(work)
        receipt["cleanup"]["temporaryDirectoryRemoved"] = not work.exists()
        receipt["endedAt"] = now()
        destination.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"evidence": str(destination), "fill": receipt.get("fill"), "exactReadback": receipt.get("readback", {}).get("exactHashMatches"), "failure": receipt.get("failure")}))
    if receipt.get("failure") or not all(r["exited"] for r in receipt["resources"]) or (udid and not receipt["cleanup"].get("simulatorAbsent")):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
