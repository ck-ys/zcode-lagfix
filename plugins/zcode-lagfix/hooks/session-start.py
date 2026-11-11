#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-lagfix SessionStart hook。

流程：stdin 消费 → optout 检查 → 同步运行时文件到 ~/.zcode/zcode-lagfix/ →
幂等安装检查（已注入即短路）→ 未注入则静默安装。
stdout 只输出 hook 协议 JSON（失败也不抛异常，不影响会话）；
patch_install 内部 [lagfix] 提示全部重定向进缓冲，绝不污染 stdout。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
sys.path.insert(0, str(PLUGIN_ROOT))
import patch_install as pi  # noqa: E402

RUNTIME_FILES = ["lagfix-main.cjs", "lagfix-observe.js",
                 "install_monitor.py", "lagfix_report.py", "patch_install.py"]


def consume_stdin(timeout_s: float = 2.0) -> None:
    """消费 hook 的 stdin JSON（可能没有输入；2s 超时线程防卡死）。"""
    box = {"done": False}

    def reader():
        try:
            sys.stdin.read()
        except Exception:
            pass
        box["done"] = True

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    t.join(timeout_s)


def same_bytes(a: Path, b: Path) -> bool:
    try:
        return a.read_bytes() == b.read_bytes()
    except OSError:
        return False


def sync_runtime() -> None:
    dest_dir = pi.DATA_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    pi.sweep_tmp(dest_dir)
    for name in RUNTIME_FILES:
        src = PLUGIN_ROOT / name
        dst = dest_dir / name
        if src.is_file() and not (dst.exists() and same_bytes(src, dst)):
            # 原子替换：hook 在 ZCode 运行中执行，就地 copy2 可能让正在注入的
            # 窗口读到半个 lagfix-observe.js（语法预检失败 → 该窗口不生效）。
            pi._atomic_copy(src, dst)


def ensure_monitor(asar) -> None:
    """兜底：存在待收尾包却没人值守时，重新拉起 monitor。

    值守进程可能因重启/权限/被杀而丢失。每次 SessionStart 都补一次，
    让它在下一次 ZCode 全退时完成替换。已值守时 monitor 内部有单实例锁，
    重复拉起会立刻自退，无副作用。
    """
    try:
        tmp = asar.parent / pi.TMP_NAME
        sidecar = asar.parent / pi.SIDECAR_NAME
        if tmp.exists() and sidecar.exists():
            pi._launch_monitor(asar)
    except Exception:
        pass


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    consume_stdin()

    # patch_install 的 [lagfix] 提示全部吞进缓冲，stdout 只允许出现最后的 "{}"
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            if pi.OPTOUT_MARKER.exists():
                # 用户执行过卸载：保持静默跳过，但留下可排查的记录。
                # 直接重装却"没反应"时，看 hook-error.log 就能知道是豁免标记。
                _log_error(
                    "optout marker present; skip install. "
                    f"delete {pi.OPTOUT_MARKER} to reinstall"
                )
            else:
                sync_runtime()
                pi.set_runtime(pi.DATA_DIR)

                try:
                    asar = pi.resolve_target()
                except SystemExit:
                    # 找不到 asar：静默（hook 输出只留诊断日志，不干扰会话）
                    asar = None

                if asar is not None:
                    pi.set_target(asar)
                    status = pi.injected_status(asar)
                    if not (status["present"] == 1 and status["current"]):
                        result = pi.install()
                        if result not in ("installed", "already", "pending", "optout"):
                            # 失败只写日志文件，不往 stdout 吐噪音
                            _log_error(f"install={result}")
                        elif result == "pending":
                            # 本次已重新拉起 monitor，此处无需再补
                            pass
                    else:
                        # 已注入：仅做事后兜底——有待收尾包但值守进程可能已丢失
                        ensure_monitor(asar)
        except Exception as e:
            _log_error(f"hook exception: {e!r}")
    print("{}")


def _log_error(msg: str) -> None:
    try:
        pi.DATA_DIR.mkdir(parents=True, exist_ok=True)
        import time as _t
        with open(pi.DATA_DIR / "hook-error.log", "a", encoding="utf-8") as f:
            f.write(f"{_t.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


if __name__ == "__main__":
    main()
