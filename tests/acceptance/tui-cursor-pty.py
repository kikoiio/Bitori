#!/usr/bin/env python3
"""Run Ink's real prompt component in a Linux PTY and inspect its cursor CSI."""

from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHILD = os.path.join(ROOT, "tests", "acceptance", "tui-cursor-pty-child.mjs")
CURSOR = re.compile(rb"\x1b\[(\d+)A\x1b\[(\d+)G")
CSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def run_case(value: str, expected: tuple[int, int]) -> None:
    pid, master = pty.fork()
    if pid == 0:
        env = os.environ.copy()
        # GitHub Actions sets CI=true, which makes Ink suppress interactive cursor movement even with a PTY.
        env.pop('CI', None)
        env.pop('GITHUB_ACTIONS', None)
        env["TERM"] = "xterm-256color"
        env["COLUMNS"] = "40"
        env["LINES"] = "12"
        env["CURSOR_VALUE"] = value
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 40, 0, 0))
        node = shutil.which("node")
        if node is None:
            os._exit(127)
        os.execve(node, [node, "--import", "tsx", CHILD], env)

    output = bytearray()
    deadline = time.monotonic() + 10
    status = None
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass
            done, candidate = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = candidate
                while True:
                    ready, _, _ = select.select([master], [], [], 0)
                    if not ready:
                        break
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
                break
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            raise TimeoutError(f"PTY child did not exit for value {value!r}")
        if status is None:
            raise RuntimeError(f"PTY child exit status was unavailable: {output.decode(errors='replace')}")
        exit_code = os.waitstatus_to_exitcode(status)
        if exit_code != 0:
            raise RuntimeError(f"PTY child exited with {exit_code}: {output.decode(errors='replace')}")
    finally:
        os.close(master)

    positions = [(int(up), int(column)) for up, column in CURSOR.findall(output)]
    if expected not in positions:
        raise AssertionError(f"value={value!r}: expected terminal movement {expected}, saw {positions}; output={output.decode(errors='replace')}")
    rows = [line.strip() for line in CSI.sub(b"", output).decode(errors="replace").splitlines() if line.strip()]
    if len(rows) < 2 or not rows[0].startswith("─") or not rows[1].startswith(f"❯ {value}▌"):
        raise AssertionError(f"value={value!r}: unexpected rendered prompt rows {rows}")
    target_row = len(rows) + 1 - expected[0]
    if target_row != 2:
        raise AssertionError(f"value={value!r}: cursor reached row {target_row}, expected input row 2")
    print(f"value={value!r}: PTY cursor reached input row {target_row}, column {expected[1]}")


def main() -> int:
    run_case("hello", (4, 9))
    run_case("你好", (4, 8))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"TUI PTY cursor acceptance failed: {error}", file=sys.stderr)
        raise SystemExit(1)
