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


def run_pane(rows: list[dict]) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        lr.print_pane_diag(rows)
    return buf.getvalue()


def run_scroll(rows: list[dict]) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        lr.print_scroll_diag(rows)
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
    check("逐行坏 trigger 也归一为 unknown", "触发 unknown" in out)
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
    # 更新的暂停样本在上、关闭样本在下：回退必须停在关闭边界，不能穿透到更早的数据。
    out = run_print([normal, disabled, paused])
    check("暂停回退遇到关闭边界即停（会话桶）",
          "多会话归因已关闭" in out and "sess_rea" not in out, out)
    check("暂停回退遇到关闭边界即停（补页明细）",
          "未记录到补页明细" in out and "7298ms" not in out, out)

    print("-- 空/坏数据 --")
    out = run_print([{"sessions": [1, "x", None], "loadOlderDetail": [1]}])
    check("全是非 dict 时显示 0 个桶", "0 个会话桶" in out)
    check("明细全是坏行时不崩", "未记录到补页明细" in out)
    out = run_print([])
    check("空 rows 不崩", "无多会话归因数据" in out and "无补页明细" in out)
    out = run_print([{"sessions": ["x"], "loadOlderDetail": []}])
    check("空明细 + 无旧数据给出尚未调用", "尚未调用 loadOlder" in out)

    print("-- v0.3.3 侧栏开合 / 回前台 --")
    pane_closed = {
        "settings": {"paneDiagOn": True},
        "frameP95": 40, "longTasks": 2, "dom": 1000, "hidden": False, "miss": False,
        "pane": {"detected": True, "open": False, "panelPx": 0, "switches": 1,
                 "switchP95": 60, "switchMax": 90, "guardHits": 1},
        "refocus": {"hiddenMs": None, "sinceVisibleMs": None, "p95": None,
                    "max": None, "flushes": 0, "guardHits": 0},
    }
    pane_open = {
        "settings": {"paneDiagOn": True},
        "frameP95": 120, "longTasks": 20, "dom": 5000, "hidden": False, "miss": False,
        "pane": {"detected": True, "open": True, "panelPx": 720, "switches": 3,
                 "switchP95": 84, "switchMax": 190, "guardHits": 3},
        "refocus": {"hiddenMs": 8200, "sinceVisibleMs": 240, "p95": 96,
                    "max": 210, "flushes": 2, "guardHits": 1},
    }
    out = run_pane([pane_closed, pane_open])
    check("侧栏最近一次 open/宽度/开合次数",
          "open=true" in out and "宽度=720px" in out and "开合 3 次" in out, out)
    check("最近一次开合 P95/最长", "帧 P95=84ms" in out and "最长=190ms" in out)
    check("open/closed 分组帧 P95 中位数",
          "open 样本 1 条：帧 P95 中位 120" in out
          and "closed 样本 1 条：帧 P95 中位 40" in out, out)
    check("open/closed 分组长任务与 DOM",
          "长任务中位 20" in out and "DOM 中位 5000" in out)
    check("回前台 hiddenMs/p95/max/flushes",
          "上次后台 8200ms" in out and "帧 P95=96ms" in out
          and "合并补发 2 个" in out, out)

    missing = {"settings": {"paneDiagOn": True},
               "pane": {"detected": False, "open": False, "panelPx": None,
                        "switches": 0, "switchP95": None, "switchMax": None,
                        "guardHits": 0},
               "refocus": {"hiddenMs": None, "sinceVisibleMs": None, "p95": None,
                           "max": None, "flushes": 0, "guardHits": 0}}
    out = run_pane([missing])
    check("detected=false 明确提示宿主标记缺失",
          "detected=false" in out and "无法归因" in out, out)

    disabled = {"settings": {"paneDiagOn": False}, "pane": None, "refocus": None}
    out = run_pane([pane_open, disabled])
    check("paneDiagOn=false 明确提示已关闭",
          "侧栏 + 回前台归因已关闭" in out, out)
    check("关闭边界阻断旧 pane/refocus 回退",
          "720px" not in out and "8200ms" not in out, out)

    paused = {"settings": {"paneDiagOn": True}, "pane": None, "refocus": None}
    out = run_pane([pane_open, paused])
    check("暂停时 pane 回退到最近有效样本",
          "（最近一次有效样本）" in out and "720px" in out, out)
    check("暂停时 refocus 回退到最近有效样本",
          "8200ms" in out and "（最近一次有效样本）" in out)

    old = {"frameP95": 30, "longTasks": 0, "dom": 100}
    out = run_pane([old])
    check("旧样本没有 pane/refocus 字段时提示，不报错",
          "无侧栏 + 回前台归因数据" in out, out)
    out = run_pane([])
    check("空 rows 不崩", "无侧栏 + 回前台归因数据" in out, out)

    bucket_rows = []
    for ms in (500, 5000, 30000, 90000):
        bucket_rows.append({
            "settings": {"paneDiagOn": True},
            "pane": {"detected": True, "open": True, "panelPx": 600,
                     "switches": 1, "switchP95": 50, "switchMax": 60, "guardHits": 1},
            "refocus": {"hiddenMs": ms, "sinceVisibleMs": 100, "p95": 70,
                        "max": 120, "flushes": 1, "guardHits": 1},
        })
    out = run_pane(bucket_rows)
    check("回前台按 hiddenMs 四档分桶",
          "<1s 1 / 1–10s 1 / 10–60s 1 / >60s 1" in out, out)

    # hiddenMs 是持久字段：同一次回前台会在后续每个样本重复出现，不能按行计数。
    repeat_rows = [dict(bucket_rows[1], refocus=dict(bucket_rows[1]["refocus"],
                                                     hiddenMs=8200, sinceVisibleMs=s))
                   for s in (100, 5000, 10000)]
    out = run_pane(repeat_rows)
    check("同一次回前台重复样本只计一次",
          "1–10s 1 /" in out and "1–10s 3" not in out, out)
    # 两次回前台恰好都是 8.2s：sinceVisibleMs 回退要能识别成新事件。
    out = run_pane([repeat_rows[0], repeat_rows[2], dict(repeat_rows[0],
                                                         refocus=dict(repeat_rows[0]["refocus"],
                                                                      hiddenMs=8200,
                                                                      sinceVisibleMs=100))])
    check("相同后台时长的新回前台仍计一次",
          "1–10s 2" in out, out)
    check("缺 refocus 字段时明确提示而不是静默",
          "无回前台数据" in run_pane([{"settings": {"paneDiagOn": True},
                                        "pane": pane_open["pane"]}]), out)

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

    print("-- v0.3.4 LoAF 归因 + pace 计数 --")

    def run_laf(rows2):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            lr.print_laf_diag(rows2)
        return buf.getvalue()

    def run_timer(rows2):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            lr.print_timer_diag(rows2)
        return buf.getvalue()

    def run_switch(rows2):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            lr.print_switch_diag(rows2)
        return buf.getvalue()

    laf_entry = {
        "t": 1730000099000, "ms": 812, "styleMs": 143,
        "scripts": [
            {"src": "index-a1b2.js", "invoker": "SCRIPT.getElementById:onclick", "ms": 402},
            {"src": "vendor.js", "invoker": "Promise.then", "ms": 90},
            "bad-script",
            {"src": None, "invoker": None, "ms": None},
        ],
    }
    laf_on = {
        "settings": {"lafDiagOn": True, "loadOlderPaceOn": True},
        "laf": {"supported": 1, "count": 3, "max": 812, "detail": [laf_entry]},
        "pace": {"minRows": 3000, "intervalMs": 600, "allowed": 4, "skipped": 9},
    }
    out = run_laf([laf_on])
    check("laf 归因打印本周期计数与最长值",
          "本周期长帧 3 次" in out and "812ms" in out, out)
    check("明细行带脚本 top3 与强制布局占比",
          "index-a1b2.js 402ms" in out and "强制布局 143ms" in out, out)
    agg_line = next((ln for ln in out.splitlines() if "窗口内脚本耗时聚合" in ln), "")
    check("脚本耗时聚合行内容与排序正确（402 在前，坏行/None 不进聚合）",
          "index-a1b2.js 402ms" in agg_line
          and "vendor.js 90ms" in agg_line
          and "?" not in agg_line
          and agg_line.index("index-a1b2.js") < agg_line.index("vendor.js"), agg_line)
    check("非 dict 脚本行被跳过不炸", "bad-script" not in out and "Traceback" not in out, out)
    detail_line = next((ln for ln in out.splitlines() if "←" in ln), "")
    check("None src 在明细行归到 ?（且 None ms 显示为 -）",
          "?" in detail_line and "-" in detail_line, detail_line)

    # 实机口径（2026-11-11）：宿主脚本 sourceURL 实测全空，改由 invoker 归类，
    # 否则明细和聚合会整片塌成 "?"，归因等于没用。
    laf_nosrc = {
        "settings": {"lafDiagOn": True},
        "laf": {"supported": 1, "count": 2, "max": 140, "detail": [{
            "t": 1730000099000, "ms": 140, "styleMs": 34,
            "scripts": [
                {"src": "", "invoker": "TimerHandler:setTimeout", "ms": 59},
                {"src": "", "invoker": "TimerHandler:setInterval", "ms": 45},
            ],
        }]},
    }
    out_nosrc = run_laf([laf_nosrc])
    check("sourceURL 为空时明细行用 invoker 归类",
          "TimerHandler:setTimeout 59ms" in out_nosrc
          and "TimerHandler:setInterval 45ms" in out_nosrc, out_nosrc)
    agg_nosrc = next((ln for ln in out_nosrc.splitlines() if "窗口内脚本耗时聚合" in ln), "")
    check("空 src 的聚合按 invoker 分组而不是塌成 ?",
          "TimerHandler:setTimeout 59ms" in agg_nosrc
          and "TimerHandler:setInterval 45ms" in agg_nosrc
          and "?" not in agg_nosrc, agg_nosrc)
    check("pace 打印参数与放行/跳过计数",
          "触发间隔 600ms" in out and "放行 4 次" in out and "跳过 9 次" in out, out)

    # detail 未变化发 []：向前找最近一次非空
    out = run_laf([laf_on, dict(laf_on, laf=dict(laf_on["laf"], detail=[]))])
    check("detail=[] 时回退到最近非空样本并标注",
          "index-a1b2.js" in out and "最近一次有效明细" in out, out)

    # 开启但没有任何 ≥100ms 记录
    out = run_laf([{"settings": {"lafDiagOn": True},
                    "laf": {"supported": 1, "count": 1, "max": 60, "detail": []}}])
    check("开启但无长帧记录时如实提示",
          "没有 ≥100ms 的长帧记录" in out, out)

    # 浏览器不支持
    out = run_laf([{"settings": {"lafDiagOn": True},
                    "laf": {"supported": 0, "count": 0, "max": None, "detail": []}}])
    check("supported=0 明确提示不支持",
          "不支持 long-animation-frame" in out, out)

    # 开关关闭：明确「已关闭」，不把旧数据当当前数据
    out = run_laf([{"settings": {"lafDiagOn": False, "loadOlderPaceOn": False},
                    "laf": None, "pace": None}])
    check("lafDiagOn=false 时提示已关闭", "卡顿来源定位已关闭" in out, out)
    check("loadOlderPaceOn=false 时提示已关闭（实验项）",
          "翻页降频已关闭" in out, out)

    # 旧样本没有字段
    out = run_laf([{"settings": {}, "ver": "0.3.3"}])
    check("旧样本（无 laf/pace 字段）不报错",
          "无卡顿来源数据" in out and "无翻页降频数据" in out and "Traceback" not in out, out)

    # pace 开启但还没触发过
    out = run_laf([{"settings": {"lafDiagOn": True, "loadOlderPaceOn": True},
                    "laf": None,
                    "pace": {"minRows": 3000, "intervalMs": 600, "allowed": 0, "skipped": 0}}])
    check("pace 0/0 时如实说明包装未装上或本周期无调用",
          "放行 0 次" in out and "跳过 0 次" in out
          and "包装可能尚未装上，或本周期内没有补页调用" in out, out)

    # v0.4.3：双口径（本轮 + 全天累计）并列显示；旧样本没有累计字段时回退。
    out = run_laf([{"settings": {"lafDiagOn": True, "loadOlderPaceOn": True},
                    "laf": None,
                    "pace": {"minRows": 3000, "intervalMs": 600, "allowed": 2,
                             "skipped": 1, "totalAllowed": 9, "totalSkipped": 4}}])
    check("pace 双口径并列显示",
          "本轮放行 2 次 / 跳过 1 次" in out
          and "全天累计放行 9 次 / 跳过 4 次" in out, out)
    out = run_laf([{"settings": {"lafDiagOn": True, "loadOlderPaceOn": True},
                    "laf": None,
                    "pace": {"minRows": 3000, "intervalMs": 600,
                             "allowed": 2, "skipped": 1}}])
    check("旧 pace 样本没有累计口径时如实标注",
          "旧样本没有全天累计口径" in out and "全天累计放行" not in out, out)

    # 暂停样本（laf=None 且 lafDiagOn 仍开）：向前回退找有效数据
    out = run_laf([laf_on, dict(laf_on, laf=None, pace=None)])
    check("暂停样本回退到最近一次有效 laf",
          "index-a1b2.js" in out, out)

    print("-- v0.4.3 P0 会话切换归因 --")
    sw_item = {
        "t": 1730000100000, "from": "sess_tes", "to": "sess_d7d",
        "afterMax2s": 530, "afterP95": 320, "lafN2s": 2, "styleMs2s": 156,
        "lafN30s": 5, "styleMs30s": 300, "loadOlderN30s": 10,
        "loadOlderMs30s": 1500, "domBefore": 5000, "domAfter": 6000,
        "turnsBefore": 40, "turnsAfter": 45, "blockedLoadAll": 1, "settled": 1,
    }
    sw_on = {"settings": {"switchDiagOn": True},
             "switch": {"on": 1, "items": [sw_item]}}
    out = run_switch([sw_on])
    check("switch 正常形状打印双窗口与最重一次",
          "切换会话归因：最近 1 次切换" in out and "2s 最重 530ms" in out
          and "补页 10 次" in out and "sess_tes" in out and "sess_d7d" in out
          and "最重一次" in out, out)
    # items=[] 表示未变化：向前找最近一次非空（与 loadOlderDetail 同约定）。
    out = run_switch([sw_on, {"settings": {"switchDiagOn": True},
                           "switch": {"on": 1, "items": []}}])
    check("switch items=[] 时回退到最近非空样本",
          "sess_d7d" in out and "切换会话归因：最近 1 次切换" in out, out)
    # 未满 30 秒：必须标注窗口未满，不能把半截数据当最终结论。
    sw_partial = dict(sw_item, settled=0, domAfter=None, turnsAfter=None,
                      blockedLoadAll=None)
    out = run_switch([{"settings": {"switchDiagOn": True},
                    "switch": {"on": 1, "items": [sw_partial]}}])
    check("settled=0 时标注 30 秒窗口未满",
          "30 秒窗口未满" in out and "2s 最重 530ms" in out, out)
    # 关闭态优先：不打印旧记录。
    out = run_switch([sw_on, {"settings": {"switchDiagOn": False}, "switch": None}])
    check("最新样本关闭时提示已关闭且不打印旧记录",
          "切换会话归因已关闭" in out and "sess_d7d" not in out, out)
    # 开着但本文件没有切换。
    out = run_switch([{"settings": {"switchDiagOn": True},
                    "switch": {"on": 1, "items": []}}])
    check("开启但无切换记录时如实提示",
          "本文件内没有切换记录" in out, out)
    # 旧样本没有该字段。
    out = run_switch([{"settings": {}, "ver": "0.3.5"}])
    check("旧样本无 switch 字段时提示本版本未记录",
          "本版本未记录切换归因" in out and "Traceback" not in out, out)
    # 坏形状：switch 是数字、items 混入非 dict → 不抛异常。
    out = run_switch([{"settings": {"switchDiagOn": True}, "switch": 7}])
    check("switch 非字典时不炸", "Traceback" not in out, out)
    out = run_switch([{"settings": {"switchDiagOn": True},
                    "switch": {"on": 1, "items": [7, "x", {"t": "bad"}]}}])
    check("switch items 坏形状不炸", "Traceback" not in out, out)
    # v0.4.3 三审：数值字段被写成字符串/NaN 时按 0 处理，不能吓崩整段。
    sw_badnum = dict(sw_item, afterMax2s="bad", afterP95=None, lafN2s="x",
                     styleMs2s=float("nan"), loadOlderN30s="?", loadOlderMs30s=None,
                     domBefore="no", domAfter=6000)
    out = run_switch([{"settings": {"switchDiagOn": True},
                    "switch": {"on": 1, "items": [sw_badnum]}}])
    check("switch 数值坏形状按 0/未测量处理",
          "Traceback" not in out and "2s 无帧切片" in out
          and "长帧 0 次" in out and "补页 0 次" in out
          and "DOM" not in out, out)
    # 被下一次切换截断：冻结但窗口不满 30 秒，必须标注，不能当完整结论。
    sw_early = dict(sw_item, settled=1, settledEarly=1)
    out = run_switch([{"settings": {"switchDiagOn": True},
                    "switch": {"on": 1, "items": [sw_early]}}])
    check("settledEarly=1 时标注窗口被下一次切换截断",
          "窗口被下一次切换截断" in out and "30 秒窗口未满" not in out, out)
    # 中途关过又重开、但还没有新切换：既不能说「已关闭」，也不能说「没有记录」。
    out = run_switch([
        {"settings": {"switchDiagOn": False}, "switch": None},
        {"settings": {"switchDiagOn": True}, "switch": {"on": 1, "items": []}},
    ])
    check("关闭过又重开时提示「曾关闭；重开后还没有新的切换记录」",
          "曾关闭" in out and "重开后还没有新的切换记录" in out
          and "已关闭" not in out and "没有切换记录" not in out, out)
    # 暂停/自禁用：明说状态，但历史记录仍展示。
    out = run_switch([sw_on, {"settings": {"switchDiagOn": True, "observe": False},
                           "switch": None}])
    check("暂停时提示已暂停并保留历史记录",
          "切换会话归因已暂停" in out and "sess_d7d" in out, out)
    out = run_switch([sw_on, {"settings": {"switchDiagOn": True}, "dead": True,
                           "switch": None}])
    check("自禁用时提示观测器已自禁用并保留历史记录",
          "观测器已自禁用" in out and "sess_d7d" in out, out)

    print("-- v0.3.4 终审：状态判定看最新样本 / 坏形状不炸 --")
    # P1-3：先关闭过、后来重开但暂停 —— 不能被判成「已关闭」
    off_then_paused = [
        {"settings": {"lafDiagOn": False}, "laf": None},
        {"settings": {"lafDiagOn": True, "observe": False}, "laf": None},
    ]
    out = run_laf(off_then_paused)
    check("重开后暂停：报「已暂停」而不是「已关闭」",
          "卡顿来源定位已暂停" in out and "已关闭" not in out, out)
    # 自禁用同理
    off_then_dead = [
        {"settings": {"lafDiagOn": False}, "laf": None},
        {"settings": {"lafDiagOn": True}, "laf": None, "dead": True},
    ]
    out = run_laf(off_then_dead)
    check("重开后自禁用：报「已自禁用」而不是「已关闭」",
          "观测器已自禁用" in out and "已关闭" not in out, out)
    # 最新样本真的是关闭态 → 报已关闭
    out = run_laf([laf_on, {"settings": {"lafDiagOn": False}, "laf": None}])
    check("最新样本是关闭态才报「已关闭」", "卡顿来源定位已关闭" in out, out)
    # P2-1：detail/scripts 是数字时不能抛异常
    bad_shapes = {"settings": {"lafDiagOn": True, "loadOlderPaceOn": True},
                  "laf": {"supported": 1, "count": 1, "max": 200, "detail": 5},
                  "pace": {"minRows": 3000, "intervalMs": 600, "allowed": 0, "skipped": 0}}
    out = run_laf([bad_shapes])
    check("detail 非列表时不炸", "Traceback" not in out, out)
    bad_scripts = {"settings": {"lafDiagOn": True},
                   "laf": {"supported": 1, "count": 1, "max": 200,
                           "detail": [{"t": 1730000099000, "ms": 200, "styleMs": 0,
                                       "scripts": 7}]}}
    out = run_laf([bad_scripts])
    check("scripts 非列表时不炸", "Traceback" not in out, out)

    print("-- v0.3.5 P0 长帧上下文归因 --")
    ctx_entry = {
        "t": 1730000100000, "ms": 180, "styleMs": 20,
        "src": "flush", "sinceFlush": 0, "sinceNotify": 3,
        "sinceScroll": 240, "sinceCommit": 18,
        "scripts": [{"src": "index-a1b2.js", "invoker": "TimerHandler:setTimeout", "ms": 90}],
    }
    laf_ctx = {
        "settings": {"lafDiagOn": True, "lafCtxOn": True},
        "paneOpen": True, "panelQuiet": 1,
        "laf": {"supported": 1, "count": 4, "max": 180,
                "ctx": {"flush": 2, "notify": 1, "scroll": 1, "other": 0},
                "detail": [ctx_entry]},
    }
    out = run_laf([laf_ctx])
    check("来源分布按中文打印四类计数",
          "节流补发 2" in out and "通知到达 1" in out and "滚动 1" in out and "其它 0" in out,
          out)
    check("面板状态行打印打开 + 面板期合并生效",
          "当前面板：打开" in out and "面板期进一步合并已生效" in out, out)
    check("明细行带来源与四个时间差",
          "来源=节流补发" in out and "距补发 0ms" in out and "距通知 3ms" in out
          and "距滚动 240ms" in out and "距提交 18ms" in out, out)
    # other + sinceCommit<=50：提示紧跟宿主提交，帮助判断宿主渲染成本。
    other_entry = dict(ctx_entry, src="other", sinceCommit=20)
    out = run_laf([dict(laf_ctx, laf=dict(laf_ctx["laf"], detail=[other_entry]))])
    check("other 且提交很近时提示「紧跟宿主提交」",
          "来源=其它" in out and "紧跟宿主提交" in out, out)
    # P0 关闭：ctx=null，报告提示来源细分关闭而不是「没有卡顿」。
    out = run_laf([{"settings": {"lafDiagOn": True, "lafCtxOn": False},
                    "laf": {"supported": 1, "count": 0, "max": None,
                            "ctx": None, "detail": []}}])
    check("lafCtxOn=false 时提示来源细分已关闭",
          "长帧来源细分已关闭" in out, out)
    # 旧样本没有 ctx：只提示版本未记录，不炸。
    out = run_laf([{"settings": {"lafDiagOn": True},
                    "laf": {"supported": 1, "count": 1, "max": 120, "detail": []}}])
    check("旧样本无 ctx 时提示本版本未记录",
          "本版本未记录长帧来源细分" in out, out)
    # 三审 P1 回归：旧样本有 detail+ctx，最新样本关闭细分 → 必须报「已关闭」，
    # 不能把旧 ctx 当本周期，也不能继续打印旧明细的 src。
    rows_old_then_off = [
        {"settings": {"lafDiagOn": True, "lafCtxOn": True},
         "laf": {"supported": 1, "count": 3, "max": 180,
                 "ctx": {"flush": 2, "notify": 1, "scroll": 0, "other": 0},
                 "detail": [ctx_entry]}},
        {"settings": {"lafDiagOn": True, "lafCtxOn": False},
         "laf": {"supported": 1, "count": 0, "max": None,
                 "ctx": None, "detail": []}},
    ]
    out = run_laf(rows_old_then_off)
    check("最新样本关闭时不打印旧来源分布/旧来源明细",
          "长帧来源细分已关闭" in out
          and "本周期长帧来源" not in out
          and "来源=节流补发" not in out, out)
    # NaN / Infinity：json.loads 默认接受，报告不能因此 traceback。
    nan_ctx = {
        "settings": {"lafDiagOn": True, "lafCtxOn": True},
        "laf": {"supported": 1, "count": 1, "max": float("inf"),
                "ctx": {"flush": float("nan"), "notify": 1,
                        "scroll": 1, "other": 1},
                "detail": [{
                    "t": 1730000100000, "ms": float("inf"), "styleMs": float("nan"),
                    "src": "flush", "sinceFlush": float("nan"), "sinceNotify": 1,
                    "sinceScroll": 2, "sinceCommit": float("inf"),
                    "scripts": [{"src": "x.js", "invoker": "f", "ms": float("inf")}],
                }]},
    }
    out = run_laf([nan_ctx])
    check("NaN/Infinity 不炸", "Traceback" not in out, out)
    # 坏形状：ctx 是数字、paneOpen 是字符串 → 不抛异常。
    bad_ctx = {"settings": {"lafDiagOn": True, "lafCtxOn": True},
               "paneOpen": "yes", "panelQuiet": "1",
               "laf": {"supported": 1, "count": 1, "max": 120,
                       "ctx": 5, "detail": []}}
    out = run_laf([bad_ctx])
    check("ctx/paneOpen 坏形状不炸", "Traceback" not in out, out)

    print("-- v0.4.3 O8b 退役：补页批量历史计数 --")
    page_ok = {"settings": {"loadOlderPageLimitOn": True},
               "page": {"limit": 120, "minRows": 3000, "burstMs": 600,
                        "installed": True, "applied": 12, "downgraded": 5,
                        "small": 2, "passthrough": 3}}
    out = run_laf([page_ok])
    check("旧 page 计数照常显示并统一标注已退役",
          "已退役" in out and "每页最多 120 行" in out
          and "已生效 12 次" in out and "连续补页降回 60 行 5 次" in out
          and "窗口未超过 3000 行按 60 行 2 次" in out
          and "显式参数放行 3 次" in out, out)
    # 旧样本（v0.3.6，200 行、没有 downgraded/small）只显示已有字段。
    out = run_laf([{"settings": {"loadOlderPageLimitOn": True},
                    "page": {"limit": 200, "installed": True,
                             "applied": 4, "passthrough": 1}}])
    check("旧 page 样本不把缺失字段当 0",
          "已退役" in out and "每页最多 200 行" in out and "已生效 4 次" in out
          and "显式参数放行 1 次" in out
          and "降回 60 行" not in out and "按 60 行" not in out, out)
    # 包装没装上：必须明说计数不可用，不能显示成 0 次生效。
    out = run_laf([{"settings": {"loadOlderPageLimitOn": True},
                    "page": {"limit": 120, "installed": False,
                             "applied": 0, "passthrough": 0}}])
    check("installed=false 时提示包装尚未装上",
          "包装尚未装上，计数不可用" in out, out)
    # 退役前生效 0 次：说明这只是历史记录，不是当前生效的缓解。
    out = run_laf([{"settings": {"loadOlderPageLimitOn": True},
                    "page": {"limit": 120, "installed": True,
                             "applied": 0, "downgraded": 0, "small": 1,
                             "passthrough": 0}}])
    check("applied=0 时提示退役前没有生效记录",
          "退役前该日志里没有大窗口无参补页生效记录" in out, out)
    # 新样本不再产出 page：历史计数仍然显示（已退役标注），不当成当前状态。
    out = run_laf([page_ok,
                   {"settings": {"switchDiagOn": True}, "page": None}])
    check("新样本无 page 时仍显示历史计数并标注已退役",
          "已退役" in out and "已生效 12 次" in out, out)
    # dead 样本也不抹掉历史：它不是"当前计数"，只是退役前的记录。
    out = run_laf([page_ok,
                   {"settings": {}, "dead": True, "page": None}])
    check("dead 样本仍显示退役前历史计数",
          "已生效 12 次" in out and "已退役" in out, out)
    # 完全没有 page 字段：明说已退役，不报错。
    out = run_laf([{"settings": {}, "ver": "0.3.5"}])
    check("旧样本无 page 字段时提示已于 v0.4.3 退役",
          "补页批量已于 v0.4.3 退役" in out and "Traceback" not in out, out)
    # 坏形状：page 是数字/字符串、字段为负或非数值 → 不抛异常。
    out = run_laf([{"settings": {}, "page": 7}])
    check("page 非字典时不炸", "Traceback" not in out, out)
    out = run_laf([{"settings": {},
                    "page": {"limit": "many", "applied": -3, "passthrough": None}}])
    check("page 坏字段回退为默认值且不炸",
          "每页最多 120 行" in out and "已生效 0 次" in out
          and "显式参数放行 0 次" in out and "Traceback" not in out, out)

    print("-- v0.4.0 T1 第三方定时器归因 --")
    timer_on = {
        "settings": {"timerDiagOn": True, "observe": True},
        "timer": {"supported": 1, "count": 2, "max": 96, "detail": [
            {"t": 1730000099000, "ms": 96, "delay": 100, "kind": "interval",
             "src": "bridgeTick", "invoker": "bridgeTick (overlay.js:13440:5)"},
            {"t": 1730000099100, "ms": 60, "delay": 0, "kind": "timeout",
             "src": "bridgeTick", "invoker": "flush (overlay.js:99:1)"},
            {"t": 1730000099200, "ms": 55, "delay": 5, "kind": "interval",
             "src": "otherTick", "invoker": "otherTick (a.js:1:2)"},
        ]},
    }
    out = run_timer([timer_on])
    check("timer 正常形状：本周期次数/最长/明细",
          "本周期 2 次 >=50ms 回调" in out and "最长 96ms" in out
          and "bridgeTick" in out and "interval" not in out
          and "间隔" in out and "一次性" in out
          and "overlay.js:13440:5" in out, out)
    check("timer 按回调名聚合 top3",
          "按回调名聚合" in out and "bridgeTick：合计 156ms / 2 次" in out
          and "otherTick：合计 55ms / 1 次" in out, out)
    # 开关关闭 → 只报关闭，不回显旧明细。
    out = run_timer([timer_on, {"settings": {"timerDiagOn": False}, "timer": None}])
    check("timer 关闭态不回显旧明细",
          "第三方定时器归因已关闭" in out and "bridgeTick" not in out, out)
    # 旧样本没有该设置。
    out = run_timer([{"settings": {}, "ver": "0.3.10"}])
    check("timer 旧样本提示本版本未记录",
          "本版本未记录第三方定时器归因" in out and "Traceback" not in out, out)
    # 暂停 / 自禁用。
    out = run_timer([timer_on, {"settings": {"timerDiagOn": True, "observe": False},
                                "timer": None}])
    check("timer 暂停时说明已暂停", "第三方定时器归因已暂停" in out, out)
    out = run_timer([timer_on, {"settings": {"timerDiagOn": True}, "timer": None,
                                "dead": True}])
    check("timer 自禁用时说明已停止", "观测器已自禁用" in out and "bridgeTick" not in out, out)
    # 包装未装上：不能把 0 条说成没有卡顿。
    out = run_timer([{"settings": {"timerDiagOn": True},
                      "timer": {"supported": 0, "count": 0, "max": None, "detail": []}}])
    check("timer supported=0 时明确包装未装上",
          "包装未装上" in out and "计数不可用" in out, out)
    # 本周期 0 条：明确「不等于没有卡顿」。
    out = run_timer([{"settings": {"timerDiagOn": True},
                      "timer": {"supported": 1, "count": 0, "max": None, "detail": []}}])
    check("timer 0 条时提示不等于没有卡顿",
          "不等于没有卡顿" in out, out)
    # 关掉再打开：不能越过中间显式 timer=null 的样本，把上一轮旧明细当成现在的。
    out = run_timer([
        timer_on,
        {"settings": {"timerDiagOn": False}, "timer": None},
        {"settings": {"timerDiagOn": True},
         "timer": {"supported": 1, "count": 0, "max": None, "detail": []}},
    ])
    check("timer 重开后不隔着关闭样本回显旧明细",
          "bridgeTick" not in out and "不等于没有卡顿" in out, out)
    # 坏形状：detail 非列表、条目非字典、ms 非数值 → 不抛异常。
    out = run_timer([{"settings": {"timerDiagOn": True},
                      "timer": {"supported": 1, "count": 1, "max": 80,
                                "detail": 7}}])
    check("timer detail 非列表时不炸", "Traceback" not in out, out)
    out = run_timer([{"settings": {"timerDiagOn": True},
                      "timer": {"supported": 1, "count": 1, "max": 80,
                                "detail": [7, {"src": None, "ms": None,
                                               "delay": None, "kind": None,
                                               "invoker": None, "t": None}]}}])
    check("timer 条目坏字段回退且不炸",
          "Traceback" not in out and "anonymous" in out, out)

    # 包装失配必须和「未装上」分开说明。
    out = run_timer([{"settings": {"timerDiagOn": True},
                      "timer": {"supported": 0, "lost": 1, "count": 0,
                                "max": None, "detail": []}}])
    check("timer lost=1 时说明归因包装已失效",
          "归因包装已失效" in out and "全局定时器被替换" in out, out)

    print("-- v0.4.2 报告一致性 --")
    scroll_on = {
        "settings": {"scrollDiagOn": True, "inputLagOn": True},
        "scroll": {"p95": 48, "max": 210, "frames": 120, "events": 9,
                   "anyEvents": 12, "loadOlderCalls": 3, "loadOlderP95": 500,
                   "loadOlderMax": 7298, "loadOlderErrors": 0,
                   "mountedTurns": 4, "domPeak": 3200, "lafCount": 2,
                   "lafMax": 180},
        "input": {"p95": 32, "max": 90, "samples": 20},
    }
    scroll_off = {"settings": {"scrollDiagOn": False, "inputLagOn": False},
                  "scroll": None, "input": None}
    out = run_scroll([scroll_on, scroll_off])
    check("最新样本关闭滚动诊断时明示、不回显旧 P95",
          "滚动诊断已关闭" in out and "48ms" not in out, out)
    check("最新样本关闭输入观测时明示、不回显旧 P95",
          "输入延迟观测已关闭" in out and "32ms" not in out, out)

    paused_scroll = {"settings": {"scrollDiagOn": True, "inputLagOn": True},
                     "scroll": None, "input": None}
    out = run_scroll([scroll_on, paused_scroll])
    check("暂停时滚动数据回退并标注最近一次有效样本",
          "滚动诊断：窗口内帧 P95=48ms" in out and "（最近一次有效样本）" in out, out)
    check("暂停时输入数据回退并标注最近一次有效样本",
          "输入延迟：按键→下一帧 P95=32ms" in out and out.count("（最近一次有效样本）") >= 2, out)

    # 补页明细跨代际：新样本 epoch 不同且明细为空，不能回退到上一轮。
    old_detail = {
        "settings": {"scrollDiagOn": True},
        "scroll": {"p95": 50, "loadOlderEpoch": 1},
        "loadOlderDetail": [{"t": 1730000001000, "ms": 7298, "ok": True,
                             "rowsBefore": 60, "rowsAfter": 120, "trigger": "scroll"}],
    }
    new_epoch = {
        "settings": {"scrollDiagOn": True},
        "scroll": {"p95": 40, "loadOlderEpoch": 2},
        "loadOlderDetail": [],
    }
    out = run_print([old_detail, new_epoch])
    check("loadOlder 明细跨代际停止回退",
          "7298ms" not in out and "未记录到补页明细" in out, out)

    # LAF / timer 明细跨代际同理。
    laf_old = {
        "settings": {"lafDiagOn": True},
        "laf": {"supported": 1, "count": 1, "max": 200, "epoch": 1,
                "detail": [{"t": 1730000099000, "ms": 200, "styleMs": 0,
                            "scripts": [{"src": "old.js", "invoker": "f", "ms": 200}]}]},
    }
    laf_new = {"settings": {"lafDiagOn": True},
               "laf": {"supported": 1, "count": 0, "max": None, "epoch": 2,
                       "detail": []}}
    out = run_laf([laf_old, laf_new])
    check("LAF 明细跨代际停止回退", "old.js" not in out, out)

    timer_old = {
        "settings": {"timerDiagOn": True, "observe": True},
        "timer": {"supported": 1, "count": 1, "max": 96, "epoch": 1,
                  "detail": [{"t": 1730000099000, "ms": 96, "delay": 100,
                              "kind": "timeout", "src": "oldTimer", "invoker": "f"}]},
    }
    timer_new = {"settings": {"timerDiagOn": True, "observe": True},
                 "timer": {"supported": 1, "count": 0, "max": None, "epoch": 2,
                           "detail": []}}
    out = run_timer([timer_old, timer_new])
    check("timer 明细跨代际停止回退", "oldTimer" not in out, out)

    # 结构合法但语义越界的时间戳不能让报告崩，也不能显示 1970。
    check("越界时间戳返回 -",
          lr._fmt_ts_full(1e300) == "-" and lr._fmt_ts_full(None) == "-"
          and lr._fmt_ts_full(0) == "-")
    check("正常时间戳带日期显示",
          bool(re.fullmatch(r"\d\d-\d\d \d\d:\d\d:\d\d",
                            lr._fmt_ts_full(1730000099000))))
    bad_ts = {"settings": {"timerDiagOn": True},
              "timer": {"supported": 1, "count": 1, "max": 60,
                        "detail": [{"t": 1e300, "ms": 60, "delay": 0,
                                    "kind": "timeout", "src": "badTs", "invoker": "f"}]}}
    out = run_timer([bad_ts])
    check("t=1e300 不抛异常且显示 -", "Traceback" not in out and "badTs" in out, out)

    # 帧汇总：窗口值与历史值必须分两行，旧样本没有窗口字段时明确标注。
    with tempfile.TemporaryDirectory(prefix="lagfix-frame-") as td:
        p = Path(td) / "observe-20261112.jsonl"
        p.write_text("\n".join(json.dumps({"win": 1, "t": 1, "d": r}) for r in [
            {"frames": 300, "dt": 5, "frameP95": 40,
             "frameMax": 816, "frameMaxAll": 816, "frameMaxWindow": 120},
            {"frames": 300, "dt": 5, "frameP95": 50, "frameMax": 640},
        ]), "utf-8")
        old_dir = lr.pi.DATA_DIR
        old_diag = lr.diagnose
        old_logs = lr.print_logs
        buf = io.StringIO()
        try:
            lr.pi.DATA_DIR = Path(td)
            lr.diagnose = lambda: None
            lr.print_logs = lambda: None
            with contextlib.redirect_stdout(buf):
                lr.main()
        finally:
            lr.pi.DATA_DIR = old_dir
            lr.diagnose = old_diag
            lr.print_logs = old_logs
        out = buf.getvalue()
        check("帧汇总优先打印 30s 窗口最长",
              "单帧最长（30s 窗口）：120ms" in out, out)
        check("帧汇总另行打印历史最长",
              "历史最长（attach/切会话以来）：816ms" in out, out)

    with tempfile.TemporaryDirectory(prefix="lagfix-frame-old-") as td:
        p = Path(td) / "observe-20261112.jsonl"
        p.write_text(json.dumps(
            {"win": 1, "t": 1, "d": {"frames": 300, "dt": 5,
                                     "frameP95": 50, "frameMax": 640}}), "utf-8")
        old_dir = lr.pi.DATA_DIR
        old_diag = lr.diagnose
        old_logs = lr.print_logs
        buf = io.StringIO()
        try:
            lr.pi.DATA_DIR = Path(td)
            lr.diagnose = lambda: None
            lr.print_logs = lambda: None
            with contextlib.redirect_stdout(buf):
                lr.main()
        finally:
            lr.pi.DATA_DIR = old_dir
            lr.diagnose = old_diag
            lr.print_logs = old_logs
        out = buf.getvalue()
        check("旧样本帧汇总标注历史值",
              "单帧最长（旧样本为历史值）：640ms" in out, out)

    print("== report_session_diag 结果：", "PASS" if ok else "FAIL", "==")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
