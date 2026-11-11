#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-lagfix 收尾监控：等 app.asar 可替换后完成 pending TMP → asar 替换。

v0.1.3 关键设计修正（实测驱动）
------------------------------
旧版靠"数 ZCode 进程数 == 0"来决定何时替换，这条路不可靠：
  * `tasklist` 在中文 Windows 上按本地化名称过滤（`/FI` 恒不匹配）；
  * 就算全量解析，`tasklist` 本身会偶发返回错误输出（实测有一次只回 2 行，
    于是把"32 个进程在跑"误判成 0）；
  * `zcode-runtime-host.exe` 之类 helper 的命名还会随版本变。
只要这个计数错判一次 0，值守进程就会在文件被占用时尝试替换。

新版把仲裁权交给操作系统本身：
  每 2s 尝试一次 `os.replace(tmp, asar)`。
  * 成功 → 说明没有任何进程握着该文件的句柄（Windows 不允许 rename 覆盖
    已被打开/映射的文件），替换立刻完成；
  * 失败（WinError 5/32/33）→ 说明 ZCode 还在跑，等下一轮。
进程计数只用于写日志，不再参与任何决策。这也顺带修掉了"快速重启会错过
收尾窗口"的问题——轮询 2s，退出瞬间就能抓住。

其它保留的边界：
- 单实例：monitor.lock 非阻塞取锁，拿不到就退出。
- peer 礼让：同目录其它注入插件的待收尾包若 5 分钟毫无变化（对方值守已死），
  不再无限礼让，避免本插件永远装不上。
- 收尾失败保留 pending，间隔重试（最多 5 次），下次会话 hook 会再拉起。
- 每 30s 写一次心跳日志，保证 monitor.log 存在且可被 status 佐证。
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import ctypes.wintypes as wt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import patch_install as pi  # noqa: E402


POLL_S = 2
DEADLINE_S = 24 * 3600
RETRY_MAX = 5
RETRY_BACKOFF_S = 30
PEER_STALL_S = 300          # peer pending 超过这么久没变化 → 判定僵尸
PEER_WAIT_TOTAL_S = 120     # 累计礼让上限：对方一直"活着"也不能把我们饿死
ORPHAN_TMP_AGE_S = 300
HEARTBEAT_S = 30
BUSY_LOG_S = 60             # 占用中的日志间隔（避免 2s 一行刷满）
LOG_PATH = pi.DATA_DIR / "monitor.log"
LOG_CAP = 256 * 1024
_last_stall_sig = None      # 停滞日志去重：peer 集合不变就不再重复写


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [lagfix-monitor] {msg}\n"
    try:
        pi.DATA_DIR.mkdir(parents=True, exist_ok=True)
        # 超限时轮转到 .1 而不是原地截断：原地重写会把"装不上那几天的现场"
        # 整段抹掉，事后排查就只剩最后一轮（旧版就是这么丢的）。
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_CAP:
            with contextlib.suppress(OSError):
                LOG_PATH.replace(LOG_PATH.with_name(LOG_PATH.name + ".1"))
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


# ---------- 进程计数（只用于日志，不参与决策） ----------

ZCODE_NAMES = ("zcode.exe",)


def zcode_process_count() -> int:
    """用 CreateToolhelp32Snapshot 在本进程内枚举，避免 tasklist 的本地化与偶发失败。

    返回 -1 表示枚举失败（未知）。调用方不得把 -1 当成 0。
    """
    TH32CS_SNAPPROCESS = 0x00000002

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD),
            ("th32ProcessID", wt.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
            ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", wt.LONG),
            ("dwFlags", wt.DWORD), ("szExeFile", ctypes.c_char * 260),
        ]

    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap in (0, ctypes.c_void_p(-1).value):
            return -1
        n = 0
        try:
            e = PROCESSENTRY32()
            e.dwSize = ctypes.sizeof(PROCESSENTRY32)
            ok = k32.Process32First(snap, ctypes.byref(e))
            while ok:
                name = e.szExeFile.decode("ascii", "replace").lower()
                # ZCode.exe + zcode-*.exe（runtime-host 等 helper 同样持句柄），
                # 但排除本插件自己的 lagfix*（不存在，纯防御）。
                if name in ZCODE_NAMES or (name.startswith("zcode-") and name.endswith(".exe")):
                    n += 1
                ok = k32.Process32Next(snap, ctypes.byref(e))
        finally:
            k32.CloseHandle(snap)
        return n
    except Exception:
        return -1


def _peer_pendings(asar: Path) -> list:
    """同目录下其它注入插件的待收尾包（排除我们自己的）。"""
    try:
        return [p for p in asar.parent.glob("app.asar.*.tmp")
                if p.is_file() and p.name != pi.TMP_NAME]
    except OSError:
        return []


def _peers_stalled(peers: list) -> bool:
    """所有 peer 包都长时间无变化 → 判定僵尸（对方 monitor 已死或永远收不了尾）。"""
    try:
        return all(time.time() - p.stat().st_mtime > PEER_STALL_S for p in peers)
    except OSError:
        return False


def peers_active(asar: Path) -> bool:
    """是否有仍在活动的 peer 待收尾包（有就本轮让出，避免互相覆盖注入行）。

    停滞判定只在 peer 集合变化时记一次日志：轮询 2s，若每轮都写，
    monitor.log 会被同一行刷满（实测 135s 写了几十条）。
    """
    global _last_stall_sig
    peers = _peer_pendings(asar)
    if not peers:
        _last_stall_sig = None
        return False
    if _peers_stalled(peers):
        sig = tuple(sorted(p.name for p in peers))
        if sig != _last_stall_sig:
            _last_stall_sig = sig
            log(f"其它插件待收尾包 {list(sig)} 超过 {PEER_STALL_S}s 无变化，"
                f"判定停滞；本机继续收尾（对方若仍在会用源指纹失配自行放弃，不会损坏）")
        return False
    return True


def _cleanup_orphan_tmp(asar: Path) -> None:
    """sidecar 缺失的超龄 tmp 视为孤儿清理；刚写的 tmp 绝不动。"""
    tmp = asar.parent / pi.TMP_NAME
    sidecar = asar.parent / pi.SIDECAR_NAME
    if not (tmp.exists() and not sidecar.exists()):
        return
    try:
        if time.time() - tmp.stat().st_mtime > ORPHAN_TMP_AGE_S:
            tmp.unlink()
            log("清理孤儿待收尾包")
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asar", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="显式指定数据目录（WMI 拉起的进程不继承用户环境，"
                         "Path.home() 可能指向系统账户）")
    args = ap.parse_args(argv)

    # WMI 创建的子进程 USERPROFILE 可能是 WmiPrvSE 的，必须显式对齐数据目录，
    # 否则 optout 判断、日志落盘、临时文件都会指向错误位置（终审 P1-9）。
    if args.data_dir:
        pi.DATA_DIR = args.data_dir
        pi.CONFIG_PATH = args.data_dir / "config.json"
        pi.OPTOUT_MARKER = args.data_dir / ".lagfix-optout"
        globals()["LOG_PATH"] = args.data_dir / "monitor.log"

    asar = args.asar.resolve()
    pi.set_target(asar)

    monitor_lock = asar.parent / pi.MONITOR_LOCK_NAME
    try:
        with pi.file_lock(monitor_lock, timeout=15.0):
            log(f"值守启动（asar={asar}，data={pi.DATA_DIR}，轮询 {POLL_S}s）")
            deadline = time.time() + DEADLINE_S
            failures = 0
            syntax_done = False          # 安装阶段已校验过一次，这里只补一次
            last_beat = 0.0
            last_busy_log = 0.0
            announced_exit = False
            peer_wait_start: float | None = None
            announced_peer_giveup = False

            while time.time() < deadline:
                tmp = asar.parent / pi.TMP_NAME
                sidecar = asar.parent / pi.SIDECAR_NAME
                if not tmp.exists() or not sidecar.exists():
                    _cleanup_orphan_tmp(asar)
                    log("无待收尾包，退出")
                    return 0

                now = time.time()
                if now - last_beat >= HEARTBEAT_S:
                    last_beat = now
                    n = zcode_process_count()
                    state = "未知" if n < 0 else str(n)
                    log(f"值守中（ZCode 相关进程 {state}）")

                if peers_active(asar):
                    # 礼让必须有上限：实测 zusage 的值守进程会不断刷新自己的
                    # pending mtime，让"僵尸判定"永不成立，本插件被无限饿死
                    # （用户重启后仍装不上就是这条）。120s 后本机自行推进，
                    # 对方若随后替换，会用源指纹失配自行放弃，不会互相损坏。
                    if peer_wait_start is None:
                        peer_wait_start = now
                    if now - peer_wait_start < PEER_WAIT_TOTAL_S:
                        time.sleep(POLL_S)
                        continue
                    if not announced_peer_giveup:
                        log(f"礼让其它插件已累计 {PEER_WAIT_TOTAL_S}s，本机继续收尾")
                        announced_peer_giveup = True

                result = pi.finalize_pending(syntax_check_pkg=not syntax_done)
                syntax_done = True

                if result.startswith(("finalized", "no-pending", "optout")):
                    log(f"收尾结果：{result}")
                    return 0

                if result == "busy":
                    # 操作系统的仲裁结果：文件仍被打开 → ZCode 还在跑。
                    # 这不是失败，不计入重试次数。
                    n = zcode_process_count()
                    state = "未知" if n < 0 else str(n)
                    if not announced_exit:
                        log(f"asar 仍被占用（ZCode 相关进程 {state}），继续等待")
                        announced_exit = True
                        last_busy_log = now
                    elif now - last_busy_log >= BUSY_LOG_S:
                        last_busy_log = now
                        log(f"仍在等待 asar 释放（ZCode 相关进程 {state}）")
                    time.sleep(POLL_S)
                    continue

                # 真失败（ACL / 磁盘满 / 语法校验不过 / 重打失败）
                failures += 1
                log(f"收尾失败（第 {failures}/{RETRY_MAX} 次）：{result}")
                if failures >= RETRY_MAX:
                    log("连续收尾失败，放弃（下次会话 SessionStart 会再拉起）")
                    return 1
                time.sleep(RETRY_BACKOFF_S)

            log("超过 24h 未等到可替换窗口，放弃（下次会话 SessionStart 会重试）")
            return 1
    except TimeoutError:
        log("已有其它值守实例持有监控锁，本进程退出")
        return 0
    except Exception as e:
        with contextlib.suppress(Exception):
            log(f"异常退出：{e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
