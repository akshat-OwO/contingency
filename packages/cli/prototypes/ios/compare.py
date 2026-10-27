"""Benchmark screenshots and finalized video on an already booted, owned simulator."""
import json
import os
import resource
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("Usage: compare.py SIMULATOR OUTPUT_DIRECTORY")
simulator, directory = sys.argv[1:]
base = Path(directory)
base.mkdir(parents=True, exist_ok=True)
result = {}
for kind in ("jpeg", "png"):
    durations, sizes = [], []
    start = time.monotonic()
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    for _ in range(30):
        shot_start = time.monotonic()
        path = base / f"sample.{kind}"
        subprocess.run(["xcrun", "simctl", "io", simulator, "screenshot",
                        "--display=primary", f"--type={kind}", str(path)],
                       capture_output=True, check=True, timeout=15)
        durations.append((time.monotonic() - shot_start) * 1000)
        sizes.append(path.stat().st_size)
    elapsed = time.monotonic() - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_seconds = after.ru_utime + after.ru_stime - usage.ru_utime - usage.ru_stime
    result[kind] = dict(frames=len(durations), elapsedSeconds=elapsed,
                        fps=len(durations) / elapsed, medianMs=statistics.median(durations),
                        p95Ms=sorted(durations)[int(len(durations) * .95)],
                        meanBytes=statistics.mean(sizes), childCpuPercent=cpu_seconds / elapsed * 100)
    print(kind, result[kind], flush=True)

video = base / "video.mp4"
with (base / "video.stderr").open("w") as stderr:
    process = subprocess.Popen(["xcrun", "simctl", "io", simulator, "recordVideo",
                                "--codec=h264", "--display=primary", "--force", str(video)],
                               stdout=subprocess.DEVNULL, stderr=stderr)
    recording = dict(pid=process.pid, startedUnix=time.time())
    try:
        # Fixed benchmark duration, not correctness synchronization.
        time.sleep(6)
        recording["processSample"] = subprocess.check_output(
            ["ps", "-p", str(process.pid), "-o", "pid=,ppid=,%cpu=,rss=,etime="], text=True).strip()
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "json", str(video)], capture_output=True, text=True, timeout=5)
        recording["beforeStop"] = dict(exit=probe.returncode, stderr=probe.stderr.strip(),
                                       stdout=probe.stdout.strip(), bytes=video.stat().st_size)
    finally:
        stop = time.monotonic()
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        recording.update(exit=process.returncode, stopToExitMs=(time.monotonic() - stop) * 1000)
recording["stderr"] = (base / "video.stderr").read_text()
recording["afterStop"] = json.loads(subprocess.check_output(
    ["ffprobe", "-v", "error", "-count_frames", "-show_entries",
     "stream=width,height,avg_frame_rate,nb_read_frames,duration", "-of", "json", str(video)], text=True))
result["recordVideo"] = recording
(base / "candidates.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(recording), flush=True)
