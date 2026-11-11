#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""以管理员权限收尾同机上所有排队中的 asar 补丁（zusage + lagfix）。

为什么需要提权：ZCode 装在 Program Files 下时，resources/app.asar 的 ACL 只允许
管理员改写。目录本身可写（所以能把 366MB 的待收尾包写进去），但 os.replace
覆盖 app.asar 会被拒绝（WinError 5）。zusage 的补丁从 2026-10-22 一直挂着，
根因就是这个——值守进程跑在普通权限下，永远替换不了。

执行顺序（关键）：
  1. 先 zusage install --finalize：它基于当前 asar 剥离自己的行再追加，完成后
     asar 里含 zusage 行；
  2. 再 lagfix finalize：指纹失配 → 走"基于当前 asar 重打包"分支，把 lagfix 行
     一起带上。两行共存，用户只需重启一次。

用法（必须管理员）：
    python tools/finalize_all_admin.py
结果同时写到 ~/.zcode/zcode-lagfix/elevated-finalize.log
"""

from __future__ import annotations

import contextlib
import ctypes
import json
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
LOG = HOME / ".zcode" / "zcode-lagfix" / "elevated-finalize.log"

ZUSAGE_BASE = HOME / ".zcode" / "cli" / "plugins" / "cache" / "zusage-marketplace" / \
    "zcode-token-usage-statusbar"
ZUSAGE_RUNTIME = HOME / ".zcode" / "zcode-token-usage-statusbar"
# 脚本位于 <仓库>/tools/，插件源码在 <仓库>/plugins/zcode-lagfix/。
LAGFIX_DIR = Path(__file__).resolve().parent.parent / "plugins" / "zcode-lagfix"

sys.path.insert(0, str(LAGFIX_DIR))
import patch_install as pi  # noqa: E402


def resolve_asar() -> Path | None:
    """按 --asar → 运行时 config.json → 自动探测 的顺序找 app.asar。"""
    argv = sys.argv[1:]
    if "--asar" in argv:
        i = argv.index("--asar")
        if i + 1 < len(argv):
            candidate = Path(argv[i + 1])
            if candidate.is_file():
                return candidate
    cfg = HOME / ".zcode" / "zcode-lagfix" / "config.json"
    try:
        saved = json.loads(cfg.read_text("utf-8")).get("asar_path")
        if saved and Path(saved).is_file():
            return Path(saved)
    except (OSError, ValueError):
        pass
    try:
        return pi.find_asar()
    except Exception:
        return None


def find_zusage_dir() -> Path | None:
    """zusage 版本目录不写死：取缓存里带 patch_install.py 的最新版本。"""
    try:
        cands = [p for p in ZUSAGE_BASE.glob("*") if (p / "patch_install.py").is_file()]
    except OSError:
        return None
    if not cands:
        return None
    return max(cands, key=lambda p: p.stat().st_mtime)


ASAR = resolve_asar()
ZUSAGE_DIR = find_zusage_dir()


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with contextlib.suppress(OSError):
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def run(cmd: list, label: str) -> tuple[int, str]:
    log(f"--- {label} ---")
    log("cmd: " + " ".join(str(c) for c in cmd))
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=600,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:
        log(f"{label} 异常：{e}")
        return 1, str(e)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    for ln in out.splitlines()[-25:]:
        log("  " + ln)
    log(f"{label} 退出码={r.returncode}")
    return r.returncode, out


def zusage_pending() -> bool:
    if ASAR is None:
        return False
    asar_dir = ASAR.parent
    return (asar_dir / "app.asar.zusage.tmp").exists() and \
           (asar_dir / "app.asar.zusage.tmp.json").exists()


def main() -> int:
    log("=" * 60)
    log("lagfix 提权收尾开始")
    if not is_admin():
        log("❌ 不是管理员：请右键「以管理员身份运行」，或用 UAC 提权启动本脚本")
        return 2
    log("✓ 已获得管理员权限")

    if ASAR is None or not ASAR.is_file():
        log(f"❌ 找不到 app.asar：{ASAR}。请先运行 install.py，或用 --asar 指定路径")
        return 2

    # 1) zusage 先收尾
    if zusage_pending():
        if ZUSAGE_DIR is None:
            log("⚠ 找不到 zusage 版本目录，跳过")
        elif not (ZUSAGE_DIR / "patch_install.py").is_file():
            log(f"⚠ 找不到 zusage patch_install.py：{ZUSAGE_DIR}，跳过")
        else:
            run([sys.executable, str(ZUSAGE_DIR / "patch_install.py"),
                 "--asar", str(ASAR), "--runtime", str(ZUSAGE_RUNTIME),
                 "install", "--finalize"], "zusage install --finalize")
    else:
        log("zusage 无待收尾包，跳过")

    # 2) lagfix 后收尾（会基于含 zusage 行的当前 asar 重打包）
    rc, out = run([sys.executable, str(LAGFIX_DIR / "patch_install.py"),
                   "finalize", "--asar", str(ASAR)], "lagfix finalize")

    # 3) 最终校验：两行是否都在
    try:
        pi.set_target(ASAR)
        entry = pi.entry_bytes_of(ASAR)
        lag = pi.line_count(entry)
        zus = b"inject-main.cjs" in entry
        log(f"最终校验：lagfix 行={lag}，zusage 行={'有' if zus else '无'}")
        if lag == 1 and zus:
            log("✅ 两个补丁都已写入，重启 ZCode 即生效")
            return 0
        log("⚠ 校验结果不完整，见上文")
        return 1
    except Exception as e:
        log(f"最终校验失败：{e}")
        return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
