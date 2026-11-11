#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""peer 礼让的两条边界：新鲜的让、陈旧的（僵尸）不让。

背景（实测）：zusage 的值守进程会不断刷新自己的 pending mtime，
"超过 300s 没变化"这个僵尸判定永不成立，本插件如果只按僵尸判定礼让，
就会被无限饿死——用户完全退出、重开之后仍然装不上。
所以礼让必须还有第二道闸：累计 120s 上限（在 install_monitor 主循环里）。
本测试覆盖第一道闸的判定本身。
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "zcode-lagfix"
sys.path.insert(0, str(PLUGIN_DIR))
import install_monitor as im  # noqa: E402
import patch_install as pi  # noqa: E402

ok = True


def check(name: str, cond: bool) -> None:
    global ok
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    ok = ok and cond


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="lagfix-peer-") as td:
        td = Path(td)
        im.pi.DATA_DIR = td / "data"
        im.LOG_PATH = im.pi.DATA_DIR / "monitor.log"
        asar = td / "app.asar"
        asar.write_bytes(b"x")

        ours = td / pi.TMP_NAME
        ours.write_bytes(b"ours")
        peer = td / "app.asar.zusage.tmp"

        check("只有自己的 pending 时不必礼让", im.peers_active(asar) is False)

        peer.write_bytes(b"peer")           # 刚刷新 = 对方还活着
        check("peer 新鲜时必须礼让", im.peers_active(asar) is True)

        old = time.time() - (im.PEER_STALL_S + 60)
        os.utime(peer, (old, old))
        check("peer 超时无变化视为僵尸、不再礼让", im.peers_active(asar) is False)

        logtext = ""
        try:
            logtext = (im.LOG_PATH).read_text("utf-8")
        except OSError:
            pass
        check("僵尸判定写了日志", "判定停滞" in logtext)
        check("礼让上限存在且 > 轮询间隔",
              getattr(im, "PEER_WAIT_TOTAL_S", 0) > im.POLL_S)

    print("== peer_gate 结果：", "PASS" if ok else "FAIL", "==")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
