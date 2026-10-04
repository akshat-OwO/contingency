#!/usr/bin/env python3
"""Hold an interactive coding-agent TUI in a pseudo-terminal for verification.

`contingency start` hands the terminal to Claude Code or Codex. A proof that
spans several user turns needs that same interactive process to stay alive,
because its MCP child owns the browser and Workspace. This helper runs the
command in a pty, answers the terminal queries a TUI sends at startup, logs
raw output, and accepts keystrokes through a FIFO.

  agent-pty.py start --dir DIR --cwd CWD [--env K=V ...] -- COMMAND...
  agent-pty.py send --dir DIR --text "message" [--no-enter]
  agent-pty.py keys --dir DIR ENTER|ESC|UP|DOWN|TAB|CTRL_C ...
  agent-pty.py tail --dir DIR [--bytes N]
  agent-pty.py stop --dir DIR

Read agent turns from the agent's own transcript (Codex rollouts under
CODEX_HOME/sessions, Claude transcripts under its projects directory) rather
than from the screen.
"""

import argparse
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import time
import fcntl
import termios

ROWS, COLS = 50, 160

KEYS = {
    "ENTER": b"\r",
    "ESC": b"\x1b",
    "UP": b"\x1b[A",
    "DOWN": b"\x1b[B",
    "RIGHT": b"\x1b[C",
    "LEFT": b"\x1b[D",
    "TAB": b"\t",
    "CTRL_C": b"\x03",
    "CTRL_D": b"\x04",
}

# Replies to the queries crossterm and ink send while they initialize. Without
# them a TUI waits for a terminal that never answers.
QUERIES = [
    (re.compile(rb"\x1b\[6n"), b"\x1b[1;1R"),
    (re.compile(rb"\x1b\[0?c"), b"\x1b[?62;22c"),
    (re.compile(rb"\x1b\[\?u"), b"\x1b[?0u"),
    (re.compile(rb"\x1b\]10;\?(?:\x07|\x1b\\)"), b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
    (re.compile(rb"\x1b\]11;\?(?:\x07|\x1b\\)"), b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
    (re.compile(rb"\x1b\[14t"), b"\x1b[4;1000;1600t"),
    (re.compile(rb"\x1b\[\?(\d+)\$p"), None),
]


def paths(directory):
    return {
        "fifo": os.path.join(directory, "input.fifo"),
        "log": os.path.join(directory, "output.log"),
        "state": os.path.join(directory, "state.json"),
    }


def answer_queries(chunk, fd):
    for pattern, reply in QUERIES:
        for match in pattern.finditer(chunk):
            if reply is None:
                mode = match.group(1)
                os.write(fd, b"\x1b[?" + mode + b";2$y")
            else:
                os.write(fd, reply)


def run_daemon(args):
    files = paths(args.dir)
    env = dict(os.environ)
    for pair in args.env or []:
        key, _, value = pair.partition("=")
        env[key] = value
    env.setdefault("TERM", "xterm-256color")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(args.cwd)
        os.execvpe(args.command[0], args.command, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    with open(files["state"], "w") as state:
        json.dump({"childPid": pid, "daemonPid": os.getpid()}, state)
    control = os.open(files["fifo"], os.O_RDWR | os.O_NONBLOCK)
    with open(files["log"], "ab") as log:
        while True:
            readable, _, _ = select.select([fd, control], [], [], 0.5)
            if fd in readable:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                log.write(chunk)
                log.flush()
                answer_queries(chunk, fd)
            if control in readable:
                data = os.read(control, 65536)
                if data:
                    os.write(fd, data)
            finished, _ = os.waitpid(pid, os.WNOHANG)
            if finished:
                break
    os.close(control)
    with open(files["state"]) as state:
        recorded = json.load(state)
    recorded["exitedAt"] = time.time()
    with open(files["state"], "w") as state:
        json.dump(recorded, state)


def start(args):
    os.makedirs(args.dir, exist_ok=True)
    files = paths(args.dir)
    if not os.path.exists(files["fifo"]):
        os.mkfifo(files["fifo"])
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            devnull = os.open(os.devnull, os.O_RDWR)
            for stream in (0, 1, 2):
                os.dup2(devnull, stream)
            run_daemon(args)
        os._exit(0)
    for _ in range(50):
        if os.path.exists(files["state"]):
            print(open(files["state"]).read())
            return
        time.sleep(0.1)
    sys.exit("The agent did not start.")


def write(directory, data):
    # Opening a FIFO with no reader would block forever once the agent exits.
    try:
        fd = os.open(paths(directory)["fifo"], os.O_WRONLY | os.O_NONBLOCK)
    except OSError:
        sys.exit("The agent has exited; nothing is reading its input.")
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def send(args):
    # Typing and Enter are sent separately: a TUI that sees a paste followed
    # immediately by Enter can treat the Enter as part of the paste.
    write(args.dir, args.text.encode())
    if not args.no_enter:
        time.sleep(0.4)
        write(args.dir, b"\r")


def keys(args):
    for name in args.keys:
        write(args.dir, KEYS[name])
        time.sleep(0.2)


ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]")


def tail(args):
    data = open(paths(args.dir)["log"], "rb").read()[-args.bytes :]
    text = ANSI.sub(b"", data).decode("utf-8", "replace")
    print(re.sub(r"[ \t]{2,}", " ", text))


def stop(args):
    state = json.load(open(paths(args.dir)["state"]))
    for key in ("childPid", "daemonPid"):
        try:
            os.kill(state[key], signal.SIGTERM)
        except ProcessLookupError:
            pass


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="action", required=True)
    start_parser = commands.add_parser("start")
    start_parser.add_argument("--dir", required=True)
    start_parser.add_argument("--cwd", required=True)
    start_parser.add_argument("--env", action="append")
    start_parser.add_argument("command", nargs=argparse.REMAINDER)
    send_parser = commands.add_parser("send")
    send_parser.add_argument("--dir", required=True)
    send_parser.add_argument("--text", required=True)
    send_parser.add_argument("--no-enter", action="store_true")
    keys_parser = commands.add_parser("keys")
    keys_parser.add_argument("--dir", required=True)
    keys_parser.add_argument("keys", nargs="+", choices=sorted(KEYS))
    tail_parser = commands.add_parser("tail")
    tail_parser.add_argument("--dir", required=True)
    tail_parser.add_argument("--bytes", type=int, default=6000)
    stop_parser = commands.add_parser("stop")
    stop_parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    if args.action == "start":
        if args.command and args.command[0] == "--":
            args.command = args.command[1:]
        start(args)
    else:
        {"send": send, "keys": keys, "tail": tail, "stop": stop}[args.action](args)


if __name__ == "__main__":
    main()
