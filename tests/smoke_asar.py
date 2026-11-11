#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合成 asar 夹具上走 install→pending→finalize(匹配/失配/损坏/optout)→remove 全流程。

绝不触碰真实安装目录（E:\\Program Files），一切都在 tempfile 临时目录里。
v2 覆盖终审要求的新夹具：
  - 真实安装布局的 _sibling_exe（P0-1 回归）
  - finalize 指纹匹配 happy path
  - finalize 期间他人替换（失配重打包分支，R5）
  - sidecar 损坏孤儿清理
  - optout 阻断收尾（P1-2）
  - 已有 pending 时 install 不重打包（P2-7）
"""

import json
import os
import struct
import sys
import tempfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "zcode-lagfix"
sys.path.insert(0, str(PLUGIN_DIR))
import patch_install as pi  # noqa: E402

ENTRY_JS = b'console.log("host main");\nexport default null;\n'
OTHER_JS = b'{"name":"zcode","main":"out/main/index.js","type":"module"}\n'

os.environ["LAGFIX_NO_MONITOR"] = "1"  # 夹具里绝不真拉 24h 轮询监控


def build_asar(asar_path: Path, files: dict) -> Path:
    """按 asar 格式手工构造微型包（与 pi.repack 的写法一致，用于交叉验证）。"""
    header: dict = {"files": {}}
    for p, data in files.items():
        node = header["files"]
        parts = p.split("/")
        for seg in parts[:-1]:
            node = node.setdefault(seg, {"files": {}})["files"]
        node[parts[-1]] = {"size": len(data), "offset": "0", "integrity": pi.compute_integrity(data)}

    parts_out = []
    offset = 0
    for p, node in pi.iter_files(header):
        data = files[p.lstrip("/")]
        node["offset"] = str(offset)
        parts_out.append(data)
        offset += len(data)

    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    d = len(header_bytes)
    c = (d + 4 + pi.ALIGN - 1) // pi.ALIGN * pi.ALIGN
    b_total = c + 4
    with open(asar_path, "wb") as out:
        out.write(struct.pack("<4I", 4, b_total, c, d))
        out.write(header_bytes)
        out.write(b"\0" * (c - d - 4))
        out.write(b"".join(parts_out))
        out.flush()
        os.fsync(out.fileno())
    return asar_path


def read_file_from_asar(asar: Path, inner: str) -> bytes:
    with open(asar, "rb") as f:
        header, base = pi.read_header(f)
        nodes = dict(pi.iter_files(header))
        node = nodes["/" + inner]
        f.seek(base + int(node["offset"]))
        return f.read(int(node["size"]))


def write_pending(td: Path, asar: Path, tmp_files: dict, source_fp=None) -> None:
    build_asar(td / pi.TMP_NAME, tmp_files)
    if source_fp is None:
        source_fp = pi.fingerprint(asar)
    (td / pi.SIDECAR_NAME).write_text(
        json.dumps({"source": list(source_fp), "runtime": str(PLUGIN_DIR), "ts": 0}), "utf-8"
    )


def pending_cleared(td: Path) -> bool:
    return not (td / pi.TMP_NAME).exists() and not (td / pi.SIDECAR_NAME).exists()


def main() -> int:
    ok = True

    def check(name: str, cond: bool):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
        ok = ok and cond

    # ---- 夹具 A：真实安装布局的 _sibling_exe（P0-1 回归）----
    with tempfile.TemporaryDirectory(prefix="lagfix-layout-") as td:
        td = Path(td)
        root = td / "ZCodeRoot"
        (root / "resources").mkdir(parents=True)
        (root / "ZCode.exe").write_bytes(b"MZ")
        asar_real = root / "resources" / "app.asar"
        print("== 夹具 A：真实布局 ==")
        check("exe 在 asar 上上级目录(真实布局)能找到", pi._sibling_exe(asar_real) == root / "ZCode.exe")
        # 错误布局：exe 与 asar 同级（v1 的 bug 写法）必须找不到 → 守卫防误注入
        wrong = td / "wrong"
        wrong.mkdir()
        (wrong / "ZCode.exe").write_bytes(b"MZ")
        check("exe 与 asar 同级(错误布局)找不到", pi._sibling_exe(wrong / "app.asar") is None)

    with tempfile.TemporaryDirectory(prefix="lagfix-smoke-") as td:
        td = Path(td)
        asar = td / "app.asar"
        runtime = td / "runtime"
        runtime.mkdir()
        (runtime / "lagfix-main.cjs").write_text("// stub loader\n")

        # 隔离：optout/配置指到临时目录
        pi.OPTOUT_MARKER = td / ".lagfix-optout"
        pi.DATA_DIR = td / "data"
        pi.CONFIG_PATH = pi.DATA_DIR / "config.json"

        pi.set_target(asar)
        pi.set_runtime(runtime)

        print("== smoke_asar 测试 ==")
        build_asar(asar, {"out/main/index.js": ENTRY_JS, "package.json": OTHER_JS})
        line = pi.inject_line(runtime)

        # 1. install（\n 前缀协议）
        check("install 返回 installed", pi.install() == "installed")
        entry = pi.entry_bytes_of(asar)
        check("注入行恰好 1 条", pi.line_count(entry) == 1)
        check("注入行指向当前 runtime", entry.endswith(b"\n" + line))
        check("其它文件字节不变", read_file_from_asar(asar, "package.json") == OTHER_JS)
        check("入口=原字节+\\n+注入行", entry == ENTRY_JS + b"\n" + line)
        check("header 可解析且文件数=2",
              len(dict(pi.iter_files(pi.read_header(open(asar, "rb"))[0]))) == 2)

        # 2. 幂等
        check("重复 install 返回 already", pi.install() == "already")
        check("注入行仍恰好 1 条", pi.line_count(pi.entry_bytes_of(asar)) == 1)

        # 3. pending 快速路径（P2-7）：已有合法 pending 时 install 不动 asar
        entry_before = pi.entry_bytes_of(asar)
        write_pending(td, asar, {"out/main/index.js": ENTRY_JS, "package.json": OTHER_JS})
        check("有 pending 时 install 返回 pending", pi.install() == "pending")
        check("有 pending 时 asar 未被重打包", pi.entry_bytes_of(asar) == entry_before)

        # 4. finalize：指纹匹配 happy path
        check("finalize 匹配分支返回 finalized", pi.finalize_pending() == "finalized")
        check("pending 文件已清理", pending_cleared(td))

        # 4b. asar 被占用（= ZCode 还在跑）必须返回 busy 且保留 pending
        #     这是 v0.1.3 的核心：由操作系统仲裁"能不能替换"，不靠数进程。
        #     用 CreateFileW 以 FILE_SHARE_READ（不含 SHARE_DELETE）打开，
        #     效果与运行中的 ZCode 持有 asar 一致：rename 覆盖会失败。
        if sys.platform == "win32":
            import ctypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateFileW.restype = ctypes.c_void_p
            k32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
                                        ctypes.c_void_p]
            h = k32.CreateFileW(str(asar), 0x80000000, 0x1, None, 3, 0, None)
            check("能构造占用句柄", h not in (None, ctypes.c_void_p(-1).value))
            write_pending(td, asar, {"out/main/index.js": ENTRY_JS + b"\n" + line,
                                     "package.json": OTHER_JS})
            check("占用时 finalize 返回 busy", pi.finalize_pending() == "busy")
            check("占用时 pending 被保留", not pending_cleared(td))
            k32.CloseHandle(ctypes.c_void_p(h))
            check("释放后 finalize 返回 finalized", pi.finalize_pending() == "finalized")
            check("释放后 pending 已清理", pending_cleared(td))

            # 4c. 占用时 uninstall：必须 failed，且绝不能写豁免标记
            #     （否则会出现"号称卸了、注入还在，钩子又被豁免挡住"的死状态）
            pi.OPTOUT_MARKER.unlink(missing_ok=True)
            h2 = k32.CreateFileW(str(asar), 0x80000000, 0x1, None, 3, 0, None)
            check("能再次构造占用句柄", h2 not in (None, ctypes.c_void_p(-1).value))
            check("占用时 uninstall 返回 failed", pi.uninstall() == "failed")
            check("占用时 uninstall 不写豁免标记", not pi.OPTOUT_MARKER.exists())
            k32.CloseHandle(ctypes.c_void_p(h2))

        # 5. finalize 失配分支（R5）：他人（zusage）替换过 asar
        #    模拟：zusage 在我们挂起 pending 期间替换了 asar（我们的行没了）
        foreign_entry = b'console.log("host main v2");\nexport default null;\n' + (
            b';import("file:///C:/Users/x/.zcode/zcode-token-usage-statusbar/inject-main.cjs")'
            b'.then(() => null, (e) => console.error("[zusage] load failed", e));'
        )
        build_asar(asar, {"out/main/index.js": foreign_entry, "package.json": OTHER_JS})
        write_pending(td, asar,
                      {"out/main/index.js": ENTRY_JS + b"\n" + line, "package.json": OTHER_JS},
                      source_fp=[1, 1, 0, 1])
        check("finalize 失配走重打包分支", pi.finalize_pending() == "finalized-rederived")
        entry = pi.entry_bytes_of(asar)
        check("重打包后我们的行在且唯一", pi.line_count(entry) == 1)
        check("重打包后 zusage 行保留", b"inject-main.cjs" in entry)
        check("重打包后其它文件不变", read_file_from_asar(asar, "package.json") == OTHER_JS)
        check("pending 文件已清理", pending_cleared(td))

        # 6. sidecar 损坏：孤儿 TMP 丢弃，不碰 asar
        entry_before = pi.entry_bytes_of(asar)
        (td / pi.TMP_NAME).write_bytes(b"garbage")
        (td / pi.SIDECAR_NAME).write_text("{not json", "utf-8")
        check("sidecar 损坏返回 no-pending", pi.finalize_pending() == "no-pending")
        check("损坏孤儿已清理", pending_cleared(td))
        check("asar 未被损坏孤儿影响", pi.entry_bytes_of(asar) == entry_before)

        # 7. optout 阻断收尾（P1-2）
        pi.OPTOUT_MARKER.write_text("", "utf-8")
        write_pending(td, asar, {"out/main/index.js": ENTRY_JS + b"\n" + line,
                                 "package.json": OTHER_JS})
        check("optout 时 finalize 返回 optout", pi.finalize_pending() == "optout")
        check("optout 后 pending 已清理", pending_cleared(td))
        pi.OPTOUT_MARKER.unlink()
        # optout 状态下 install 也必须短路
        pi.OPTOUT_MARKER.write_text("", "utf-8")
        check("optout 时 install 返回 optout", pi.install() == "optout")
        pi.OPTOUT_MARKER.unlink()

        # 7b. optout 在"锁外检查之后、拿到锁之前"出现（卸载与安装/收尾的竞态）：
        #     假标记第一次 exists()=False 骗过锁外检查，第二次 True 验证锁内复查。
        class _LateOptout:
            def __init__(self):
                self.calls = 0

            def exists(self):
                self.calls += 1
                return self.calls >= 2

            def unlink(self, missing_ok=False):
                pass

            def __str__(self):
                return "<late-optout>"

            @property
            def parent(self):
                return pi.DATA_DIR

        real_marker = pi.OPTOUT_MARKER
        try:
            pi.OPTOUT_MARKER = _LateOptout()
            check("install 锁内复查到后写 optout", pi.install() == "optout")
            write_pending(td, asar, {"out/main/index.js": ENTRY_JS + b"\n" + line,
                                     "package.json": OTHER_JS})
            pi.OPTOUT_MARKER = _LateOptout()
            check("finalize 锁内复查到后写 optout", pi.finalize_pending() == "optout")
            check("锁内 optout 后 pending 已清理", pending_cleared(td))
        finally:
            pi.OPTOUT_MARKER = real_marker
            pi._clear_pending(asar.parent)

        # 恢复到已注入状态供 remove 用
        pi.install()

        # 8. remove
        check("remove 返回 removed", pi.remove() == "removed")
        entry = pi.entry_bytes_of(asar)
        check("我们的行消失", pi.line_count(entry) == 0)
        check("zusage 行仍保留", b"inject-main.cjs" in entry)
        check("其余内容字节级不变", entry == foreign_entry)
        check("重复 remove 返回 already", pi.remove() == "already")

        # 9. uninstall：市场安装用户的一键卸载（剥注入 + 写豁免，顺序不可反）
        pi.install()
        check("重新注入成功", pi.line_count(pi.entry_bytes_of(asar)) == 1)
        check("uninstall 返回 uninstalled", pi.uninstall() == "uninstalled")
        check("uninstall 后注入行消失", pi.line_count(pi.entry_bytes_of(asar)) == 0)
        check("uninstall 写了豁免标记", pi.OPTOUT_MARKER.exists())
        check("卸载后 install 被豁免挡住", pi.install() == "optout")

    print("== smoke_asar 结果：", "PASS" if ok else "FAIL", "==")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
