#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-lagfix 观测报告：读 ~/.zcode/zcode-lagfix/observe-*.jsonl，打印画像。

v0.1.2 修订（三轮终审落地）：
- 强制 stdout UTF-8：中文 Windows 的 GBK 控制台下，✅/⚠ 等符号会抛
  UnicodeEncodeError 让整个命令崩溃（实测复现）。同时把符号换成纯 ASCII，
  即使重定向到管道/被别的进程解码也不会炸。
- 帧率改用采样自带 dt（主进程写入真实时间差）。之前固定除以 5.0，在主进程
  被拖慢时会把帧率算错——而那正是最该准的场景。
- 严格区分两个指标：commitP95（投影提交间隔 = 对宿主重渲染负载的度量）
  与 frameP95（rAF 真实帧间隔 = 卡不卡的度量）。旧版把前者叫"帧率"，
  会让人把"提交越频繁"误读成"越流畅"。
- 小样本不报 P95：n<=11 时 P95 索引恒等于最大值，输出毫无统计意义。
- 诊断分三态：未注入 / 已注入但 observer 无响应 / 有数据。
"""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import patch_install as pi  # noqa: E402


OK = "[OK]"
WARN = "[!]"
BAD = "[x]"
INFO = "[i]"

LOG_KINDS = [
    ("observe-*.jsonl*", "观测样本（每条一个采集周期，间隔可在面板调；.1 为轮转归档）"),
    ("main.log", "主进程加载器（注入、采集泵、自禁用原因）"),
    ("inject.log", "每窗口注入结果（ok=false 带原因）"),
    ("monitor.log", "值守进程（何时等到 / 为何收不了尾）"),
    ("install.log", "安装器（装/卸动作与退出码）"),
    ("hook-error.log", "SessionStart hook 异常"),
    ("elevated-finalize.log", "管理员权限收尾（tools/finalize_all_admin.py）"),
]


def print_logs() -> None:
    """列出所有日志的路径/大小/最后写入时间——排查永远从这里开始。"""
    d = pi.DATA_DIR
    print(f"[lagfix] 日志目录：{d}")
    rows = []
    for pattern, desc in LOG_KINDS:
        hits = sorted(d.glob(pattern)) if "*" in pattern else (
            [d / pattern] if (d / pattern).exists() else [])
        if not hits:
            rows.append((pattern, "—", "—", desc))
            continue
        size = sum(p.stat().st_size for p in hits)
        newest = max(p.stat().st_mtime for p in hits)
        stamp = time.strftime("%m-%d %H:%M", time.localtime(newest))
        names = pattern if len(hits) == 1 else f"{pattern} ×{len(hits)}"
        rows.append((names, f"{size / 1024:.0f} KB", stamp, desc))
    for name, size, stamp, desc in rows:
        print(f"  {name:22s} {size:>9s}  {stamp:>12s}  {desc}")


def load_lines(path: Path) -> list[dict]:
    rows = []
    try:
        # errors="replace"：日志被强杀/断电截断时会留下半个多字节字符，
        # 严格解码会抛 UnicodeDecodeError（ValueError 子类，不是 OSError）直接崩。
        text = path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return []
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            row = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue   # 日志被截断/写坏时可能是 null、数组或字符串
        d = row.get("d")
        if isinstance(d, dict):
            rows.append({"win": row.get("win"), "t": row.get("t"), **d})
    return rows


def pct(vals: list, p: float):
    if not vals:
        return None
    s = sorted(vals)
    idx = min(len(s) - 1, max(0, round((len(s) - 1) * p)))
    return s[idx]


def fmt(v, suffix=""):
    return "-" if v is None else f"{v}{suffix}"


def num(v):
    # JSON 允许 NaN/Infinity；它们进入 int() 会直接抛异常，报告不能因此崩掉。
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _monitor_alive() -> int:
    """当前有几个 lagfix 值守进程（-1 = 查询失败，不代表没在跑）。"""
    import subprocess
    try:
        if sys.platform == "win32":
            ps = ('Get-CimInstance Win32_Process -Filter "Name like \'%python%\'" | '
                  'Where-Object { $_.CommandLine -like "*lagfix*install_monitor*" } | '
                  'ForEach-Object { [int]$_.ProcessId }')
            r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                               capture_output=True, text=True, timeout=20,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                               encoding="utf-8", errors="replace")
            if r.returncode != 0:
                return -1
            return sum(1 for ln in r.stdout.splitlines() if ln.strip().isdigit())
        r = subprocess.run(["pgrep", "-f", "lagfix.*install_monitor"],
                           capture_output=True, text=True, timeout=10)
        return sum(1 for ln in r.stdout.splitlines() if ln.strip().isdigit())
    except Exception:
        return -1


def diagnose() -> None:
    """没有观测数据时，把「卡在哪一步」讲清楚，并区分三种完全不同的故障。"""
    print("== 安装进度诊断 ==")
    injected = None
    asar_path = None
    try:
        asar_path = pi.resolve_target()
        injected = pi.injected_status(asar_path)
        if injected["present"] > 0 and injected["current"]:
            print(f"  {OK} asar 已注入（脚本会在窗口下次加载时运行）")
        elif injected["present"] > 0:
            print(f"  {WARN} asar 有注入行但指向旧目录，下次会话启动会自动修正")
        else:
            print(f"  {BAD} asar 未注入 —— 渲染端脚本还没机会运行")
    except SystemExit as e:
        print(f"  {BAD} 找不到 app.asar：{e}")
    except Exception as e:
        print(f"  {WARN} 读取 asar 失败：{e}")

    if asar_path is not None:
        try:
            tmp = asar_path.parent / pi.TMP_NAME
            sidecar = asar_path.parent / pi.SIDECAR_NAME
            if tmp.exists() and sidecar.exists():
                mb = tmp.stat().st_size // (1024 * 1024)
                print(f"  {INFO} 补丁包已排定（{mb} MB），等 ZCode 完全退出后自动替换")
                # 陈旧包检查：sidecar 记录的源指纹与当前 asar 不一致，说明这个包
                # 是旧版本 asar 打的，替换上去会丢掉期间别人写入的内容。
                try:
                    sc = json.loads(sidecar.read_text("utf-8"))
                    src = sc.get("source")
                    if isinstance(src, list) and len(src) == 4:
                        now_fp = list(pi.fingerprint(asar_path))
                        if now_fp != src:
                            print(f"  {WARN} 该补丁包基于旧版 asar 生成，下次安装会丢弃重建")
                except Exception:
                    pass
            elif injected and injected["present"] == 0:
                print(f"  {INFO} 没有排定的补丁包（安装未跑，或已收尾未生效）")
        except Exception:
            pass

        n = _monitor_alive()
        if n > 0:
            print(f"  {OK} 值守进程在跑（{n} 个），ZCode 全退后会自动收尾")
        elif n == 0:
            print(f"  {WARN} 没有值守进程；下次开新会话 hook 会重新拉起")
        else:
            print(f"  {WARN} 值守进程状态未知（查询失败，不代表没在跑）")

    print()
    if injected and injected["present"] > 0 and injected["current"]:
        print(f"  → 已注入但没有数据，可能是这几种情况之一：")
        print(f"    a) ZCode 是在注入之前启动的 —— 完全退出重开")
        print(f"    b) 还没打开过任何对话 —— 打开一个会话等几秒")
        print(f"    c) observer 找不到锚点已自禁用 —— 看下面「三态诊断」")
    elif injected and injected["present"] == 0:
        print(f"  → 下一步：完全退出 ZCode（含托盘，任务管理器确认没有 ZCode.exe "
              f"和 zcode-runtime-host.exe）再重新打开。")
    print()


def print_scroll_diag(rows: list[dict]) -> None:
    """v0.3.1 滚动/输入诊断：取最后一条带 scroll / input 的样本。

    dead / paused 的廉价样本里这两个字段是 null，会被跳过。
    独立于 active 判断：纯滚动不产生投影提交（frames=0），不能因此不打印。
    v0.4.2：最新设置已关闭时必须明示，不能回退旧样本冒充当前；回退时加后缀。
    """
    newest = rows[-1] if rows else {}
    newest_settings = _settings_of(newest)

    scroll_row = None
    scroll_idx = None
    if newest_settings.get("scrollDiagOn") is not False:
        for idx, r in enumerate(reversed(rows)):
            val = r.get("scroll")
            if isinstance(val, dict):
                scroll_row = val
                scroll_idx = idx
                break
    if newest_settings.get("scrollDiagOn") is False:
        print(f"  {INFO} 滚动诊断已关闭")
    elif scroll_row is not None:
        suffix = "（最近一次有效样本）" if scroll_idx else ""
        print(f"  滚动诊断：窗口内帧 P95={fmt(scroll_row.get('p95'), 'ms')}"
              f"  最长={fmt(scroll_row.get('max'), 'ms')}"
              f"  滚动帧={fmt(scroll_row.get('frames'))}"
              f"  时间线事件={fmt(scroll_row.get('events'))}"
              f"（会话区非时间线事件={fmt(scroll_row.get('anyEvents'))}）{suffix}")
        print(f"    loadOlder：累计 {fmt(scroll_row.get('loadOlderCalls'))} 次"
              f"  窗口内 P95={fmt(scroll_row.get('loadOlderP95'), 'ms')}"
              f"  窗口内最长={fmt(scroll_row.get('loadOlderMax'), 'ms')}"
              f"  失败={fmt(scroll_row.get('loadOlderErrors'))}")
        print(f"    挂载 turn={fmt(scroll_row.get('mountedTurns'))}"
              f"  DOM 峰值={fmt(scroll_row.get('domPeak'))}"
              f"  长动画帧={fmt(scroll_row.get('lafCount'))}"
              f"（最长 {fmt(scroll_row.get('lafMax'), 'ms')}）")
        if scroll_row.get("mismatch"):
            print(f"  {WARN} 有人在滚但没命中时间线选择器（mismatch=true），"
                  f"先确认宿主 DOM 是否改版")
    else:
        print(f"  {INFO} 无滚动诊断数据（旧样本，或滚动诊断已关闭）")

    input_row = None
    input_idx = None
    if newest_settings.get("inputLagOn") is not False:
        for idx, r in enumerate(reversed(rows)):
            val = r.get("input")
            if isinstance(val, dict):
                input_row = val
                input_idx = idx
                break
    if newest_settings.get("inputLagOn") is False:
        print(f"  {INFO} 输入延迟观测已关闭")
    elif input_row is not None:
        suffix = "（最近一次有效样本）" if input_idx else ""
        print(f"  输入延迟：按键→下一帧 P95={fmt(input_row.get('p95'), 'ms')}"
              f"  最长={fmt(input_row.get('max'), 'ms')}"
              f"  样本={fmt(input_row.get('samples'))}{suffix}")
    else:
        print(f"  {INFO} 无输入延迟数据（旧样本，或输入观测已关闭）")


def _fmt_ts(ms) -> str:
    # 0/缺失是「没有时间戳」，不能显示成 1970 年的 08:00:00。
    if not num(ms) or ms <= 0:
        return "-"
    try:
        return time.strftime("%H:%M:%S", time.localtime(ms / 1000))
    except Exception:
        return "-"


def _fmt_ts_full(ms) -> str:
    """v0.4.2：带日期的安全时间戳；结构合法但越界的值（如 1e300）返回 -。"""
    if not num(ms) or not (946684800000 <= ms <= 4102444800000):   # 2000–2100
        return "-"
    try:
        return time.strftime("%m-%d %H:%M:%S", time.localtime(ms / 1000))
    except Exception:
        return "-"


def _settings_of(row: dict) -> dict:
    st = row.get("settings")
    return st if isinstance(st, dict) else {}


def _laf_script_label(script: dict) -> str:
    """脚本条目的展示名：文件名优先，其次调用点。

    Electron 里宿主脚本的 PerformanceScriptTiming.sourceURL 实测常为空
    （2026-11-11 实机 449 条全空），此时 invoker（如 TimerHandler:setTimeout）
    才是唯一可用的归类信息，不能一律塌成 "?"。
    """
    return str(script.get("src") or script.get("invoker") or "?")[:24]


def _laf_src_label(src) -> str:
    """v0.3.5：长帧来源分类的中文展示名。"""
    return {
        "flush": "节流补发",
        "notify": "通知到达",
        "scroll": "滚动",
        "other": "其它",
    }.get(str(src or ""), "未标注")


def print_session_diag(rows: list[dict]) -> None:
    """v0.3.2 多会话归因 + loadOlder 明细。

    - sessions 取最近一条数组；暂停/dead 的 null 样本向前回退到最近一次有效数据。
    - loadOlderDetail 只在变化时携带完整数组，未变化样本是 []；向前找最近一次非空。
    - 开关关闭时不把旧数据当当前数据，明确打印“已关闭”。
    - 旧样本没有字段时给提示，不把「没采到」说成「没有会话」。
    """
    srow = None
    s_older = False
    s_disabled = False
    for idx, r in enumerate(reversed(rows)):
        val = r.get("sessions")
        if isinstance(val, list):
            srow = val
            s_older = idx > 0
            break
        if val is None and _settings_of(r).get("sessionDiagOn") is False:
            s_disabled = True
            break

    if srow is not None:
        entries = [x for x in srow if isinstance(x, dict)]
        suffix = "（最近一次有效样本）" if s_older else ""
        print(f"  多会话归因：{len(entries)} 个会话桶{suffix}"
              + ("（已达上限 5 个，更久未活跃的会被淘汰）" if len(entries) >= 5 else ""))
        for s in entries[:5]:
            sid = str(s.get("sid") or "")[:8] or "(空)"
            vis = "可见" if s.get("visible") else "隐藏"
            print(f"    {sid:8s} {vis}  提交 {fmt(s.get('frames'))} 次"
                  f" / {fmt(s.get('commitRate'), ' 次/s')}"
                  f"  DOM {fmt(s.get('dom'))}"
                  f"  挂载 turn {fmt(s.get('mountedTurns'))}"
                  f"  滚动 P95 {fmt(s.get('scrollP95'), 'ms')}"
                  f"  最近活跃 {_fmt_ts(s.get('lastActive'))}")
    elif s_disabled:
        print(f"  {INFO} 多会话归因已关闭")
    else:
        print(f"  {INFO} 无多会话归因数据（旧样本，或多会话归因已关闭）")

    # v0.4.2：补页明细带代际；跨代际停止回退，避免把上一轮/上一个 store 的
    # 明细贴到当前轮。旧样本没有 loadOlderEpoch 时沿用原有回退逻辑。
    newest_epoch = None
    for r in reversed(rows):
        sc = r.get("scroll")
        if isinstance(sc, dict) and "loadOlderEpoch" in sc:
            newest_epoch = sc.get("loadOlderEpoch")
            break

    drow = None
    d_older = False
    d_seen = False
    d_disabled = False
    for idx, r in enumerate(reversed(rows)):
        sc = r.get("scroll")
        epoch = sc.get("loadOlderEpoch") if isinstance(sc, dict) else None
        if newest_epoch is not None and epoch is not None and epoch != newest_epoch:
            break
        val = r.get("loadOlderDetail")
        if isinstance(val, list):
            d_seen = True
            if val:
                drow = val
                d_older = idx > 0
                break
        elif val is None and _settings_of(r).get("scrollDiagOn") is False:
            d_disabled = True
            break

    if drow is not None:
        details = [d for d in drow if isinstance(d, dict)][-10:]
        suffix = "（最近一次有效样本）" if d_older else ""
        if details:
            print(f"  补页明细：最近 {len(details)} 次{suffix}")
            for d in details:
                ok = bool(d.get("ok"))
                rb, ra = d.get("rowsBefore"), d.get("rowsAfter")
                same = num(rb) and num(ra) and rb == ra
                trig = str(d.get("trigger") or "unknown")
                if trig not in ("scroll", "initial", "unknown"):
                    trig = "unknown"
                print(f"    {_fmt_ts(d.get('t'))}  {fmt(d.get('ms'), 'ms'):>8s}"
                      f"  {'正常' if ok else '异常'}"
                      f"  行 {fmt(rb)}→{fmt(ra)}"
                      f"  触发 {trig}"
                      + ("  （无变化）" if same else ""))
            slow = max(details, key=lambda x: x.get("ms") if num(x.get("ms")) else -1)
            slow_trig = str(slow.get("trigger") or "unknown")
            if slow_trig not in ("scroll", "initial", "unknown"):
                slow_trig = "unknown"
            print(f"    Top 慢补页：{fmt(slow.get('ms'), 'ms')}"
                  f"（{slow_trig}，"
                  f"行 {fmt(slow.get('rowsBefore'))}→{fmt(slow.get('rowsAfter'))}）")
            counts = {"scroll": 0, "initial": 0, "unknown": 0}
            for d in details:
                k = str(d.get("trigger") or "unknown")
                counts[k if k in counts else "unknown"] += 1
            parts = [f"{k} {counts[k]}" for k in ("scroll", "initial", "unknown") if counts[k]]
            print("    触发来源：" + " / ".join(parts))
            print("    注：正常仅表示 promise 结算无异常；宿主内部失败可能被吞掉，"
                  "行数无变化也可能是 no-op。")
        else:
            print(f"  {INFO} 本文件内未记录到补页明细（可能尚未调用 loadOlder，或明细在上一个日志文件）")
    elif d_seen:
        print(f"  {INFO} 本文件内未记录到补页明细（可能尚未调用 loadOlder，或明细在上一个日志文件）")
    elif d_disabled:
        print(f"  {INFO} 滚动诊断已关闭，无补页明细")
    else:
        print(f"  {INFO} 无补页明细（旧样本，或滚动诊断已关闭）")


def print_pane_diag(rows: list[dict]) -> None:
    """v0.3.3 侧栏开合 + 回前台归因。

    - pane/refocus 取最近一条 dict；暂停/dead 的 null 向前回退。
    - paneDiagOn=false 时明确打印“已关闭”，不拿旧数据冒充当前。
    - 旧样本没有字段时只提示，不报错。
    """
    prow = None
    p_older = False
    p_disabled = False
    for idx, r in enumerate(reversed(rows)):
        val = r.get("pane")
        if isinstance(val, dict):
            prow = val
            p_older = idx > 0
            break
        if val is None and _settings_of(r).get("paneDiagOn") is False:
            p_disabled = True
            break

    if prow is not None:
        suffix = "（最近一次有效样本）" if p_older else ""
        detected = prow.get("detected") is True
        if detected:
            print(f"  侧栏开合：detected=true  open={str(bool(prow.get('open'))).lower()}"
                  f"  宽度={fmt(prow.get('panelPx'), 'px')}"
                  f"  开合 {fmt(prow.get('switches'))} 次"
                  f"  保护命中 {fmt(prow.get('guardHits'))} 次{suffix}")
            print(f"    最近一次开合：帧 P95={fmt(prow.get('switchP95'), 'ms')}"
                  f"  最长={fmt(prow.get('switchMax'), 'ms')}")
        else:
            print(f"  {WARN} 侧栏标记缺失（detected=false）：宿主改版或当前布局无桌面侧栏，"
                  f"本段无法归因{suffix}")

        # open/closed 分组的帧 P95、长任务、DOM 中位数。
        # 用所有可见、未丢锚点的样本：面板常开但没提交（frames=0）正是要看的场景。
        groups = {True: {"frame": [], "lt": [], "dom": []},
                  False: {"frame": [], "lt": [], "dom": []}}
        for r in rows:
            p = r.get("pane")
            if not isinstance(p, dict) or p.get("detected") is not True:
                continue
            if r.get("hidden") or r.get("miss"):
                continue
            key = bool(p.get("open"))
            if num(r.get("frameP95")):
                groups[key]["frame"].append(r["frameP95"])
            if num(r.get("longTasks")):
                groups[key]["lt"].append(r["longTasks"])
            if num(r.get("dom")):
                groups[key]["dom"].append(r["dom"])
        for key, label in ((True, "open"), (False, "closed")):
            g = groups[key]
            n = max(len(g["frame"]), len(g["lt"]), len(g["dom"]))
            if n <= 0:
                print(f"    {label}：本文件内没有可用样本")
                continue
            print(f"    {label} 样本 {n} 条：帧 P95 中位 "
                  f"{fmt(round(pct(g['frame'], 0.5), 1) if g['frame'] else None, 'ms')}"
                  f" / 长任务中位 {fmt(pct(g['lt'], 0.5))}"
                  f" / DOM 中位 {fmt(pct(g['dom'], 0.5))}")
    elif p_disabled:
        print(f"  {INFO} 侧栏 + 回前台归因已关闭")
    else:
        print(f"  {INFO} 无侧栏 + 回前台归因数据（旧样本，或开关已关闭）")

    rrow = None
    r_older = False
    r_disabled = False
    for idx, r in enumerate(reversed(rows)):
        val = r.get("refocus")
        if isinstance(val, dict):
            rrow = val
            r_older = idx > 0
            break
        if val is None and _settings_of(r).get("paneDiagOn") is False:
            r_disabled = True
            break

    if rrow is not None:
        suffix = "（最近一次有效样本）" if r_older else ""
        if rrow.get("hiddenMs") is None and rrow.get("sinceVisibleMs") is None:
            print(f"  {INFO} 本文件内未记录到回前台样本{suffix}")
        else:
            print(f"  回前台：上次后台 {fmt(rrow.get('hiddenMs'), 'ms')}"
                  f"  回前台已 {fmt(rrow.get('sinceVisibleMs'), 'ms')}"
                  f"  帧 P95={fmt(rrow.get('p95'), 'ms')}"
                  f"  最长={fmt(rrow.get('max'), 'ms')}"
                  f"  合并补发 {fmt(rrow.get('flushes'))} 个"
                  f"  保护命中 {fmt(rrow.get('guardHits'))} 次{suffix}")
        buckets = {"<1s": 0, "1–10s": 0, "10–60s": 0, ">60s": 0}
        # hiddenMs 是“最近一次”的持久字段，回前台后每个采集样本都会重复携带。
        # 只在 sinceVisibleMs 回退（新一次回前台）或 hiddenMs 变化时计一次事件，
        # 否则一次 8 秒的 Alt-Tab 会被每个 5 秒样本重复计数几十次。
        prev_since = None
        prev_hidden = None
        for r in rows:
            if r.get("hidden") or r.get("miss"):
                continue
            rf = r.get("refocus")
            if not isinstance(rf, dict) or not num(rf.get("hiddenMs")):
                continue
            since = rf.get("sinceVisibleMs")
            if not num(since):
                continue
            ms = rf["hiddenMs"]
            fresh = (prev_since is None or since < prev_since or ms != prev_hidden)
            prev_since = since
            prev_hidden = ms
            if not fresh:
                continue
            if ms < 1000:
                buckets["<1s"] += 1
            elif ms < 10000:
                buckets["1–10s"] += 1
            elif ms < 60000:
                buckets["10–60s"] += 1
            else:
                buckets[">60s"] += 1
        if any(buckets.values()):
            print("    后台时长分布（按回前台次数）："
                  + " / ".join(f"{k} {v}" for k, v in buckets.items()))
    elif r_disabled:
        print(f"  {INFO} 回前台归因已关闭")
    else:
        print(f"  {INFO} 无回前台数据（旧样本，或开关已关闭）")


def print_laf_diag(rows: list[dict]) -> None:
    """v0.3.4 卡顿来源定位（LoAF 归因）+ v0.3.5 上下文分类 + v0.3.6 补页批量计数。

    - laf 取最近一条 dict；detail 为 [] 时向前找最近一次非空（与 loadOlderDetail 同约定）。
    - supported=0 明确提示浏览器不支持，不把「不支持」说成「没有卡顿」。
    - pace 是缓解项计数：开关关闭时打印「已关闭」，开启时打印参数与累计放行/跳过。
    - 旧样本没有字段时只提示，不报错。
    """
    # v0.3.4 终审 P1-3：状态判定只看**最新样本**，不能用反向扫描的结果决定
    # 「已关闭」——先关闭过、后来重开但处于暂停/自禁用的日志，扫描会命中更老的
    # 关闭样本，把「暂停」误报成「已关闭」，还 break 掉更早的有效明细。
    newest = rows[-1] if rows else {}
    newest_settings = _settings_of(newest)

    # v0.3.5 三审 P1：count/max/ctx/关闭状态必须取**最新一条 laf**，
    # 不能拿「最近一次有明细的旧样本」冒充本周期；明细表再单独向前回退。
    newest_laf = None
    newest_laf_idx = None
    for idx, r in enumerate(reversed(rows)):
        val = r.get("laf")
        if isinstance(val, dict):
            newest_laf = val
            newest_laf_idx = idx
            break
        if val is None and _settings_of(r).get("lafDiagOn") is False:
            break        # 遇到关闭样本就停止回退，不把关闭前的数据当当前数据

    # v0.4.2：明细代际和最新 laf 不一致时停止回退，避免把上一轮重置前的
    # 明细贴到当前轮。旧样本没有 epoch 时沿用原有逻辑。
    newest_epoch = newest_laf.get("epoch") if isinstance(newest_laf, dict) else None
    detail_row = None
    detail_idx = None
    for idx, r in enumerate(reversed(rows)):
        val = r.get("laf")
        if isinstance(val, dict):
            if (newest_epoch is not None and val.get("epoch") is not None
                    and val.get("epoch") != newest_epoch):
                break
            if val.get("detail"):
                detail_row = val
                detail_idx = idx
                break
        elif val is None and _settings_of(r).get("lafDiagOn") is False:
            break

    if newest_laf is not None:
        supported = newest_laf.get("supported")
        if supported == 0:
            print(f"  {INFO} 当前浏览器不支持 long-animation-frame，无法做卡顿来源定位")
        else:
            current_older = bool(newest_laf_idx)
            suffix = "（最近一次有效样本）" if current_older else ""
            print(f"  卡顿来源定位：本周期长帧 {fmt(newest_laf.get('count'))} 次"
                  f"，最长 {fmt(newest_laf.get('max'), 'ms')}{suffix}")
            # v0.3.5：P0 上下文（面板状态 + 来源分布）。旧样本没有这些字段，
            # 只提示、不把「没记录」说成「没有卡顿」。
            pane_open = newest.get("paneOpen")
            if isinstance(pane_open, bool):
                quiet = newest.get("panelQuiet") == 1
                print(f"    当前面板：{'打开' if pane_open else '收起'}"
                      + ("（面板期进一步合并已生效）" if quiet else ""))
            ctx = newest_laf.get("ctx")
            ctx_enabled_now = newest_settings.get("lafCtxOn") is not False
            if not ctx_enabled_now:
                print(f"    {INFO} 长帧来源细分已关闭")
            elif isinstance(ctx, dict):
                vals = {k: int(ctx.get(k) or 0) for k in
                        ("flush", "notify", "scroll", "other")
                        if num(ctx.get(k)) and ctx.get(k) >= 0}
                total = sum(vals.values())
                label = "最近一次有效样本的长帧来源" if current_older else "本周期长帧来源"
                if total:
                    print(f"    {label}："
                          + " / ".join(f"{_laf_src_label(k)} {vals.get(k, 0)}"
                                       for k in ("flush", "notify", "scroll", "other"))
                          + f"（共 {total} 次）")
                else:
                    print(f"    {INFO} 本周期还没有 ≥100ms 的长帧，来源分布为空")
            elif "ctx" not in newest_laf:
                print(f"    {INFO} 本版本未记录长帧来源细分（旧样本）")
            if (num(newest_laf.get("count")) and newest_laf.get("count") == 0
                    and detail_row is not None):
                print(f"    {INFO} 计数为 0 但已有明细：旧样本只开了卡顿归因、未开滚动诊断"
                      f"（v0.3.4 起两者共用计数，新样本不会再出现）")
            raw_detail = detail_row.get("detail") if isinstance(detail_row, dict) else None
            details = [d for d in (raw_detail if isinstance(raw_detail, list) else [])
                       if isinstance(d, dict)][-10:]
            if details:
                head = f"    最近 {len(details)} 次 ≥100ms 长帧"
                if detail_idx and detail_idx > 0:
                    head += "（最近一次有效明细，可能不是本周期）"
                print(head + "：")
                for d in details:
                    raw_scripts = d.get("scripts")
                    scripts = [s for s in (raw_scripts if isinstance(raw_scripts, list) else [])
                               if isinstance(s, dict)]
                    top = " / ".join(
                        f"{_laf_script_label(s)} {fmt(s.get('ms'), 'ms')}"
                        for s in scripts[:3]) or "（无脚本归属）"
                    style = d.get("styleMs")
                    style_note = f"，其中强制布局 {style}ms" if num(style) and style > 0 else ""
                    # v0.3.5：来源分类与四个时间差；老样本/已关闭时整段省略。
                    src_note = ""
                    if ctx_enabled_now and d.get("src") is not None:
                        bits = []
                        for key, label in (("sinceFlush", "补发"), ("sinceNotify", "通知"),
                                           ("sinceScroll", "滚动"), ("sinceCommit", "提交")):
                            if num(d.get(key)):
                                bits.append(f"距{label} {int(d[key])}ms")
                        src_note = f"｜来源={_laf_src_label(d.get('src'))}"
                        if bits:
                            src_note += "（" + "，".join(bits) + "）"
                        if (d.get("src") == "other" and num(d.get("sinceCommit"))
                                and d.get("sinceCommit") <= 50):
                            src_note += "（紧跟宿主提交）"
                    print(f"      {_fmt_ts(d.get('t'))}  {fmt(d.get('ms'), 'ms'):>8s}{style_note}"
                          f"  ← {top}{src_note}")
                agg: dict = {}
                for d in details:
                    raw_sc = d.get("scripts")
                    for s in (raw_sc if isinstance(raw_sc, list) else []):
                        if isinstance(s, dict) and num(s.get("ms")):
                            key = _laf_script_label(s)
                            agg[key] = agg.get(key, 0) + int(s.get("ms"))
                if agg:
                    tops = sorted(agg.items(), key=lambda kv: kv[1], reverse=True)[:3]
                    print("    窗口内脚本耗时聚合："
                          + " / ".join(f"{k} {v}ms" for k, v in tops))
            else:
                print(f"    {INFO} 本文件内没有 ≥100ms 的长帧记录（没卡到这个量级，"
                      f"或记录在上一个日志文件）")
    elif newest_settings.get("lafDiagOn") is False:
        print(f"  {INFO} 卡顿来源定位已关闭")
    elif newest_settings.get("observe") is False:
        print(f"  {INFO} 卡顿来源定位已暂停（开关仍开，恢复观测后继续记录）")
    elif newest.get("dead"):
        print(f"  {INFO} 观测器已自禁用，卡顿来源定位停止")
    else:
        print(f"  {INFO} 无卡顿来源数据（旧样本，或本文件内还没有开启过）")

    prow = None
    p_disabled = False
    p_seen = False
    for r in reversed(rows):
        val = r.get("pace")
        if isinstance(val, dict):
            prow = val
            p_seen = True
            break
        if val is None and _settings_of(r).get("loadOlderPaceOn") is False:
            p_disabled = True
            break

    if prow is not None:
        print(f"  翻页降频（实验）：窗口 >{fmt(prow.get('minRows'))} 行时触发间隔"
              f" {fmt(prow.get('intervalMs'), 'ms')}，累计放行 {fmt(prow.get('allowed'))} 次"
              f" / 跳过 {fmt(prow.get('skipped'))} 次")
        if prow.get("skipped") == 0 and prow.get("allowed") == 0:
            print(f"    （自开关开启后还没有被计数的补页触发；非滚动触发的补页不进这项统计）")
    elif p_disabled:
        print(f"  {INFO} 翻页降频已关闭（实验项，默认关闭）")
    else:
        print(f"  {INFO} 无翻页降频数据（旧样本）")

    # v0.3.6 O8：页大小替换计数。状态只看最新样本的设置，避免拿旧的开/关
    # 样本冒充当前状态；具体计数再向前找最近一条非空 page。遇到 dead 或显式
    # page=null 必须停下：那表示当前没有可用计数，不能越过它回显旧计数。
    page_row = None
    page_no_data = False
    for r in reversed(rows):
        if r.get("dead"):
            page_no_data = True
            break
        val = r.get("page")
        if isinstance(val, dict):
            page_row = val
            break
        if "page" in r:
            page_no_data = True
            break
    page_enabled = newest_settings.get("loadOlderPageLimitOn")
    if page_enabled is False:
        print(f"  {INFO} 补页批量已关闭（实验项，默认关闭）")
    elif page_enabled is None:
        # 降级/混合版本日志：最新样本没有该设置，不能越过它回显旧计数。
        print(f"  {INFO} 本版本未记录补页批量（旧样本）")
    elif page_no_data:
        print(f"  {INFO} 最新样本没有补页计数（自禁用或序列化失败），不显示更早的计数")
    elif page_row is not None:
        limit = page_row.get("limit")
        applied = page_row.get("applied")
        passthrough = page_row.get("passthrough")
        downgraded = page_row.get("downgraded")
        small = page_row.get("small")
        installed = page_row.get("installed")
        # 旧样本（v0.3.6）没有 downgraded/small，也没有 120 的新常量：
        # 只显示已有字段，不把缺失当 0，也不改写成新语义。
        page_limit = limit if num(limit) and limit > 0 else 120
        if installed is False:
            print(f"  补页批量（实验）：每页最多 {fmt(page_limit)} 行，"
                  f"但包装尚未装上，计数不可用")
        else:
            parts = [f"已生效 {fmt(applied if num(applied) and applied >= 0 else 0)} 次"]
            if "downgraded" in page_row:
                parts.append(f"连续补页降回 60 行 "
                             f"{fmt(downgraded if num(downgraded) and downgraded >= 0 else 0)} 次")
            if "small" in page_row:
                min_rows = page_row.get("minRows")
                gate = fmt(min_rows if num(min_rows) and min_rows > 0 else 3000)
                parts.append(f"窗口未超过 {gate} 行按 60 行 "
                             f"{fmt(small if num(small) and small >= 0 else 0)} 次")
            parts.append(f"显式参数放行 "
                         f"{fmt(passthrough if num(passthrough) and passthrough >= 0 else 0)} 次")
            print(f"  补页批量（实验）：每页最多 {fmt(page_limit)} 行；" + "；".join(parts))
            if not (num(applied) and applied > 0):
                hint = "开关开着但本文件内还没有大窗口无参补页"
                if installed is None:
                    hint += "；或包装尚未装上"
                print(f"    （{hint}）")
    elif page_enabled is True:
        print(f"  {INFO} 补页批量已开启，但本文件内还没有生效记录（旧样本或尚未触发补页）")
    else:
        print(f"  {INFO} 本版本未记录补页批量（旧样本）")


def print_timer_diag(rows: list[dict]) -> None:
    """v0.4.0 T1：第三方定时器归因（只读，默认关闭）。

    状态只看最新样本的设置；计数取最近一条非空 timer。遇到 dead 或显式
    timer=null 就停下，不越过它回显旧计数（与补页批量同一约定）。
    """
    newest = None
    for r in reversed(rows):
        if isinstance(r.get("settings"), dict):
            newest = r
            break
    if newest is None:
        print(f"  {INFO} 本版本未记录第三方定时器归因（旧样本）")
        return
    settings = _settings_of(newest)
    if settings.get("timerDiagOn") is False:
        print(f"  {INFO} 第三方定时器归因已关闭（实验项，默认关闭）")
        return
    if settings.get("timerDiagOn") is None:
        print(f"  {INFO} 本版本未记录第三方定时器归因（旧样本）")
        return
    if settings.get("observe") is False:
        print(f"  {INFO} 第三方定时器归因已暂停（开关仍开，恢复观测后继续记录）")
        return
    if newest.get("dead"):
        print(f"  {INFO} 观测器已自禁用，第三方定时器归因停止")
        return

    trow = None
    no_data = False
    for r in reversed(rows):
        if r.get("dead"):
            no_data = True
            break
        val = r.get("timer")
        if isinstance(val, dict):
            trow = val
            break
        if "timer" in r:
            no_data = True
            break
    if no_data or trow is None:
        print(f"  {INFO} 第三方定时器归因已开启，但本文件内还没有可用采样")
        return
    if trow.get("lost") == 1:
        print(f"  {INFO} 第三方定时器归因已开启，但归因包装已失效"
              f"（全局定时器被替换/包裹），计数不可用")
        return
    if trow.get("supported") == 0:
        print(f"  {INFO} 第三方定时器归因已开启，但包装未装上"
              f"（全局定时器不可写），计数不可用")
        return

    count = trow.get("count")
    mx = trow.get("max")
    print(f"  第三方定时器归因（实验）：本周期 "
          f"{fmt(count if num(count) and count >= 0 else 0)} 次 >=50ms 回调，"
          f"最长 {fmt(mx if num(mx) and mx > 0 else None, 'ms')}")
    # 明细只在变化时携带；向前找最近一次非空数组（与补页明细同约定）。
    # 遇到显式 timer=null（关闭/暂停/序列化失败）或 dead 必须停下：
    # 那表示当前这一轮已经结束，不能把上一轮开着的旧明细当成现在的。
    # v0.4.2：代际不一致也停下，避免关→快速重开后回显上一轮明细。
    newest_epoch = trow.get("epoch")
    detail = None
    for r in reversed(rows):
        if r.get("dead"):
            break
        tv = r.get("timer")
        if isinstance(tv, dict):
            if (newest_epoch is not None and tv.get("epoch") is not None
                    and tv.get("epoch") != newest_epoch):
                break
            d = tv.get("detail")
            if isinstance(d, list) and d:
                detail = [x for x in d if isinstance(x, dict)]
                break
            continue
        if "timer" in r:
            break
    if not detail:
        if num(count) and count > 0:
            print("    （本周期有耗时回调，但本文件内没有明细；可能刚轮转）")
        else:
            print("    （本周期没有 >=50ms 的定时任务；这不等于没有卡顿）")
        return

    kinds = {"timeout": "一次性", "interval": "间隔"}
    print("  最近记录的耗时定时任务（最多 10 条）：")
    for d in detail[-10:]:
        when = _fmt_ts_full(d.get("t"))
        kind = kinds.get(str(d.get("kind")), str(d.get("kind") or "-"))
        print(f"    {when}  {fmt(d.get('ms') if num(d.get('ms')) else None, 'ms')}"
              f"  原定 {fmt(d.get('delay') if num(d.get('delay')) else None, 'ms')}"
              f"  {kind}  {str(d.get('src') or 'anonymous')}")
        inv = str(d.get("invoker") or "").strip()
        if inv:
            print(f"      调用点：{inv}")
    agg: dict[str, list] = {}
    for d in detail:
        src = str(d.get("src") or "anonymous")
        ms = d.get("ms") if num(d.get("ms")) else 0
        slot = agg.setdefault(src, [0, 0])
        slot[0] += ms
        slot[1] += 1
    top = sorted(agg.items(), key=lambda kv: kv[1][0], reverse=True)[:3]
    if top:
        print("  按回调名聚合（合计耗时前 3）：")
        for src, (total, n) in top:
            print(f"    {src}：合计 {total}ms / {n} 次")


def main() -> int:
    # 必须在任何 print 之前：中文 Windows 默认 GBK，符号会抛 UnicodeEncodeError
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    data_dir = pi.DATA_DIR
    files = sorted(data_dir.glob("observe-*.jsonl"))
    if not files:
        print(f"[lagfix] 暂无观测数据（目录 {data_dir}）。")
        diagnose()
        print()
        print_logs()
        return 0

    latest = files[-1]
    rows = load_lines(latest)
    if not rows:
        print(f"[lagfix] 最新数据文件 {latest.name} 无有效记录。")
        diagnose()
        print()
        print_logs()
        return 0

    print(f"[lagfix] 数据文件：{latest.name}（{len(rows)} 条采样）")
    if len(files) > 1:
        print(f"[lagfix] 另有 {len(files) - 1} 个更早的数据文件未纳入本报告")
    print()

    # 只统计「活跃 + 可见 + 未丢锚点」的样本：后台窗口会被 Chromium 节流，
    # 混进来会把帧率算低；miss 样本是 observer 已经失效时的残值。
    active = [r for r in rows
              if num(r.get("frames")) and r["frames"] > 0
              and not r.get("hidden") and not r.get("miss")]
    all_active = [r for r in rows if num(r.get("frames")) and r["frames"] > 0]
    idle = [r for r in rows if not (num(r.get("frames")) and r["frames"] > 0)]

    # 帧率：优先用真实 dt；老数据没有 dt 才退回 5s 假设（并明示）
    def rate(r):
        dt = r.get("dt")
        if num(dt) and dt > 0:
            return r["frames"] / dt
        return r["frames"] / 5.0

    rates = [rate(r) for r in active]
    dts = [r["dt"] for r in active if num(r.get("dt")) and r["dt"] > 0]
    commit_p95 = [r["commitP95"] for r in active if num(r.get("commitP95"))]
    frame_p95 = [r["frameP95"] for r in active if num(r.get("frameP95"))]
    # v0.4.2：窗口值优先；旧样本只有 frameMax（历史值），单独标注，不能混用。
    frame_max_win = [r["frameMaxWindow"] for r in active if num(r.get("frameMaxWindow"))]
    frame_max_all = [
        r.get("frameMaxAll") if num(r.get("frameMaxAll")) else r.get("frameMax")
        for r in active
        if num(r.get("frameMaxAll")) or num(r.get("frameMax"))
    ]
    frame_max_legacy = [r["frameMax"] for r in active if num(r.get("frameMax"))]
    longtasks = [r["longTasks"] for r in active if num(r.get("longTasks"))]
    max_long = [r["maxLongTask"] for r in active if num(r.get("maxLongTask"))]
    heaps = [r["heapMB"] for r in rows if num(r.get("heapMB"))]
    doms = [r["dom"] for r in rows if num(r.get("dom"))]
    errs = [r["errs"] for r in rows if num(r.get("errs"))]
    miss = [r for r in rows if r.get("miss")]

    sampled = sum(r.get("samples") or 0 for r in active)
    print("== 汇总 ==")
    print(f"  活跃采样：{len(active)} 条（可见窗口）"
          + (f"，另有 {len(all_active) - len(active)} 条后台窗口样本已排除"
             if len(all_active) > len(active) else ""))
    if active:
        if dts:
            # 标称间隔以样本里的 settings.collectSec 为准（面板可调），
            # 不能硬编码 5s —— 否则用户改成 30s 后，报告会把正常偏差说成"主进程被拖慢"。
            nominal = None
            for r in reversed(rows):
                s = r.get("settings")
                if isinstance(s, dict) and num(s.get("collectSec")):
                    nominal = s["collectSec"]
                    break
            nominal_txt = f"{nominal}s" if nominal is not None else "未知"
            print(f"  采样实际间隔：中位 {pct(dts, 0.5):.1f}s（标称 {nominal_txt}，偏差=主进程被拖慢）")
        print(f"  投影提交率：P50={fmt(round(pct(rates, 0.5), 1) if rates else None, ' 次/s')}"
              f"  P95={fmt(round(pct(rates, 0.95), 1) if rates else None, ' 次/s')}")
        print(f"    （这是宿主每秒重渲染 pane 的次数，是负载指标；数值越高越吃力）")

        if frame_p95:
            print(f"  真实帧间隔（rAF）：P95={fmt(pct(frame_p95, 0.95), 'ms')}"
                  f"  最差样本={fmt(max(frame_p95), 'ms')}")
            if frame_max_win:
                print(f"  单帧最长（30s 窗口）：{fmt(max(frame_max_win), 'ms')}")
            elif frame_max_legacy:
                print(f"  单帧最长（旧样本为历史值）：{fmt(max(frame_max_legacy), 'ms')}")
            else:
                print("  单帧最长（30s 窗口）：-")
            if frame_max_all:
                print(f"  历史最长（attach/切会话以来）：{fmt(max(frame_max_all), 'ms')}")
        else:
            print(f"  {WARN} 无 rAF 帧数据（旧版本观测脚本写入的样本）")

        if longtasks:
            total_lt = sum(longtasks)
            print(f"  长任务（>50ms）：共 {total_lt} 次"
                  f"  最长 {fmt(max(max_long) if max_long else None, 'ms')}")
            if total_lt == 0:
                print(f"    （没有长任务说明主线程没被单次阻塞；卡感可能来自累计派生成本）")
        else:
            print(f"  {WARN} 无长任务数据")

        if sampled and sampled < 20:
            print(f"  {WARN} 样本仅 {sampled} 个，P95 无统计意义（需 >=20），建议跑久一点再看")
    else:
        print(f"  {INFO} 没有活跃采样：还没有会话在流式输出。发条消息让它跑起来再看。")

    # v0.3.1 滚动/输入诊断放在 active 判断之外：纯滚动不产生投影提交
    # （frames 恒为 0），放进去会被整体吞掉，正好错过滚动 A/B 的核心场景。
    print_scroll_diag(rows)
    # v0.3.2：多会话归因与 loadOlder 明细也独立于 active 判断。
    print_session_diag(rows)
    # v0.3.3：侧栏开合与回前台同样独立，面板常开但 0 提交的样本也要纳入。
    print_pane_diag(rows)
    # v0.3.4：卡顿来源定位与翻页降频计数同样独立于 active 判断。
    print_laf_diag(rows)
    # v0.4.0：第三方定时器的长回调归因（默认关闭的实验）。
    print_timer_diag(rows)

    if rows:
        print(f"  静止占比：{len(idle) * 100 // len(rows)}%")

    # v0.2 修复状态：只取最后一条带 fix 字段的样本
    fix_row = None
    for r in reversed(rows):
        if isinstance(r.get("fix"), dict):
            fix_row = r["fix"]
            break
    if fix_row:
        if not fix_row.get("on"):
            print(f"  性能开关：节流 关（用户关闭）")
        elif fix_row.get("applied"):
            print(f"  性能开关：节流 开 {fix_row.get('ms')}ms · 已生效")
        else:
            print(f"  性能开关：节流 开 {fix_row.get('ms')}ms · {WARN} 未生效"
                  f"（{fix_row.get('why') or '等待会话挂载'}）")
        # 装了不等于宿主走这条路：命中数才是"节流真的在拦通知"的证据
        hits = fix_row.get("hits")
        if fix_row.get("applied") and num(hits):
            if hits > 0:
                print(f"    包装命中：累计 {hits} 次通知（宿主确实经过被包装的 subscribe）")
            else:
                print(f"    {WARN} 包装已装但命中 0 次：宿主可能持有包装前的 subscribe 引用，"
                      f"节流实际未生效")
        # v0.3：实际窗口可能被自适应/切会话冷静期抬升
        eff = fix_row.get("eff")
        base = fix_row.get("ms")
        if fix_row.get("on") and num(eff) and num(base) and eff != base:
            print(f"    实际窗口：{eff}ms（基础 {base}ms，自适应/切会话冷静期已抬升）")
        # v0.3：大历史会话保护独立于节流，单独报状态与拦截次数
        if fix_row.get("big") is False:
            print("    大历史会话保护：关（用户关闭）")
        elif fix_row.get("bigApplied"):
            print(f"    大历史会话保护：已装 · 累计拦下 {fix_row.get('blocked') or 0} 次全量补拉")
        elif fix_row.get("big"):
            print("    大历史会话保护：待装（还没找到会话 store）")
    else:
        print(f"  性能开关：{INFO} 本版样本没带 fix 字段（观测脚本旧版本）")
    if heaps:
        print(f"  渲染进程 JS 堆：峰值 {max(heaps)} MB / 中位 {pct(heaps, 0.5)} MB")
        print(f"    （performance.memory 是 Chromium 粗粒度分桶值，仅供趋势参考）")
    if doms:
        print(f"  DOM 节点：峰值 {max(doms)}（会话时间线是虚拟化的，此值不随历史长度增长）")
    if errs:
        print(f"  observer 异常计数：峰值 {max(errs)}"
              + (f"  {BAD} 接近自禁用阈值" if max(errs) >= 40 else ""))
    if miss:
        reasons = {}
        for r in miss:
            raw = r.get("miss")
            k = "未注明原因" if raw is True else str(raw)
            reasons[k] = reasons.get(k, 0) + 1
        print(f"  {WARN} 锚点丢失采样：{len(miss)} 条 {reasons}")
    print()

    # 每窗口最近 10 条
    by_win: dict = {}
    for r in rows:
        by_win.setdefault(r.get("win"), []).append(r)
    for win, wrows in sorted(by_win.items(), key=lambda kv: (kv[0] is None, kv[0])):
        print(f"== 窗口 {win} 最近 10 条 ==")
        print("  时间      会话      提交/s  提交间隔P95ms  帧P95ms  帧MAXms  堆MB  长任务")
        for r in wrows[-10:]:
            import time as _t
            ts = _t.strftime("%H:%M:%S", _t.localtime((r.get("t") or 0) / 1000))
            sid = str(r.get("sid") or "-")[:8]
            fr = r.get("frames")
            dt = r.get("dt")
            rate_v = (round(fr / dt, 1) if num(fr) and num(dt) and dt > 0
                      else (round(fr / 5.0, 1) if num(fr) else "-"))
            print(f"  {ts}  {sid:8s}  {str(rate_v):>6s}  {str(r.get('commitP95')):>13s}  "
                  f"{str(r.get('frameP95')):>7s}  {str(r.get('frameMax')):>7s}  "
                  f"{str(r.get('heapMB')):>4s}  {str(r.get('longTasks')):>5s}")
        print()

    print("[lagfix] 判读口径：")
    print("  · 真实帧间隔 P95 > 50ms 或 单帧最长 > 200ms  → 用户能感知到卡")
    print("  · 长任务次数 > 0 → 主线程被单次阻塞，与卡顿直接相关")
    print("  · 投影提交率高但帧间隔正常 → 宿主在勤快重渲染，暂未卡死")
    print("[lagfix] v0.4.2：修正观测口径与包装器生命周期——帧统计按最近 30 秒窗口计算并区分「窗口最长 / 历史最长」；宿主运行期替换订阅或全量补拉实现时不再误覆盖，定时器归因失配时如实标记「计数不可用」；报告对关闭态、明细代际和异常时间戳做了一致性处理。没有新增缓解项，默认开关与 v0.4.1 一致。v0.4.1：角标「有新版本」红点移到设置齿轮右上角，像未读提醒一样贴在按钮角上，不占文字空间、不挡点击；显示条件与检查逻辑不变。v0.4.0：新增「第三方定时器归因 · 实验」（默认关闭）——只记录单次运行超过 50ms 的定时任务：耗时、原定间隔、回调名和调用点（只留文件名与行号），用来判断卡顿是否来自外部插件的定时刷新；不改定时器时机，不读任务参数或对话内容。补页批量改为自适应：已显示超过 3000 行时每页最多 120 行，连续快速上翻（间隔不到 600ms）自动回到 60 行，不跳过、不删除、不改消息顺序。v0.3.10：修复更新红点实际不可见。v0.3.9：设置面板保持滚动位置、打开时接管键盘焦点并在关闭后归还；修复宿主替换 subscribe 时被误覆盖的风险。v0.3.8：日志清理加固——只删白名单内的旧日志，校验真实日期、目录类型、普通文件非链接与 10 分钟最小年龄；宁可超预算也不误删。v0.3.7 起支持小红点与可选自动检查更新（默认关闭、24 小时内最多一次，只请求公开 GitHub Releases）。仍不读消息正文、不写 store；角标常驻，Ctrl+Alt+L 或 __lagfixSettings() 随时打开设置。")
    print()
    print_logs()
    return 0


if __name__ == "__main__":
    sys.exit(main())
