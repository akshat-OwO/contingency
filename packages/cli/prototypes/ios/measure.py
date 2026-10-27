"""Measure the prototype without device input or simulator lifecycle operations."""
import base64
import hashlib
import http.client
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time

if len(sys.argv) != 6:
    raise SystemExit("Usage: measure.py HELPER DEVELOPER_DIR SIMULATOR DISPLAY OUTPUT_JSON")
helper, developer, simulator, display, output = sys.argv[1:]
env = {**os.environ, "IOS_STREAM_TOKEN": secrets.token_hex(32)}
command = ["nub", "packages/cli/prototypes/ios/stream.ts", helper, developer, simulator, display]
process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
receipt = {"ownerPid": process.pid, "startUnix": time.time(), "frames": [], "psSamples": []}
connection = None
try:
    receipt["resources"] = info = json.loads(process.stdout.readline())
    port = info["port"]
    print(info, flush=True)
    probes = [
        ("missing", "GET", "/frames", {}),
        ("wrong", "GET", "/frames", {"Authorization": "wrong"}),
        ("device override", "GET", "/frames?device=other", {}),
        ("input", "GET", "/input", {}),
        ("host", "GET", "/frames", {"Host": "other.invalid"}),
        ("origin", "GET", "/frames", {"Origin": "https://other.invalid"}),
        ("upgrade", "GET", "/frames", {"Connection": "Upgrade", "Upgrade": "websocket"}),
        ("method", "POST", "/frames", {}),
    ]
    receipt["probes"] = []
    for label, method, path, headers in probes:
        auth = {} if label in ("missing", "wrong") else {"Authorization": env["IOS_STREAM_TOKEN"]}
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request(method, path, headers={**auth, **headers})
        response = connection.getresponse()
        receipt["probes"].append({"probe": label, "status": response.status})
        assert response.status == (401 if label in ("missing", "wrong") else 404)
        response.read()
        connection.close()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request("GET", "/frames", headers={"Authorization": env["IOS_STREAM_TOKEN"]})
    response = connection.getresponse()
    assert response.status == 200
    connection.sock.settimeout(0.3)
    try:
        receipt["beforeStartBytes"] = len(connection.sock.recv(1, socket.MSG_PEEK))
    except TimeoutError:
        receipt["beforeStartBytes"] = 0
    assert receipt["beforeStartBytes"] == 0
    connection.sock.settimeout(10)
    start = time.monotonic()
    process.stdin.write("start\n")
    process.stdin.flush()
    for line in response:
        frame = json.loads(line)
        jpeg = base64.b64decode(frame.pop("jpeg"), validate=True)
        assert jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9"
        frame.update(sha256=hashlib.sha256(jpeg).hexdigest(), bytes=len(jpeg),
                     receivedMs=(time.monotonic() - start) * 1000)
        receipt["frames"].append(frame)
        if len(receipt["frames"]) % 60 == 0:
            receipt["psSamples"].append(subprocess.check_output(
                ["ps", "-p", f"{info['helperPid']},{info['pid']}",
                 "-o", "pid=,ppid=,%cpu=,rss=,etime="], text=True).strip())
        # Fixed benchmark duration, not a correctness synchronization wait.
        if time.monotonic() - start >= 12:
            break
    stop = time.monotonic()
    process.stdin.write("stop\n")
    process.stdin.flush()
    receipt["postStopFrames"] = sum(1 for _ in response)
    process.stdin.close()
    process.wait(15)
    receipt.update(exit=process.returncode, stopToExitMs=(time.monotonic() - stop) * 1000)
    assert process.returncode == 0
    try:
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
        receipt["portClosed"] = False
    except OSError:
        receipt["portClosed"] = True
    try:
        os.kill(info["helperPid"], 0)
        receipt["helperExited"] = False
    except ProcessLookupError:
        receipt["helperExited"] = True
    assert receipt["portClosed"] and receipt["helperExited"]
finally:
    if connection:
        connection.close()
    if process.poll() is None:
        # Every child belongs to this explicitly created process group.
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    with open(output, "w") as file:
        json.dump(receipt, file, indent=2)
print({key: value for key, value in receipt.items() if key not in ("frames", "psSamples")})
print("frames", len(receipt["frames"]))
