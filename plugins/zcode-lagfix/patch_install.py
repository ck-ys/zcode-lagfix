#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-lagfix v0.4.1 asar 手术库 + CLI（v2：按终审修复 P0-1/P1-1/P1-2/P1-6/P2-*）。

职责：在 ZCode 安装版 app.asar 的入口文件 out/main/index.js 尾部追加一行
dynamic import，加载我们的主进程 loader（lagfix-main.cjs）。

安全设计（三轮审查落地，勿删）：
1. 注入行标记 [lagfix] load failed / loader 名 lagfix-main.cjs，与 zusage 插件
   （inject-main.cjs / [zusage] load failed）互不匹配，互不误删。
2. 重打包逐文件断言读取长度 == 节点 size；空文件 blocks=[sha256(b"")]。
3. stage 写完 flush+fsync；os.replace 前校验源 asar 指纹
   （size+mtime_ns+st_dev+st_ino），指纹变化绝不覆盖。
   finalize_pending 的两个分支（直接替换/重打包）在 replace 前同样复查指纹，
   防止收尾窗口内吞掉他人（zusage）的并发写入。
4. 语法自检：ZCode.exe + ELECTRON_RUN_AS_NODE=1 --check，timeout 30s，
   CREATE_NO_WINDOW；找不到/无法运行/超时时跳过（不挡安装）。
5. 权限检查在取锁之前；锁/TMP/sidecar 命名全部与 zusage 错开。
6. 替换失败（运行中占用）→ 保留 pending TMP+sidecar（先确认 TMP 落地再写
   sidecar），由 install_monitor.py 等全部 ZCode 退出后收尾；已有合法 pending
   时不重复重打包，只确保 monitor 在跑。
7. remove 在 asar 被占用时明确报错（提示完全退出后重试）并清掉 pending，
   绝不抛未捕获异常；finalize 尊重 optout。
8. 注入行以 \\n 前缀追加，防入口尾行是 // 注释时被吞（对应模板含 \\n，
   剥离时连同 \\n 一起剥，字节级可还原）。
9. install 前确保运行时文件已就位（从本脚本目录复制），手动安装路径不踩空。

CLI：python patch_install.py install|remove|uninstall|check|status|finalize [--asar PATH] [--runtime DIR]
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import msvcrt  # noqa: F401  Windows
except ImportError:
    msvcrt = None
try:
    import fcntl  # noqa: F401  POSIX
except ImportError:
    fcntl = None

# ---------- 常量 ----------

ENTRY = "out/main/index.js"
BLOCK = 4 * 1024 * 1024  # asar integrity 分块大小
ALIGN = 4                # pickle 头对齐

DATA_DIR = Path.home() / ".zcode" / "zcode-lagfix"
CONFIG_PATH = DATA_DIR / "config.json"
OPTOUT_MARKER = DATA_DIR / ".lagfix-optout"

LOCK_NAME = "app.asar.lagfix.lock"
MONITOR_LOCK_NAME = "app.asar.lagfix.monitor.lock"
TMP_NAME = "app.asar.lagfix.tmp"
SIDECAR_NAME = TMP_NAME + ".json"
SYNTAX_TIMEOUT_S = 30

# 运行时目录必须自带 patch_install.py：lagfix_report.py 与 install_monitor.py
# 都 import 它，缺了会在 ~/.zcode/zcode-lagfix 下直接 ImportError。
# 注意安装目录 != 源码目录：只按"目标不存在"复制会让升级永远停在旧版，
# 所以内容不同就覆盖。
RUNTIME_FILES = ("lagfix-main.cjs", "lagfix-observe.js",
                 "install_monitor.py", "lagfix_report.py", "patch_install.py")

# 注入行模板：前置 \n（防入口尾行是 // 注释），剥离时连同 \n 一起剥。
# 只认本模板产出的行（无空格版），任意目录都匹配；zusage 的行（不同文件名 +
# 不同标记 + 带空格 then）永不匹配。
LAGFIX_LINE_RE = re.compile(
    rb'\n;import\("file://[^"]*/lagfix-main\.cjs"\)'
    rb'\.then\(\(\)=>null,\(e\)=>console\.error\("\[lagfix\] load failed",e\)\);'
)
LAGFIX_MARK = b"lagfix-main.cjs"

TARGET: Path | None = None      # 由 set_target 指定，否则 find_asar()
RUNTIME_DIR: Path | None = None # lagfix-main.cjs 所在目录，默认 DATA_DIR

# ---------- 小工具 ----------

def _print(msg: str) -> None:
    print(f"[lagfix] {msg}", flush=True)


def inject_line(runtime_dir: Path) -> bytes:
    url = str(Path(runtime_dir).resolve()).replace("\\", "/")
    return (
        ';import("file:///' + url + '/lagfix-main.cjs")'
        '.then(()=>null,(e)=>console.error("[lagfix] load failed",e));'
    ).encode("utf-8")


def line_count(entry: bytes) -> int:
    return len(LAGFIX_LINE_RE.findall(entry))


def _is_current(entry: bytes, line: bytes) -> bool:
    """恰好一行且内容就是当前 runtime 的行。

    P2-12：不再要求 endswith——其它插件后来在尾部追加自己的行时，
    我们仍算"已安装"，避免每次启动都重打 384MB。
    """
    return line_count(entry) == 1 and b"\n" + line in entry


def set_target(path: Path) -> None:
    global TARGET
    TARGET = Path(path)


def set_runtime(dir_path: Path) -> None:
    global RUNTIME_DIR
    RUNTIME_DIR = Path(dir_path)


def resolve_target() -> Path:
    global TARGET
    if TARGET is not None:
        return TARGET
    found = find_asar()
    if found is None:
        raise SystemExit("[lagfix] 未找到 app.asar，可用 LAGFIX_ASAR 环境变量指定")
    TARGET = found
    return TARGET


def resolve_runtime() -> Path:
    global RUNTIME_DIR
    if RUNTIME_DIR is None:
        RUNTIME_DIR = DATA_DIR
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    return RUNTIME_DIR


def _atomic_copy(src: Path, dst: Path) -> bool:
    """tmp + os.replace 复制运行时文件。

    Windows 的 copy2 是"就地截断再写"：若此刻正好有窗口在 dom-ready 读
    lagfix-observe.js 做语法预检，可能读到半个文件（加载器会注入失败）。
    改成先写同目录临时文件再原子替换；目标被占用时保留旧版，下次再同步。
    """
    tmp = dst.with_name(dst.name + f".tmp-{os.getpid()}")
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
        return True
    except OSError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        _print(f"运行时文件被占用，保留旧版（下次再同步）：{dst.name}（{e}）")
        return False


def sweep_tmp(dir_path: Path, max_age_s: int = 86400) -> None:
    """清掉原子复制留下的 `*.tmp-<pid>` 孤儿（进程在 copy 与 replace 之间被杀）。

    v0.3.8：只匹配 RUNTIME_FILES 里每个文件名 + `.tmp-<pid>` 的普通文件；
    运行目录在用户主目录下，任意 `*.tmp-<pid>` 会误删别人的临时文件。
    """
    owned = re.compile(
        r"^(?:" + "|".join(re.escape(n) for n in RUNTIME_FILES) + r")\.tmp-\d+$"
    )
    try:
        now = time.time()
        for p in Path(dir_path).glob("*.tmp-*"):
            if not owned.match(p.name):
                continue
            try:
                if p.is_symlink() or not p.is_file():
                    continue
                if now - p.stat().st_mtime > max_age_s:
                    p.unlink()
            except OSError:
                pass
    except OSError:
        pass


def _ensure_runtime() -> bool:
    """P1-6：注入前确保运行时文件就位且与源码一致（升级路径不踩空）。

    早期版本只在目标不存在时复制，导致 patch_install.py install 升级时
    运行时目录一直是旧脚本；现在按字节比较，不同就覆盖。
    """
    runtime = resolve_runtime()
    sweep_tmp(runtime)
    here = Path(__file__).resolve().parent
    for name in RUNTIME_FILES:
        src = here / name
        if not src.is_file():
            _print(f"运行时文件缺失且源不存在：{name}")
            return False
        dst = runtime / name
        try:
            if dst.exists() and dst.read_bytes() == src.read_bytes():
                continue
        except OSError:
            pass
        _atomic_copy(src, dst)
    return (runtime / "lagfix-main.cjs").is_file()


# ---------- 配置 ----------

def _load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except Exception:
        return {}


def _save_config(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, CONFIG_PATH)


# ---------- asar 探测 ----------

def _candidate_asars() -> list[Path]:
    cands: list[Path] = []
    env = os.environ.get("LAGFIX_ASAR")
    if env:
        cands.append(Path(env))
    cfg = _load_config().get("asar_path")
    if cfg:
        cands.append(Path(cfg))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands.append(Path(local) / "Programs" / "ZCode" / "resources" / "app.asar")
    for drive in ("C", "D", "E", "F", "G"):
        cands.append(Path(f"{drive}:/Program Files/ZCode/resources/app.asar"))
    cands.append(Path("/Applications/ZCode.app/Contents/Resources/app.asar"))
    cands.append(Path("/opt/ZCode/resources/app.asar"))
    cands.append(Path("/usr/lib/zcode/resources/app.asar"))
    return cands


def _sibling_exe(asar: Path) -> Path | None:
    """ZCode 可执行文件。真实布局：<root>/ZCode.exe + <root>/resources/app.asar，
    即 exe 在 asar 的上上级目录（P0-1 修复）。"""
    root = asar.parent.parent
    for n in ("ZCode.exe", "ZCode", "zcode"):
        p = root / n
        if p.is_file():
            return p
    if sys.platform == "darwin":
        # asar = ZCode.app/Contents/Resources/app.asar → Contents/MacOS/ZCode
        p = asar.parent.parent / "MacOS" / "ZCode"
        if p.is_file():
            return p
    return None


def find_asar() -> Path | None:
    env_forced = Path(os.environ["LAGFIX_ASAR"]) if os.environ.get("LAGFIX_ASAR") else None
    for cand in _candidate_asars():
        try:
            if cand.is_file() and cand.stat().st_size > 1024 * 1024:
                if env_forced is not None and cand == env_forced:
                    return cand
                # 非环境变量指定时要求 exe 守卫，防误注入
                if _sibling_exe(cand) is not None:
                    return cand
        except OSError:
            continue
    return None


# ---------- asar 读写 ----------

def read_header(f):
    f.seek(0)
    a, b, c, d = struct.unpack("<4I", f.read(16))
    if a != 4:
        raise ValueError(f"unexpected pickle prefix {a}")
    header = json.loads(f.read(d))
    return header, 8 + b


def iter_files(node: dict, path: str = ""):
    for name, ch in node.get("files", {}).items():
        p = f"{path}/{name}"
        if "files" in ch:
            yield from iter_files(ch, p)
        else:
            yield p, ch


def compute_integrity(data: bytes) -> dict:
    blocks = [
        hashlib.sha256(data[i : i + BLOCK]).hexdigest()
        for i in range(0, len(data), BLOCK)
    ] or [hashlib.sha256(b"").hexdigest()]  # P2-2：空文件 blocks 与官方一致
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK,
        "blocks": blocks,
    }


def repack(src_path: Path, modify: dict, dst_path: Path) -> Path:
    """重建 asar。modify: {asar内路径: 新内容bytes}。未改动文件流式拷贝并断言长度。"""
    with open(src_path, "rb") as src:
        header, base = read_header(src)
        header = json.loads(json.dumps(header))  # 深拷贝
        nodes = dict(iter_files(header))
        missing = set(modify) - set(nodes)
        if missing:
            raise ValueError(f"paths not in asar: {missing}")

        data_parts = []
        offset = 0
        for p, node in nodes.items():
            if node.get("unpacked"):
                node["offset"] = "0"
                continue
            if node.get("link"):  # P2-16：符号链接节点无数据区，跳过
                node["offset"] = "0"
                continue
            if p in modify:
                data = modify[p]
                node["size"] = len(data)
                node["integrity"] = compute_integrity(data)
            else:
                src.seek(base + int(node["offset"]))
                data = src.read(int(node["size"]))
                if len(data) != int(node["size"]):
                    raise IOError(f"short read for {p}: {len(data)} != {node['size']}")
            node["offset"] = str(offset)
            data_parts.append(data)
            offset += len(data)

        payload = b"".join(data_parts)
        header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        b_total = c + 4
        with open(dst_path, "wb") as out:
            out.write(struct.pack("<4I", 4, b_total, c, d))
            out.write(header_bytes)
            out.write(b"\0" * (c - d - 4))
            if out.tell() != 8 + b_total:
                raise IOError("header pad mismatch")
            out.write(payload)
            out.flush()
            os.fsync(out.fileno())
    return dst_path


def entry_bytes_of(asar_path: Path) -> bytes:
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        nodes = dict(iter_files(header))
        key = "/" + ENTRY
        if key not in nodes:
            raise KeyError(f"entry {ENTRY} not found")
        node = nodes[key]
        f.seek(base + int(node["offset"]))
        data = f.read(int(node["size"]))
        if len(data) != int(node["size"]):
            raise IOError("short read for entry")
        return data


# Windows 上"文件被占用"与"权限/磁盘"的错误码完全不同，提示必须分开，
# 否则用户会对着一个永远修不好的条件反复重启（终审 P1-3/P1-7）。
_BUSY_WINERRORS = {5, 32, 33}  # ACCESS_DENIED / SHARING_VIOLATION / LOCK_VIOLATION
_BUSY_ERRNOS = {13, 16, 26}    # EACCES / EBUSY / ETXTBSY


def _is_busy(e: OSError) -> bool:
    win = getattr(e, "winerror", None)
    if win is not None:
        return win in _BUSY_WINERRORS
    return getattr(e, "errno", None) in _BUSY_ERRNOS


def _busy_hint(e: OSError) -> str:
    """区分「被占用」与「没权限」，给对提示。"""
    if _is_busy(e):
        # WinError 5 既可能是进程占用，也可能是 Program Files 的 ACL 拒绝。
        # 不枚举进程（替换仲裁只信操作系统），但提示必须覆盖第二种可能，
        # 否则用户会对着"请退出 ZCode"反复重启（三审 P1）。
        extra = ""
        if getattr(e, "winerror", None) == 5:
            extra = " 若确认 ZCode 已完全退出仍失败，通常是 ACL 权限拒绝，请以管理员身份重试。"
        return ("ZCode 正在运行占用 app.asar。请完全退出（含托盘 / 任务管理器确认"
                "没有 ZCode.exe 与 zcode-runtime-host.exe）后重试。" + extra)
    return (f"替换被系统拒绝（{e}）。常见原因：目标目录 ACL 拒绝写入、磁盘满、"
            f"杀毒软件锁定。以管理员身份运行可排查 ACL 问题。")


def fingerprint(asar_path: Path) -> tuple:
    st = asar_path.stat()
    return (st.st_size, st.st_mtime_ns, st.st_dev, st.st_ino)


# ---------- 锁 ----------

@contextlib.contextmanager
def file_lock(path: Path, timeout: float = 30.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+b")
    locked = False
    try:
        f.seek(0, os.SEEK_END)
        if f.tell() == 0:
            f.write(b"0")
            f.flush()
        deadline = time.time() + timeout
        while True:
            try:
                if msvcrt is not None:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                elif fcntl is not None:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    break  # 无锁原语（罕见），退化为无锁
                locked = True
                break
            except OSError:
                if time.time() >= deadline:
                    raise TimeoutError(f"lock timeout: {path}")
                time.sleep(0.2)
        yield
    finally:
        if locked:
            try:
                if msvcrt is not None:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                elif fcntl is not None:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        f.close()


# ---------- 校验 ----------

def syntax_check(asar_path: Path) -> bool:
    """用 ZCode 自身当 node 对改后入口做语法检查；找不到/无法运行/超时跳过。"""
    exe = _sibling_exe(asar_path)
    if exe is None:
        _print("未找到 ZCode 可执行文件，跳过语法检查")
        return True
    src = entry_bytes_of(asar_path)
    # 临时文件放 DATA_DIR：WMI 拉起的进程 TEMP 可能指向系统账户不可写目录
    check_dir = DATA_DIR if DATA_DIR.exists() else None
    fd, name = tempfile.mkstemp(prefix=".lagfix-entry-check.", suffix=".mjs",
                                dir=str(check_dir) if check_dir else None)
    tmp_js = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(src)
        env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
        kwargs: dict = {}
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        r = subprocess.run(
            [str(exe), "--check", str(tmp_js)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, timeout=SYNTAX_TIMEOUT_S, **kwargs,
        )
        if r.returncode != 0:
            _print(f"语法检查失败：{r.stderr.strip()[:200]}")
            return False
        return True
    except subprocess.TimeoutExpired:
        _print(f"语法检查超时（>{SYNTAX_TIMEOUT_S}s），跳过")
        return True
    except OSError as e:
        _print(f"语法检查无法执行（{e}），跳过")
        return True
    finally:
        tmp_js.unlink(missing_ok=True)


def _target_writable(asar_dir: Path) -> bool:
    """权限检查放在取锁之前。"""
    probe = asar_dir / f".lagfix-write-test-{os.getpid()}"
    try:
        with open(probe, "wb") as f:
            f.write(b"0")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


# ---------- 状态 ----------

def injected_status(asar: Path | None = None) -> dict:
    asar = asar or resolve_target()
    entry = entry_bytes_of(asar)
    return {
        "present": line_count(entry),
        "current": _is_current(entry, inject_line(resolve_runtime())),
    }


# ---------- 安装 / 卸载核心 ----------

def _build_stage(asar: Path, new_entry: bytes, stage: Path) -> bool:
    repack(asar, {"/" + ENTRY: new_entry}, stage)
    if not syntax_check(stage):
        return False
    return True


def _sweep_stages(asar_dir: Path) -> None:
    for p in asar_dir.glob(".lagfix-stage-*.tmp"):
        with contextlib.suppress(OSError):
            p.unlink(missing_ok=True)


def _pending_valid(asar_dir: Path, asar: Path | None = None) -> bool:
    """待收尾包是否可直接复用。

    v0.1.2 增加「源指纹」校验（终审 P1-8）：只看 sidecar 能否解析是不够的。
    ZCode 升级会覆盖 app.asar，此时旧 pending 是基于**上个版本**打的包，直接
    复用并替换上去会丢掉期间别人写进 asar 的内容（注入了旧版代码）。
    源指纹不一致 → 视为陈旧，丢弃重建。
    """
    tmp = asar_dir / TMP_NAME
    if not tmp.exists():
        return False
    try:
        sc = json.loads((asar_dir / SIDECAR_NAME).read_text("utf-8"))
    except Exception:
        return False
    if not isinstance(sc, dict):
        return False
    src = sc.get("source")
    if not isinstance(src, list) or len(src) != 4:
        return False
    if asar is not None:
        try:
            if list(fingerprint(asar)) != [int(x) for x in src]:
                _print("待收尾包基于旧版 asar 生成，丢弃重建")
                _clear_pending(asar_dir)
                return False
        except (OSError, TypeError, ValueError):
            return False
    return True


def _clear_pending(asar_dir: Path) -> None:
    with contextlib.suppress(OSError):
        (asar_dir / TMP_NAME).unlink(missing_ok=True)
    with contextlib.suppress(OSError):
        (asar_dir / SIDECAR_NAME).unlink(missing_ok=True)


def install() -> str:
    asar = resolve_target()
    runtime = resolve_runtime()

    if OPTOUT_MARKER.exists():
        return "optout"
    if not _ensure_runtime():
        return "failed"

    asar_dir = asar.parent
    if not _target_writable(asar_dir):
        _print(f"目标目录不可写：{asar_dir}（尝试以管理员运行，或关闭 ZCode 后重试）")
        return "failed"

    lock = asar_dir / LOCK_NAME
    line = inject_line(runtime)
    for attempt in range(2):
        with file_lock(lock):
            # 锁外的 optout 检查不具原子性：排队等锁期间用户可能刚卸载并写标记，
            # 锁内不复查就会把刚剥掉的注入重新装回去（三审 P1）。
            if OPTOUT_MARKER.exists():
                return "optout"
            # P2-7：已有可复用 pending 不重打包，只确保 monitor 在跑
            if _pending_valid(asar_dir, asar):
                _launch_monitor(asar)
                return "pending"

            fp0 = fingerprint(asar)
            entry = entry_bytes_of(asar)
            if _is_current(entry, line):
                return "already"
            stripped = LAGFIX_LINE_RE.sub(b"", entry)
            new_entry = stripped + b"\n" + line  # P2-5：前置 \n 防注释吞行

            stage = asar_dir / f".lagfix-stage-{os.getpid()}.tmp"
            try:
                if not _build_stage(asar, new_entry, stage):
                    return "failed"
                if fingerprint(asar) != fp0:
                    _print("检测到 asar 在安装期间被修改，重试…")
                    continue
                try:
                    os.replace(stage, asar)
                except OSError as e:
                    if not _is_busy(e):
                        # 非占用类失败（ACL/磁盘满/杀软）挂 pending 毫无意义，
                        # 那个条件永远不会自己变好。直接失败并说真话。
                        _print(f"替换 app.asar 失败：{_busy_hint(e)}")
                        return "failed"
                    # 运行中占用 → pending（先确认 TMP 落地再写 sidecar）
                    if getattr(e, "winerror", None) == 5:
                        _print(_busy_hint(e))   # 提醒 ACL 也可能返回 WinError 5
                    tmp = asar_dir / TMP_NAME
                    moved = False
                    with contextlib.suppress(OSError):
                        os.replace(stage, tmp)
                        moved = tmp.exists()
                    if not moved:
                        _print("挂起待收尾失败（临时包未能落位）")
                        return "failed"
                    sidecar = {
                        "source": list(fp0),
                        "runtime": str(runtime.resolve()),
                        "ts": time.time(),
                    }
                    (asar_dir / SIDECAR_NAME).write_text(
                        json.dumps(sidecar, ensure_ascii=False), "utf-8"
                    )
                    _launch_monitor(asar)
                    _print(f"ZCode 正在运行，已挂起待收尾：{tmp}（退出全部 ZCode 窗口后自动完成）")
                    return "pending"
                # P2-4：安装后校验失败不致命（asar 已是有效新包），只告警
                try:
                    _verify_installed(asar, line)
                except Exception as e:
                    _print(f"安装后校验异常（不影响已完成的替换）：{e}")
                return "installed"
            finally:
                stage.unlink(missing_ok=True)
                _sweep_stages(asar_dir)
    return "failed"


def _verify_installed(asar: Path, line: bytes) -> None:
    entry = entry_bytes_of(asar)
    if not _is_current(entry, line):
        raise RuntimeError("注入行数量/内容异常")


def remove() -> str:
    asar = resolve_target()
    asar_dir = asar.parent

    if not _target_writable(asar_dir):
        _print(f"目标目录不可写：{asar_dir}（尝试以管理员运行）")
        return "failed"

    lock = asar_dir / LOCK_NAME
    with file_lock(lock):
        fp0 = fingerprint(asar)
        entry = entry_bytes_of(asar)
        if not LAGFIX_LINE_RE.search(entry):
            _clear_pending(asar_dir)
            return "already"
        new_entry = LAGFIX_LINE_RE.sub(b"", entry)

        stage = asar_dir / f".lagfix-stage-{os.getpid()}.tmp"
        try:
            if not _build_stage(asar, new_entry, stage):
                return "failed"
            if fingerprint(asar) != fp0:
                _print("检测到 asar 在卸载期间被修改，请重试")
                return "failed"
            try:
                os.replace(stage, asar)
            except OSError as e:
                # P1-2：占用时明确报错（不抛栈），并清 pending 防止收尾把注入补回来
                _clear_pending(asar_dir)
                _print(f"无法立即卸载：{_busy_hint(e)}")
                return "failed"
            _clear_pending(asar_dir)
            return "removed"
        finally:
            stage.unlink(missing_ok=True)
            _sweep_stages(asar_dir)


def uninstall() -> str:
    """市场安装的一键卸载：先写豁免标记占位，再剥注入；失败则撤回标记。

    - 先写标记：堵住并发的 SessionStart hook / finalize_pending，避免它们
      在卸载过程中把注入重新装回去（三审 P1 的 TOCTOU）。
    - remove() 失败（ZCode 仍占用等）→ 撤回标记，绝不留下"号称卸了、
      其实还在"的假状态。
    - remove() 成功 → 标记保留；即使插件仍启用，下次启动也不会再注入。
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OPTOUT_MARKER.write_text("uninstalled by patch_install.py uninstall\n", encoding="utf-8")
    except OSError as e:
        # 标记都写不了就什么都没改，直接失败，别让用户以为卸载已开始。
        _print(f"写豁免标记失败，未做任何改动：{e}")
        return "optout-failed"
    result = remove()
    if result not in ("removed", "already"):
        try:
            OPTOUT_MARKER.unlink(missing_ok=True)
        except OSError as e:
            _print(f"卸载失败且豁免标记未能撤回（请手动删除 {OPTOUT_MARKER}）：{e}")
        return result
    return "uninstalled"


# ---------- 收尾（monitor 调用） ----------

def finalize_pending(syntax_check_pkg: bool = True) -> str:
    """全部 ZCode 退出后由 install_monitor 调用。

    - optout → 清 pending 直接返回；
    - 指纹匹配 → （可选）syntax_check 后【复查指纹】再替换（P1-1，防窗口期吞他人写入）；
    - 失配（他人已替换）→ 以当前 asar 为源重打包，替换前同样复查；
    - 每分支最多 3 轮，任何失败保留 pending。

    返回 "busy" 表示 asar 被占用（ZCode 还在跑），调用方应继续轮询而不是计失败。
    syntax_check_pkg=False 用于值守进程的重复尝试：安装阶段已校验过一次，
    每 2s 重新拉起 ZCode.exe --check 既慢又毫无新信息。
    """
    asar = resolve_target()
    asar_dir = asar.parent
    tmp = asar_dir / TMP_NAME
    sidecar_path = asar_dir / SIDECAR_NAME

    if OPTOUT_MARKER.exists():
        _clear_pending(asar_dir)
        return "optout"
    if not tmp.exists() or not sidecar_path.exists():
        return "no-pending"

    try:
        sidecar = json.loads(sidecar_path.read_text("utf-8"))
    except Exception:
        _clear_pending(asar_dir)  # sidecar 损坏：丢弃孤儿 TMP
        return "no-pending"

    # P2-9：sidecar 字段缺失/类型不对 → 立即清 pending，别耗 5 次重试
    src = sidecar.get("source") if isinstance(sidecar, dict) else None
    if not isinstance(src, list) or len(src) != 4:
        _clear_pending(asar_dir)
        return "no-pending"

    lock = asar_dir / LOCK_NAME
    with file_lock(lock):
        for _round in range(3):
            # 锁内复查：卸载可能在 finalize 等锁期间完成并写下 optout。
            # 不复查的话，下面的"失配重打包"会把刚剥掉的 lagfix 行重新写回，
            # 造成"卸载成功、注入却复活"（三审 P1）。
            if OPTOUT_MARKER.exists():
                _clear_pending(asar_dir)
                return "optout"
            if not tmp.exists() or not sidecar_path.exists():
                return "no-pending"
            fp0 = fingerprint(asar)
            try:
                if list(fp0) == list(src):
                    if syntax_check_pkg and not syntax_check(tmp):
                        _clear_pending(asar_dir)
                        return "failed"
                    # P1-1：syntax_check 期间 asar 可能被他人替换——复查后再动
                    if fingerprint(asar) != fp0:
                        _print("收尾校验时 asar 又被修改，转重打包分支…")
                        continue
                    # 语法检查/指纹复查耗时较长，替换前最后确认一次卸载意图。
                    if OPTOUT_MARKER.exists():
                        _clear_pending(asar_dir)
                        return "optout"
                    os.replace(tmp, asar)
                    _clear_pending(asar_dir)
                    return "finalized"
                # 失配：他人替换过 asar → 基于当前 asar 重打（R5）
                _print("asar 已被其他工具替换，基于当前文件重新打包…")
                # 一律用当前 runtime：sidecar 里记的可能是已废弃的旧目录，
                # 沿用它会让注入行指向不存在的文件（终审 P2）。
                if not _ensure_runtime():
                    return "failed"
                line = inject_line(resolve_runtime())
                entry = entry_bytes_of(asar)
                stripped = LAGFIX_LINE_RE.sub(b"", entry)
                stage = asar_dir / f".lagfix-stage-{os.getpid()}.tmp"
                try:
                    if not _build_stage(asar, stripped + b"\n" + line, stage):
                        return "failed"
                    # 重打包耗时数秒，替换前复查指纹
                    if fingerprint(asar) != fp0:
                        _print("重打包期间 asar 又被修改，重试…")
                        continue
                    if OPTOUT_MARKER.exists():
                        _clear_pending(asar_dir)
                        return "optout"
                    os.replace(stage, asar)
                    _clear_pending(asar_dir)
                    return "finalized-rederived"
                finally:
                    stage.unlink(missing_ok=True)
                    _sweep_stages(asar_dir)
            except OSError as e:
                if _is_busy(e):
                    # 被占用（ZCode 还开着）不是"失败"，是"还没到时候"。
                    # 让操作系统做仲裁：能 rename 就说明没人握着句柄，不能就等下一轮。
                    return "busy"
                _print(f"收尾失败（保留待收尾包，下次重试）：{e}")
                return "failed"
    return "failed"


def _wmi_pythonw() -> str | None:
    """WMI 创建无创建标志位可用，静默监控必须用 pythonw.exe（无控制台）。"""
    try:
        if not sys.executable:
            return None
        p = Path(sys.executable).with_name("pythonw.exe")
        return str(p) if p.is_file() else None
    except Exception:
        return None


def _spawn_via_wmi(cmd: list) -> int | None:
    """经 WMI Win32_Process.Create 创建脱离进程。

    关键：从 agent/工具会话里 Popen 的子进程活在宿主的 Job 对象里，会话一结束
    整树被杀——值守进程等不到「ZCode 全退」的收尾窗口就没了（zusage issue #208
    同款坑）。WMI 创建的进程父级是 WmiPrvSE，天然不在调用方 Job 内。
    """
    try:
        command_line = subprocess.list2cmdline([str(c) for c in cmd])
        script = (
            "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
            "-Arguments @{ CommandLine = '%s' }; "
            "if ($r.ReturnValue -ne 0) { exit 1 }; [int]$r.ProcessId"
            % command_line.replace("'", "''")
        )
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            capture_output=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        return int(r.stdout.decode("ascii", "replace").strip())
    except ValueError:
        return None


def _spawn_detached(cmd: list, flags: int) -> int | None:
    """树内回退：尽量带 CREATE_BREAKAWAY_FROM_JOB 脱离 Job，失败再裸拉起。"""
    breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
    for extra in (breakaway, 0):
        try:
            p = subprocess.Popen(
                cmd,
                creationflags=(flags | extra) if extra else flags,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, close_fds=True,
            )
            return p.pid
        except OSError:
            continue
    return None


def _launch_monitor(asar: Path) -> None:
    if os.environ.get("LAGFIX_NO_MONITOR"):  # 测试钩子：夹具里不真拉 24h 轮询进程
        return
    monitor_py = Path(__file__).resolve().parent / "install_monitor.py"
    if not monitor_py.is_file():
        _print("未找到 install_monitor.py，跳过监控（可手动运行 patch_install.py finalize）")
        return
    tail = [str(monitor_py), "--asar", str(asar), "--data-dir", str(DATA_DIR)]

    if os.name == "nt":
        pyw = _wmi_pythonw()
        if pyw:
            pid = _spawn_via_wmi([pyw] + tail)
            if pid:
                _print(f"值守进程已拉起（pid={pid}，WMI 脱离通道）")
                return
        pid = _spawn_detached([sys.executable or "python"] + tail,
                              getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))
        if pid:
            _print(f"值守进程已拉起（pid={pid}，breakaway 通道）")
            return
        _print("值守进程拉起失败；可稍后手动运行 install_monitor.py --asar <路径>")
        return

    try:
        p = subprocess.Popen(
            [sys.executable or "python"] + tail,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
        )
        _print(f"值守进程已拉起（pid={p.pid}）")
    except OSError as e:
        _print(f"值守进程拉起失败（{e}）")


# ---------- CLI ----------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="zcode-lagfix asar installer")
    ap.add_argument("action", choices=["install", "remove", "uninstall", "check", "status", "finalize"])
    ap.add_argument("--asar", type=Path, default=None)
    ap.add_argument("--runtime", type=Path, default=None)
    args = ap.parse_args(argv)

    if args.asar:
        set_target(args.asar)
    if args.runtime:
        set_runtime(args.runtime)

    if args.action == "install":
        asar = resolve_target()
        cfg = _load_config()
        cfg["asar_path"] = str(asar)
        _save_config(cfg)
        result = install()
        _print(f"install → {result}")
        return 0 if result in ("installed", "already", "pending") else 1

    if args.action == "remove":
        result = remove()
        _print(f"remove → {result}")
        return 0 if result in ("removed", "already") else 1

    if args.action == "uninstall":
        try:
            result = uninstall()
        except BaseException as e:
            # 开源用户可能在没有终端的环境里双击执行；任何异常都要变成可读输出，
            # 不能只抛栈。remove() 内部仍保证失败时不写豁免标记（终审 P2-1）。
            _print(f"uninstall 失败：{e}")
            return 130 if isinstance(e, KeyboardInterrupt) else 1
        _print(f"uninstall → {result}")
        return 0 if result in ("uninstalled", "removed", "already") else 1

    if args.action == "check":
        asar = resolve_target()
        entry = entry_bytes_of(asar)
        n = line_count(entry)
        _print(f"入口注入行数={n}，zusage 行={'有' if b'inject-main.cjs' in entry else '无'}")
        return 0

    if args.action == "status":
        _print(f"asar={resolve_target()}")
        _print(f"runtime={resolve_runtime()}")
        _print(f"状态={injected_status()}")
        _print(f"optout={'是' if OPTOUT_MARKER.exists() else '否'}")
        return 0

    if args.action == "finalize":
        result = finalize_pending()
        _print(f"finalize → {result}")
        return 0 if result.startswith(("finalized", "no-pending", "optout")) else 1

    return 1


if __name__ == "__main__":
    sys.exit(main())
