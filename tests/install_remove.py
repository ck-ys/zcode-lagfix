#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""install.py do_remove 的异常边界（不碰真实安装目录）。

覆盖三审指出的三个缺口：
1. remove 已提交（注入行已消失）后收到 Ctrl+C：必须保留 optout，否则下次启动
   SessionStart 会把刚剥掉的注入装回来。
2. remove 失败（ZCode 占用/ACL）：必须撤回 optout。
3. asar 已剥离但 set_plugin_enabled 失败：保留 optout 并返回可读错误。
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import install as inst  # noqa: E402

ok = True


def check(name: str, cond: bool, extra: str = "") -> None:
    global ok
    if not cond:
        ok = False
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  {extra}" if extra else ""))


class FakePi:
    def __init__(self, present: int, exc: BaseException | None = None, result: str = "removed"):
        self.present = present
        self.exc = exc
        self.result = result

    def remove(self) -> str:
        if self.exc is not None:
            raise self.exc
        return self.result

    def injected_status(self) -> dict:
        return {"present": self.present}


def run_case(name: str, fake: FakePi, plugin_exc: BaseException | None = None) -> tuple[int, Path, Path]:
    with tempfile.TemporaryDirectory() as td:
        data = Path(td)
        marker = data / ".lagfix-optout"
        old_data = inst.DATA_DIR
        old_patch = inst._patch
        old_enable = inst.set_plugin_enabled
        inst.DATA_DIR = data
        inst._patch = lambda: fake  # type: ignore[assignment]

        def _enable(_v: bool) -> None:
            if plugin_exc is not None:
                raise plugin_exc

        inst.set_plugin_enabled = _enable  # type: ignore[assignment]
        try:
            rc = inst.do_remove()
            # 目录会在 with 结束时删除；把关键状态复制到临时目录外再返回不可行，
            # 所以这里在退出前把 marker 是否存在记到 fake 上。
            fake.marker_existed = marker.exists()  # type: ignore[attr-defined]
            return rc, marker, data
        finally:
            inst.DATA_DIR = old_data
            inst._patch = old_patch
            inst.set_plugin_enabled = old_enable


print("== install.py do_remove 异常边界 ==")

# 1) remove 已提交后 Ctrl+C：present=0 → 保留标记
f1 = FakePi(present=0, exc=KeyboardInterrupt())
rc1, _, _ = run_case("ctrl-c-after-remove", f1)
check("remove 已提交后 Ctrl+C 返回 130", rc1 == 130, f"rc={rc1}")
check("remove 已提交后 Ctrl+C 保留 optout", getattr(f1, "marker_existed", False))

# 2) remove 因占用失败：present=1 → 撤回标记
f2 = FakePi(present=1, result="failed")
rc2, _, _ = run_case("busy", f2)
check("remove 返回 failed 时退出码 1", rc2 == 1, f"rc={rc2}")
check("remove 失败时不留下 optout", not getattr(f2, "marker_existed", True))

# 3) remove 抛异常：present=1 → 撤回标记
f3 = FakePi(present=1, exc=SystemExit("busy"))
rc3, _, _ = run_case("raise", f3)
check("remove 抛 SystemExit 时退出码 1", rc3 == 1, f"rc={rc3}")
check("remove 抛异常时不留下 optout", not getattr(f3, "marker_existed", True))

# 4) asar 已剥离但插件启用态写失败：标记必须保留，返回 1
f4 = FakePi(present=0, result="removed")
rc4, _, _ = run_case("plugin-enable-fail", f4, plugin_exc=SystemExit("bad config"))
check("set_plugin_enabled 失败返回 1", rc4 == 1, f"rc={rc4}")
check("set_plugin_enabled 失败仍保留 optout", getattr(f4, "marker_existed", False))

print("== 结果：", "PASS" if ok else "FAIL", "==")
sys.exit(0 if ok else 1)
