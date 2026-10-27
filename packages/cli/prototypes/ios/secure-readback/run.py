#!/usr/bin/env python3
"""Live proof for Simulator HID entry and in-process exact readback.

Run from the repository root with the path to a sanitized receipt. For each runtime
the driver creates one disposable simulator, boots it, installs the fixture, and
runs a positive and a wrong-value case for a UIKit and a SwiftUI secure field.
The value enters hid-type through stdin. The comparator in the app returns only a
verdict file. The receipt keeps hashes, lengths, verdicts, counts, and ownership.
It never records the value or any fragment of it.
"""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import string
import subprocess
import sys
import tempfile
import threading
import time

PROTO = Path(__file__).resolve().parent
BUNDLE = "dev.contingency.secure-readback-fixture"
DEVICE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
# iOS 27.1 supports only iPhone Duo in this Xcode; iPhone 17 Pro is refused there.
RUNTIMES = {"26.5": ("com.apple.CoreSimulator.SimRuntime.iOS-26-5", "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"), "27.1": ("com.apple.CoreSimulator.SimRuntime.iOS-27-1", "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo")}
FIELDS = ["uikit", "swiftui"]
ALPHABET = string.ascii_letters + string.digits
WINDOW = 8
OVERLAP = 64
CHUNK = 4 << 20


def now():
    return datetime.datetime.now(datetime.UTC).isoformat()


def utc_log_time(stamp):
    return stamp[:19].replace("T", " ") + "+0000"


def make_value():
    while True:
        value = "".join(secrets.choice(ALPHABET) for _ in range(32))
        if any(c.islower() for c in value) and any(c.isupper() for c in value) and any(c.isdigit() for c in value):
            return value


def wrong_value(value):
    # Same length, one different character at the end.
    return value[:-1] + ("B" if value[-1] != "B" else "C")


def needles_for(values):
    full, windows = set(), set()
    for value in values:
        raw = value.encode()
        full.update({raw, value.encode("utf-16le"), base64.b64encode(raw)})
        windows.update(raw[i:i + WINDOW] for i in range(len(raw) - WINDOW + 1))
    return sorted(full), sorted(windows)


def scan_path(path, full, windows):
    result = {"bytes": 0, "fullValue": False, "fragment": False}
    tail = b""
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            result["bytes"] += len(chunk)
            data = tail + chunk
            if not result["fullValue"]:
                result["fullValue"] = any(n in data for n in full)
            if not result["fragment"]:
                result["fragment"] = any(n in data for n in windows)
            tail = data[-OVERLAP:]
    return result


def scan_tree(root, full, windows):
    summary = {"exists": root.exists(), "files": 0, "bytes": 0, "fullValueFiles": [], "fragmentFiles": [], "unreadable": 0}
    if not root.exists():
        return summary
    for directory, _, names in os.walk(root):
        for name in names:
            path = Path(directory, name)
            if path.is_symlink() or not path.is_file():
                continue
            try:
                result = scan_path(path, full, windows)
            except OSError:
                summary["unreadable"] += 1
                continue
            summary["files"] += 1
            summary["bytes"] += result["bytes"]
            relative = str(path.relative_to(root))
            if result["fullValue"]:
                summary["fullValueFiles"].append(relative)
            if result["fragment"]:
                summary["fragmentFiles"].append(relative)
    return summary


def scan_tree_recent(root, since, full, windows):
    # Only files changed since the run started. Keeps shared host diagnostics bounded.
    summary = {"exists": root.exists(), "files": 0, "bytes": 0, "fullValueFiles": [], "fragmentFiles": [], "unreadable": 0}
    if not root.exists():
        return summary
    try:
        entries = list(root.iterdir())
    except OSError:
        summary["unreadable"] += 1
        return summary
    for path in entries:
        try:
            if not path.is_file() or path.stat().st_mtime < since:
                continue
            result = scan_path(path, full, windows)
        except OSError:
            summary["unreadable"] += 1
            continue
        summary["files"] += 1
        summary["bytes"] += result["bytes"]
        if result["fullValue"]:
            summary["fullValueFiles"].append(path.name)
        if result["fragment"]:
            summary["fragmentFiles"].append(path.name)
    return summary


def scan_bytes(data, full, windows):
    return {"bytes": len(data), "fullValue": any(n in data for n in full), "fragment": any(n in data for n in windows)}


class Sampler(threading.Thread):
    """Samples host process arguments only. Environment is not sampled."""

    def __init__(self, full, windows):
        super().__init__(daemon=True)
        self.full, self.windows = full, windows
        self.stop_event = threading.Event()
        self.samples = self.fullValueSamples = self.fragmentSamples = self.errors = 0

    def run(self):
        while not self.stop_event.is_set():
            try:
                data = subprocess.check_output(["ps", "-axo", "pid=,args="])
                self.samples += 1
                self.fullValueSamples += int(any(n in data for n in self.full))
                self.fragmentSamples += int(any(n in data for n in self.windows))
            except (subprocess.SubprocessError, OSError):
                self.errors += 1
            self.stop_event.wait(0.05)

    def result(self):
        return {"samples": self.samples, "fullValueSamples": self.fullValueSamples, "fragmentSamples": self.fragmentSamples, "samplingErrors": self.errors}


def alive(pid):
    return subprocess.run(["ps", "-p", str(pid)], capture_output=True).returncode == 0


def developer_dir():
    return subprocess.check_output(["xcode-select", "-p"]).decode().strip()


def main():
    destination = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="contingency-secure-readback-"))
    os.chmod(work, 0o700)
    out = work / "out"
    out.mkdir(mode=0o700)
    value = make_value()
    wrong = wrong_value(value)
    full, windows = needles_for([value, wrong])
    expected = {"sha256": hashlib.sha256(value.encode()).hexdigest(), "length": len(value)}
    started_at = now()
    since = datetime.datetime.fromisoformat(started_at).timestamp()
    receipt = {"startedAt": started_at, "issue": 549, "bundle": BUNDLE, "device": DEVICE, "value": {"length": len(value), "alphabet": "ASCII letters and digits, mixed case"}, "runs": [], "simulators": [], "channels": {}, "cleanup": {}}
    receipt["host"] = {"xcode": subprocess.check_output(["xcodebuild", "-version"]).decode().split()[1], "macOS": subprocess.check_output(["sw_vers", "-productVersion"]).decode().strip(), "swapBefore": subprocess.check_output(["sysctl", "vm.swapusage"]).decode().strip()}
    live = []  # Popen children this run owns; each is killed by pid handle only.
    fixture_pids = []  # (pid, udid) pairs whose ownership is re-checked before signalling.
    sims = []
    sampler = None
    try:
        booted = subprocess.check_output(["xcrun", "simctl", "list", "devices", "booted"]).decode()
        if "(Booted)" in booted:
            raise RuntimeError("another simulator is booted; not touching it")
        subprocess.run(["sh", str(PROTO / "build.sh"), str(work)], check=True, cwd=PROTO.parents[4], capture_output=True)
        dev = developer_dir()
        hid = str(work / "hid-type")
        dylib = str(work / "readback.dylib")
        expectation = work / "expectation.json"
        expectation.write_bytes(json.dumps(expected).encode())
        os.chmod(expectation, 0o600)
        for version, (runtime_id, device_type) in RUNTIMES.items():
            udid = subprocess.check_output(["xcrun", "simctl", "create", "contingency-secure-readback-" + version.replace(".", "-"), device_type, runtime_id]).decode().strip()
            sims.append(udid)
            entry = {"runtime": version, "deviceType": device_type, "udid": udid, "createdAt": now()}
            receipt["simulators"].append(entry)
            subprocess.run(["xcrun", "simctl", "boot", udid], check=True, capture_output=True)
            subprocess.run(["xcrun", "simctl", "bootstatus", udid, "-b"], check=True, capture_output=True, timeout=900)
            subprocess.run(["xcrun", "simctl", "install", udid, str(work / "SecureReadbackFixture.app")], check=True, capture_output=True)
            entry["bootedAt"] = now()
            for field in FIELDS:
                for mode in ["positive", "wrong"]:
                    typed = value if mode == "positive" else wrong
                    run = {"runtime": version, "field": field, "mode": mode, "expectedSha256": expected["sha256"], "expectedLength": expected["length"], "typedSha256": hashlib.sha256(typed.encode()).hexdigest(), "typedLength": len(typed), "startedAt": now()}
                    for name in ["ready.json", "verdict.json"]:
                        (out / name).unlink(missing_ok=True)
                    env = dict(os.environ)
                    env.update({
                        "SIMCTL_CHILD_DYLD_INSERT_LIBRARIES": dylib,
                        "SIMCTL_CHILD_CONTINGENCY_READBACK_EXPECTATION": str(expectation),
                        "SIMCTL_CHILD_CONTINGENCY_READBACK_OUT_DIR": str(out),
                        "SIMCTL_CHILD_FIXTURE_FOCUS": field,
                    })
                    launch = subprocess.run(["xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE], env=env, capture_output=True, timeout=120)
                    if launch.returncode:
                        raise RuntimeError("launch failed")
                    app_pid = int(launch.stdout.decode().strip().rsplit(":", 1)[1])
                    fixture_pids.append((app_pid, udid))
                    deadline = time.time() + 30
                    while not (out / "ready.json").exists() and time.time() < deadline:
                        time.sleep(0.2)
                    run["ready"] = (out / "ready.json").exists()
                    if not run["ready"]:
                        raise RuntimeError("secure field never became first responder")
                    run_start = now()
                    streams = []
                    for name, args in [("hostStream", ["/usr/bin/log", "stream"]), ("simStream", ["xcrun", "simctl", "spawn", udid, "log", "stream"])]:
                        path = work / (name + ".ndjson")
                        handle = open(path, "wb")
                        process = subprocess.Popen(args + ["--style", "ndjson", "--level", "debug"], stdout=handle, stderr=handle, start_new_session=True)
                        live.append(process)
                        streams.append((name, process, handle, path))
                    sampler = Sampler(full, windows)
                    sampler.start()
                    helper = subprocess.Popen([hid, dev, udid], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    live.append(helper)
                    helper_out, helper_err = helper.communicate(input=typed.encode(), timeout=300)
                    live.remove(helper)
                    typed = None
                    run["helper"] = {"exitCode": helper.returncode, "output": json.loads(helper_out.decode()) if helper.returncode == 0 and helper_out else None}
                    run["helperOutputScan"] = {"stdout": scan_bytes(helper_out, full, windows), "stderr": scan_bytes(helper_err, full, windows)}
                    if helper.returncode:
                        raise RuntimeError("hid-type failed with exit " + str(helper.returncode))
                    time.sleep(1.0)
                    if "SecureReadbackFixture" not in ps_args(app_pid):
                        raise RuntimeError("fixture process ownership changed")
                    os.kill(app_pid, signal.SIGUSR1)
                    deadline = time.time() + 15
                    while not (out / "verdict.json").exists() and time.time() < deadline:
                        time.sleep(0.2)
                    if not (out / "verdict.json").exists():
                        raise RuntimeError("no verdict written")
                    verdict = json.loads((out / "verdict.json").read_text())
                    run.update({"verdict": verdict["verdict"], "reason": verdict["reason"], "fieldClass": verdict.get("fieldClass"), "fieldLength": verdict.get("fieldLength"), "fieldSha256": verdict.get("fieldSha256")})
                    run["fieldMatchesTyped"] = verdict.get("fieldSha256") == run["typedSha256"] and verdict.get("fieldLength") == len(typed_length_source(mode, value, wrong))
                    run["fieldMatchesExpected"] = verdict.get("fieldSha256") == expected["sha256"]
                    sampler.stop_event.set()
                    sampler.join()
                    run["processArguments"] = sampler.result()
                    subprocess.run(["xcrun", "simctl", "terminate", udid, BUNDLE], capture_output=True)
                    for name, process, handle, path in streams:
                        os.killpg(process.pid, signal.SIGINT)
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
                        live.remove(process)
                        handle.close()
                    run_end = now()
                    channels = {"hostStream": scan_path_list([streams[0][3]], full, windows), "simStream": scan_path_list([streams[1][3]], full, windows)}
                    for name, command in [("hostPersisted", ["/usr/bin/log", "show"]), ("simPersisted", ["xcrun", "simctl", "spawn", udid, "log", "show"])]:
                        path = work / (name + ".ndjson")
                        with open(path, "wb") as handle:
                            subprocess.run(command + ["--start", utc_log_time(run_start), "--end", utc_log_time(run_end), "--style", "ndjson", "--info", "--debug"], stdout=handle, stderr=subprocess.DEVNULL, timeout=300)
                        channels[name] = scan_path_list([path], full, windows)
                    for name, _, _, path in streams:
                        path.unlink(missing_ok=True)
                    (work / "hostPersisted.ndjson").unlink(missing_ok=True)
                    (work / "simPersisted.ndjson").unlink(missing_ok=True)
                    run["channels"] = channels
                    run["endedAt"] = run_end
                    receipt["runs"].append(run)
                    print(json.dumps({"runtime": version, "field": field, "mode": mode, "verdict": run["verdict"], "reason": run["reason"], "fieldMatchesTyped": run["fieldMatchesTyped"]}), flush=True)
            container = Path(subprocess.check_output(["xcrun", "simctl", "get_app_container", udid, BUNDLE, "data"]).decode().strip())
            device_root = Path.home() / "Library/Developer/CoreSimulator/Devices" / udid
            receipt["channels"][version] = {
                "appContainer": scan_tree(container, full, windows),
                "simulatorData": scan_tree(device_root / "data", full, windows),
                "coreSimulatorLogs": scan_tree(Path.home() / "Library/Logs/CoreSimulator" / udid, full, windows),
                "hostDiagnosticReportsSinceStart": scan_tree_recent(Path.home() / "Library/Logs/DiagnosticReports", since, full, windows),
                "systemDiagnosticReportsSinceStart": scan_tree_recent(Path("/Library/Logs/DiagnosticReports"), since, full, windows),
            }
            for operation in ["shutdown", "delete"]:
                subprocess.run(["xcrun", "simctl", operation, udid], capture_output=True)
            listing = subprocess.run(["xcrun", "simctl", "list", "devices", "--json"], capture_output=True).stdout.decode()
            entry["deleted"] = udid not in listing
            sims.remove(udid)
    except Exception as error:
        receipt["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if sampler is not None:
            sampler.stop_event.set()
            sampler.join(timeout=5)
        for process in live:
            if process.poll() is None:
                process.kill()
                process.wait()
        for pid, udid in fixture_pids:
            # Recheck the process name before signalling; the pid may have been reused.
            if "SecureReadbackFixture" in ps_args(pid):
                os.kill(pid, signal.SIGKILL)
        for udid in sims:
            subprocess.run(["xcrun", "simctl", "shutdown", udid], capture_output=True)
            subprocess.run(["xcrun", "simctl", "delete", udid], capture_output=True)
            receipt["cleanup"].setdefault("simulatorsDeletedAfterFailure", []).append(udid)
        receipt["cleanup"]["childProcessesExited"] = all(process.poll() is not None for process in live) if live else True
        receipt["cleanup"]["fixtureProcessesExited"] = all(not alive(pid) for pid, _ in fixture_pids)
        shutil.rmtree(work, ignore_errors=True)
        receipt["cleanup"]["workDirectoryRemoved"] = not work.exists()
        receipt["endedAt"] = now()
        destination.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"receipt": str(destination), "failure": receipt.get("failure"), "runs": len(receipt["runs"]), "cleanup": receipt["cleanup"]}), flush=True)


def typed_length_source(mode, value, wrong):
    return value if mode == "positive" else wrong


def scan_path_list(paths, full, windows):
    total = {"files": 0, "bytes": 0, "fullValueFiles": [], "fragmentFiles": [], "unreadable": 0, "exists": True}
    for path in paths:
        if not path.exists():
            continue
        try:
            result = scan_path(path, full, windows)
        except OSError:
            total["unreadable"] += 1
            continue
        total["files"] += 1
        total["bytes"] += result["bytes"]
        if result["fullValue"]:
            total["fullValueFiles"].append(path.name)
        if result["fragment"]:
            total["fragmentFiles"].append(path.name)
    return total


def ps_args(pid):
    return subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True).stdout


if __name__ == "__main__":
    main()
