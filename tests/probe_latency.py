#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 lagfix-probe 的度量方法真的能区分“空闲”和“UI 线程被占满”。

做法：在本进程里开一个 Tk 窗口（真实 Win32 窗口 + 消息泵），对比：
  A) 空闲：主线程在 mainloop 里空转 → WM_NULL 应个位数毫秒就回
  B) 忙：主线程在回调里死循环 1.2s，消息泵停摆 → WM_NULL 必须被拖住 ≈ 死循环时长
  C) 恢复：死循环结束后 ≤100ms 内回到正常

这条不成立，外部探针的所有读数都没有意义 —— 所以它是自动化测试。
"""

from __future__ import annotations

import ctypes
import importlib.util
import pathlib
import statistics
import sys
import threading
import time
import tkinter as tk

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("lagfix_probe", str(ROOT / "tools" / "lagfix-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

BUSY_S = 1.2
idle_samples: list[float] = []
busy_sample: list[float] = []
after_samples: list[float] = []
busy_started = threading.Event()
stop_worker = threading.Event()


def worker(hwnd: int) -> None:
    """在忙阶段从旁路线程发一个带 3s 超时的 WM_NULL，量它被拖多久。"""
    busy_started.wait(5.0)
    if stop_worker.is_set():
        return
    time.sleep(0.15)  # 确保主线程已经进死循环
    dt, timed_out = probe.probe_once(hwnd, timeout_ms=3000)
    busy_sample.append(dt if not timed_out else 3000.0)


def main() -> int:
    root = tk.Tk()
    root.title("lagfix-probe-selftest")
    root.geometry("260x90+60+60")
    root.update_idletasks()
    root.update()
    hwnd = int(ctypes.windll.user32.GetAncestor(int(root.winfo_id()), 2))  # GA_ROOT

    def sample(key: list[float], n: int) -> None:
        for _ in range(n):
            dt, _to = probe.probe_once(hwnd, timeout_ms=3000)
            key.append(dt)
            time.sleep(0.02)

    def phase_busy() -> None:
        busy_started.set()
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < BUSY_S:
            pass  # 占死 UI 线程
        root.after(10, phase_after)

    def phase_after() -> None:
        sample(after_samples, 6)
        root.after(50, root.destroy)

    def phase_idle() -> None:
        sample(idle_samples, 8)
        root.after(50, phase_busy)

    threading.Thread(target=worker, args=(hwnd,), daemon=True).start()
    root.after(150, phase_idle)
    root.mainloop()
    stop_worker.set()

    idle = statistics.median(idle_samples) if idle_samples else -1
    busy = busy_sample[0] if busy_sample else -1
    after = statistics.median(after_samples) if after_samples else -1
    print(f"idle  P50 = {idle:8.2f} ms   (n={len(idle_samples)})")
    print(f"busy        = {busy:8.2f} ms   (期望 ≈ {BUSY_S*1000:.0f}ms)")
    print(f"after P50 = {after:8.2f} ms   (n={len(after_samples)})")

    ok = True
    if not (0 <= idle < 50):
        print("[FAIL] 空闲时 WM_NULL 应 < 50ms")
        ok = False
    if not (BUSY_S * 1000 * 0.6 <= busy <= BUSY_S * 1000 + 400):
        print("[FAIL] 忙时 WM_NULL 应被拖住到接近死循环时长")
        ok = False
    if not (0 <= after < 100):
        print("[FAIL] 忙结束后应 < 100ms 内恢复")
        ok = False
    print("== probe_latency 结果：", "PASS" if ok else "FAIL", "==")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
