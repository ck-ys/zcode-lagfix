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
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
ASAR_DIR = Path(r"E:\Program Files\ZCode\resources")
ASAR = ASAR_DIR / "app.asar"
LOG = HOME / ".zcode" / "zcode-lagfix" / "elevated-finalize.log"

ZUSAGE_DIR = HOME / ".zcode" / "cli" / "plugins" / "cache" / "zusage-marketplace" / \
    "zcode-token-usage-statusbar" / "1.5.15"
ZUSAGE_RUNTIME = HOME / ".zcode" / "zcode-token-usage-statusbar"
LAGFIX_DIR = Path(r"D:\Git\git-github\zcode-lagfix\plugins\zcode-lagfix")

sys.path.insert(0, str(LAGFIX_DIR))


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
    return (ASAR_DIR / "app.asar.zusage.tmp").exists() and \
           (ASAR_DIR / "app.asar.zusage.tmp.json").exists()


def main() -> int:
    log("=" * 60)
    log("lagfix 提权收尾开始")
    if not is_admin():
        log("❌ 不是管理员：请右键「以管理员身份运行」，或用 UAC 提权启动本脚本")
        return 2
    log("✓ 已获得管理员权限")

    if not ASAR.is_file():
        log(f"❌ 目标不存在：{ASAR}")
        return 2

    # 1) zusage 先收尾
    if zusage_pending():
        if not (ZUSAGE_DIR / "patch_install.py").is_file():
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
        import patch_install as pi  # noqa: E402
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
