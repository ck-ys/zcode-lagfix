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
    return isinstance(v, (int, float)) and not isinstance(v, bool)


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
    """
    scroll_row = None
    input_row = None
    for r in reversed(rows):
        if scroll_row is None and isinstance(r.get("scroll"), dict):
            scroll_row = r["scroll"]
        if input_row is None and isinstance(r.get("input"), dict):
            input_row = r["input"]
        if scroll_row is not None and input_row is not None:
            break
    if scroll_row is not None:
        print(f"  滚动诊断：窗口内帧 P95={fmt(scroll_row.get('p95'), 'ms')}"
              f"  最长={fmt(scroll_row.get('max'), 'ms')}"
              f"  滚动帧={fmt(scroll_row.get('frames'))}"
              f"  时间线事件={fmt(scroll_row.get('events'))}"
              f"（会话区非时间线事件={fmt(scroll_row.get('anyEvents'))}）")
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
    if input_row is not None:
        print(f"  输入延迟：按键→下一帧 P95={fmt(input_row.get('p95'), 'ms')}"
              f"  最长={fmt(input_row.get('max'), 'ms')}"
              f"  样本={fmt(input_row.get('samples'))}")


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
    frame_max = [r["frameMax"] for r in active if num(r.get("frameMax"))]
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
            print(f"  单帧最长：{fmt(max(frame_max) if frame_max else None, 'ms')}")
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
    print("[lagfix] v0.3.1：观测页新增滚动诊断/输入延迟（只读），性能页新增滚动期隐藏遮罩；大历史会话保护与渲染四项增强均可逐项关闭，关了节流后依赖项自动变灰；角标常驻，Ctrl+Alt+L 或 __lagfixSettings() 随时打开设置；维护页可手动检查更新（只查 GitHub Releases，不自动安装）。")
    print()
    print_logs()
    return 0


if __name__ == "__main__":
    sys.exit(main())
