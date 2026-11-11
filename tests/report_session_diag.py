#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""report 多会话归因/补页明细的边界：旧样本、暂停回退、空数组、坏行。

覆盖三审里暴露的边界：
- JSONL 行是 null/数组/字符串时 load_lines 不能崩；
- _fmt_ts(0/None) 不能显示成 1970 年；
- sessions 里有非 dict 元素时按 dict 计数、逐行跳过；
- loadOlderDetail 未变化时发 []，要向前找最近一次非空；
- trigger 是 list 等非 hashable 值时归入 unknown；
- rowsBefore==rowsAfter 标“无变化”，ok 只叫“正常/异常”。
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "zcode-lagfix"
sys.path.insert(0, str(PLUGIN_DIR))
import lagfix_report as lr  # noqa: E402

ok = True


def check(name: str, cond: bool, detail: str = "") -> None:
    global ok
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))
    ok = ok and cond


def run_print(rows: list[dict]) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        lr.print_session_diag(rows)
    return buf.getvalue()


def main() -> int:
    print("-- _fmt_ts --")
    check("None/0/负数都显示 -",
          lr._fmt_ts(None) == "-" and lr._fmt_ts(0) == "-" and lr._fmt_ts(-5) == "-")
    check("有效时间戳显示 HH:MM:SS",
          bool(re.fullmatch(r"\d\d:\d\d:\d\d", lr._fmt_ts(1730000000000))))

    normal = {
        "settings": {"sessionDiagOn": True, "scrollDiagOn": True},
        "sessions": [
            {"sid": "sess_real", "visible": True, "lastActive": 1730000000000,
             "frames": 12, "commitRate": 2.5, "mountedTurns": 3, "dom": 900,
             "scrollP95": 48},
            {"sid": "draft", "visible": False, "lastActive": 0, "frames": 0,
             "commitRate": None, "mountedTurns": 0, "dom": 0, "scrollP95": None},
            {"sid": "", "visible": True, "lastActive": None, "frames": 1,
             "commitRate": None, "mountedTurns": 1, "dom": 10, "scrollP95": None},
            "bad-row",
        ],
        "loadOlderDetail": [
            {"t": 1730000001000, "ms": 7298, "ok": True,
             "rowsBefore": 60, "rowsAfter": 120, "trigger": "scroll"},
            {"t": 1730000002000, "ms": 0, "ok": True,
             "rowsBefore": 60, "rowsAfter": 60, "trigger": "initial"},
            {"t": 1730000003000, "ms": 120, "ok": False,
             "rowsBefore": 120, "rowsAfter": 120, "trigger": ["bad"]},
        ],
    }

    print("-- 正常样本 --")
    out = run_print([{"ver": "0.3.1"}, normal])
    check("会话桶按 dict 计数（忽略坏行）", "3 个会话桶" in out, out.splitlines()[0])
    check("draft 与空 sid 都能显示", "draft" in out and "(空)" in out)
    check("Top 慢补页取最大 ms", "Top 慢补页：7298ms" in out)
    check("trigger 三态计数（坏值归 unknown）",
          "触发来源：scroll 1 / initial 1 / unknown 1" in out)
    check("无行数变化标出「无变化」", out.count("（无变化）") == 2)
    check("失败叫「异常」且明细行不再叫「失败」",
          "异常" in out and "  失败" not in out)
    check("ok 语义有提示", "正常仅表示 promise 结算无异常" in out)

    print("-- 暂停/未变化：向前回退到最近有效样本 --")
    paused = {"settings": {"sessionDiagOn": True, "scrollDiagOn": True},
              "sessions": None, "loadOlderDetail": []}
    out = run_print([normal, paused])
    check("暂停时 sessions 回退到上一份数据",
          "3 个会话桶（最近一次有效样本）" in out)
    check("明细为空时向前找到最近一次非空",
          "补页明细：最近 3 次（最近一次有效样本）" in out and "7298ms" in out)

    print("-- 开关关闭 --")
    disabled = {"settings": {"sessionDiagOn": False, "scrollDiagOn": False},
                "sessions": None, "loadOlderDetail": None}
    out = run_print([disabled])
    check("明确提示多会话归因已关闭", "多会话归因已关闭" in out)
    check("明确提示滚动诊断已关闭", "滚动诊断已关闭，无补页明细" in out)
    # 关闭样本必须阻断向前回退，不能把关闭前的旧明细当当前数据。
    out = run_print([normal, {"settings": {"scrollDiagOn": True},
                              "loadOlderDetail": []}, disabled])
    check("关闭边界阻断明细向前回退",
          "滚动诊断已关闭，无补页明细" in out and "7298ms" not in out)
    check("关闭边界阻断会话桶向前回退",
          "多会话归因已关闭" in out and "sess_rea" not in out)

    print("-- 空/坏数据 --")
    out = run_print([{"sessions": [1, "x", None], "loadOlderDetail": [1]}])
    check("全是非 dict 时显示 0 个桶", "0 个会话桶" in out)
    check("明细全是坏行时不崩", "补页明细为空" in out)
    out = run_print([])
    check("空 rows 不崩", "无多会话归因数据" in out and "无补页明细" in out)
    out = run_print([{"sessions": ["x"], "loadOlderDetail": []}])
    check("空明细 + 无旧数据给出尚未调用", "尚未调用 loadOlder" in out)

    print("-- load_lines 坏行 --")
    with tempfile.TemporaryDirectory(prefix="lagfix-report-") as td:
        p = Path(td) / "observe-20261111.jsonl"
        p.write_text("\n".join([
            "not-json",
            "null",
            "[1,2]",
            "\"str\"",
            json.dumps({"win": 1, "t": 2, "d": {"sessions": []}}),
        ]), "utf-8")
        rows = lr.load_lines(p)
        check("非 dict 的 JSONL 行被跳过", len(rows) == 1, f"n={len(rows)}")
        check("有效行保留 d 字段", rows and rows[0].get("sessions") == [])

    print("== report_session_diag 结果：", "PASS" if ok else "FAIL", "==")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
