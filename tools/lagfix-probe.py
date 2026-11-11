#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-lagfix 外部响应探针（零修改、零注入、不改 app.asar）。

为什么需要它
------------
asar 注入版角标必须先完全退出 ZCode 才能生效。如果你现在就想看到数字，
这个探针从**进程外部**量同一件事：ZCode 渲染线程的消息泵还来不来得及处理消息。

原理
----
Windows 每个 GUI 线程有一个消息队列。UI 线程被渲染占满时，消息处理会被推迟。
用 SendMessageTimeout(WM_NULL) 打一个空消息进去并计时：
  - UI 线程空闲  → 几毫秒就回（消息泵立刻取走）
  - UI 线程繁忙  → 排队，回得慢；超过 100ms 人眼就能感觉到拖影
这就是系统判断"窗口无响应"(IsHungAppWindow) 用的同一条路径。
只发 WM_NULL（空消息，宿主收到后什么也不做），不读窗口内容、不注入、不改任何状态。

用法
----
    python lagfix-probe.py            # 每秒一行，Ctrl+C 结束
    python lagfix-probe.py --overlay  # 右下角常驻小窗（置顶、可拖动、点右键关闭）
    python lagfix-probe.py --once     # 只采 20 个样本就退出（自检/截图用）

判读
----
  P50 < 20ms      流畅
  P95 20~80ms     轻微掉帧
  P95 > 80ms      明显卡顿
  单次 > 500ms    卡死级别（等价于系统"无响应"）
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import statistics
import sys
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)

WM_NULL = 0x0000
SMTO_BLOCK = 0x0001
ERROR_TIMEOUT = 1460
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [("left", wt.LONG), ("top", wt.LONG),
                ("right", wt.LONG), ("bottom", wt.LONG)]


def _pids_of(names: tuple[str, ...]) -> set[int]:
    """按镜像名取 PID（走 CreateToolhelp32Snapshot，避免依赖 tasklist 文本）。"""
    TH32CS_SNAPPROCESS = 0x00000002

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD),
            ("th32ProcessID", wt.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
            ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", wt.LONG),
            ("dwFlags", wt.DWORD), ("szExeFile", ctypes.c_char * 260),
        ]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap in (0, ctypes.c_void_p(-1).value):
        return set()
    out: set[int] = set()
    try:
        e = PROCESSENTRY32()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = k32.Process32First(snap, ctypes.byref(e))
        while ok:
            name = e.szExeFile.decode("ascii", "replace").lower()
            if name in names:
                out.add(int(e.th32ProcessID))
            ok = k32.Process32Next(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return out


def zcode_windows() -> list[tuple[int, int, str, int]]:
    """返回 [(hwnd, pid, title, area)]，只含 ZCode.exe 的可见顶层窗口。"""
    pids = _pids_of(("zcode.exe",))
    if not pids:
        return []
    found: list[tuple[int, int, str, int]] = []

    def cb(hwnd, _lp):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            pid = wt.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value not in pids:
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            r = RECT()
            if not user32.GetClientRect(hwnd, ctypes.byref(r)):
                return True
            area = max(0, r.right - r.left) * max(0, r.bottom - r.top)
            if area < 40000:  # 过滤托盘/隐藏的小窗
                return True
            found.append((int(hwnd), int(pid.value), buf.value, area))
        except Exception:
            pass
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def probe_once(hwnd: int, timeout_ms: int = 1500) -> tuple[float, bool]:
    """发一个 WM_NULL 并计时。返回 (毫秒, 是否超时)。"""
    res = ctypes.c_size_t(0)
    t0 = time.perf_counter()
    ok = user32.SendMessageTimeoutW(hwnd, WM_NULL, 0, 0,
                                    SMTO_BLOCK, timeout_ms, ctypes.byref(res))
    dt = (time.perf_counter() - t0) * 1000.0
    if not ok:
        return float(timeout_ms), True
    return dt, False


def verdict(p50: float, p95: float, worst: float) -> tuple[str, str]:
    if worst >= 500:
        return "HANG", "卡死级别"
    if p95 > 80 or worst >= 200:
        return "LAG", "明显卡顿"
    if p95 > 20:
        return "WARN", "轻微掉帧"
    return "OK", "流畅"


def fmt_line(pick: tuple[int, int, str, int], samples: list[float],
             timeouts: int, tag: str) -> str:
    p50 = statistics.median(samples)
    s = sorted(samples)
    p95 = s[min(len(s) - 1, int(len(s) * 0.95))]
    worst = s[-1]
    code, text = verdict(p50, p95, worst)
    return (f"[{code}] {tag} {text}  "
            f"当前 {samples[-1]:6.1f}ms  P50 {p50:5.1f}  P95 {p95:6.1f}  "
            f"最差 {worst:6.1f}  超时 {timeouts}/{len(samples)}  "
            f"hWnd={pick[0]} pid={pick[1]}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="ZCode 外部响应探针（只发 WM_NULL，不注入）")
    ap.add_argument("--interval", type=float, default=1.0, help="采样间隔秒，默认 1.0")
    ap.add_argument("--window", type=int, default=60, help="滑动窗口样本数，默认 60")
    ap.add_argument("--overlay", action="store_true", help="显示右下角常驻置顶小窗")
    ap.add_argument("--once", type=int, default=0, help="采 N 个样本后退出")
    args = ap.parse_args()

    wins = zcode_windows()
    if not wins:
        print("[x] 没找到 ZCode 主窗口。确认 ZCode 正在运行（本探针只看已有窗口，不会启动它）。")
        return 2
    pick = max(wins, key=lambda w: w[3])
    print(f"[i] 目标窗口: {pick[2]!r} hWnd={pick[0]} pid={pick[1]} "
          f"（共 {len(wins)} 个可见窗口，取面积最大者）")
    print("[i] 只发送 WM_NULL 空消息计时，不注入、不读取窗口内容、不改任何文件。Ctrl+C 结束。")

    samples: list[float] = []
    timeouts = 0
    n = 0
    if args.overlay:
        return run_overlay(pick, args.interval, args.window)
    try:
        while True:
            dt, to = probe_once(pick[0])
            samples.append(dt)
            timeouts += 1 if to else 0
            if len(samples) > args.window:
                samples.pop(0)
            n += 1
            print(fmt_line(pick, samples, timeouts, time.strftime("%H:%M:%S")), flush=True)
            if args.once and n >= args.once:
                return 0
            time.sleep(max(0.05, args.interval))
    except KeyboardInterrupt:
        print("\n[i] 已停止。")
        return 0


def run_overlay(pick, interval: float, window: int) -> int:
    """右下角置顶小窗。左键拖动，右键关闭。Tk 缺失时回退到文本模式。"""
    try:
        import tkinter as tk
    except Exception as e:
        print(f"[!] 没有 tkinter（{e}），回退到文本模式。")
        args_interval, args_window = interval, window
        samples: list[float] = []
        timeouts = 0
        try:
            while True:
                dt, to = probe_once(pick[0])
                samples.append(dt)
                timeouts += 1 if to else 0
                if len(samples) > args_window:
                    samples.pop(0)
                print(fmt_line(pick, samples, timeouts, time.strftime("%H:%M:%S")), flush=True)
                time.sleep(max(0.05, args_interval))
        except KeyboardInterrupt:
            return 0

    samples: list[float] = []
    timeouts = 0

    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.88)
    except Exception:
        pass
    root.configure(bg="#111418")

    W, H = 268, 62
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    root.geometry(f"{W}x{H}+{sw - W - 16}+{sh - H - 56}")

    big = tk.Label(root, text="--", font=("Consolas", 20, "bold"),
                   fg="#7ee787", bg="#111418", anchor="w")
    big.pack(fill="x", padx=10, pady=(6, 0))
    small = tk.Label(root, text="等待采样…", font=("Microsoft YaHei", 8),
                     fg="#9aa4b2", bg="#111418", anchor="w")
    small.pack(fill="x", padx=10)

    drag = {"x": 0, "y": 0}

    def on_press(e):
        drag["x"], drag["y"] = e.x, e.y

    def on_drag(e):
        root.geometry(f"+{e.x_root - drag['x']}+{e.y_root - drag['y']}")

    for w in (root, big, small):
        w.bind("<Button-1>", on_press)
        w.bind("<B1-Motion>", on_drag)
        w.bind("<Button-3>", lambda _e: root.destroy())

    def tick():
        dt, to = probe_once(pick[0])
        samples.append(dt)
        nonlocal timeouts
        timeouts += 1 if to else 0
        if len(samples) > window:
            samples.pop(0)
        p50 = statistics.median(samples)
        s = sorted(samples)
        p95 = s[min(len(s) - 1, int(len(s) * 0.95))]
        worst = s[-1]
        code, text = verdict(p50, p95, worst)
        color = {"OK": "#7ee787", "WARN": "#e3b341", "LAG": "#ff7b72", "HANG": "#ff5c5c"}[code]
        big.configure(text=f"{samples[-1]:.0f} ms", fg=color)
        small.configure(text=f"{text} · P95 {p95:.0f} · 最差 {worst:.0f} · "
                             f"超时 {timeouts} · {pick[2][:18]}")
        root.after(max(50, int(interval * 1000)), tick)

    root.after(50, tick)
    print("[i] 小窗已显示在右下角（左键拖动，右键关闭）。")
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
