#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-lagfix 一键安装/卸载（不依赖 zcode CLI，照 zusage 的落地方式）。

用法：
    python install.py            安装（注册插件 + 注入 asar）
    python install.py status     查看状态
    python install.py remove     卸载（剥注入行 + 清 optout 标记）
    python install.py unregister 仅从插件列表注销（保留 asar 注入）

安装做三件事（全部可回滚）：
  1. 把 plugins/zcode-lagfix/ 复制到 ~/.zcode/cli/plugins/cache/lagfix-marketplace/zcode-lagfix/<ver>/
  2. 在 ~/.zcode/cli/plugins/installed_plugins.json 登记（供 ZCode 识别 /lagfix 命令与 hook）
  3. 调 patch_install.install() 注入 asar（ZCode 运行中则挂 pending，退出后自动收尾）

安全：任一步失败都会明确报错；不删除任何既有插件条目，只做追加/替换本插件自己的。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SRC = REPO_ROOT / "plugins" / "zcode-lagfix"
PLUGIN_NAME = "zcode-lagfix"
MARKET_ID = "lagfix-marketplace"

PLUGINS_ROOT = Path.home() / ".zcode" / "cli" / "plugins"
CACHE_DIR = PLUGINS_ROOT / "cache" / MARKET_ID / PLUGIN_NAME
REGISTRY = PLUGINS_ROOT / "installed_plugins.json"
MARKET_REG = PLUGINS_ROOT / "known_marketplaces.json"
MARKET_DIR = PLUGINS_ROOT / "marketplaces" / MARKET_ID
# ZCode 主配置：插件启用态在 plugins.enabledPlugins[id]。宿主对 cache 型插件默认
# defaultEnabled=false，不写这里 hook/命令完全不加载（P0-1）。
CLI_CONFIG = Path.home() / ".zcode" / "cli" / "config.json"
PLUGIN_ID = f"{PLUGIN_NAME}@{MARKET_ID}"

# 运行时目录必须与 hooks/session-start.py 的 pi.DATA_DIR 保持一致，
# 否则启动时 hook 会认为"注入行指向别处 = 未安装"，每次启动都重打 384MB 包。
# 后两项不是注入链路必需，但放在这里能保证 ~/.zcode/zcode-lagfix/ 的手工调用
# （python lagfix_report.py / install_monitor.py）永远是新版，避免旧版 GBK 崩溃复现。
DATA_DIR = Path.home() / ".zcode" / "zcode-lagfix"
# patch_install.py 也必须同步：运行时目录里的 lagfix_report.py / install_monitor.py
# 直接 import 它，缺了会在用户机器上报 ImportError。
RUNTIME_FILES = ("lagfix-main.cjs", "lagfix-observe.js",
                 "install_monitor.py", "lagfix_report.py", "patch_install.py")


def _read_json_strict(path: Path, default: dict) -> dict:
    """读 JSON：不存在返回 default；存在但读不了/结构不对则中止。

    P0-2：绝不把"读失败"当成"空文件"再整文件覆盖——那会清空用户所有插件与市场记录。
    """
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text("utf-8"))
    except Exception as e:
        raise SystemExit(f"[lagfix-install] 拒绝覆盖 {path}：{e}\n请先备份/修复该文件后重试")
    if not isinstance(data, dict):
        raise SystemExit(f"[lagfix-install] 拒绝覆盖 {path}：顶层不是 JSON 对象")
    return data


def _write_json_atomic(path: Path, data: dict, backup_tag: str | None = None) -> None:
    """原子写 JSON：tmp + flush + fsync + os.replace；可选同日一份备份。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup_tag and path.exists():
        bak = path.with_suffix(path.suffix + f".bak-lagfix-{backup_tag}")
        if not bak.exists():
            try:
                shutil.copy2(path, bak)
            except OSError as e:
                _print(f"备份 {path.name} 失败（继续）：{e}")
    tmp = path.with_suffix(path.suffix + ".lagfix.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def set_plugin_enabled(enabled: bool) -> None:
    """写入/移除 plugins.enabledPlugins[id]（P0-1，原子写 + 备份）。"""
    cfg = _read_json_strict(CLI_CONFIG, {})
    plugins = cfg.get("plugins")
    if not isinstance(plugins, dict):
        plugins = cfg["plugins"] = {}
    ep = plugins.get("enabledPlugins")
    if not isinstance(ep, dict):
        ep = plugins["enabledPlugins"] = {}
    if enabled:
        ep.setdefault(PLUGIN_ID, True)  # 不覆盖用户显式 false
    else:
        ep.pop(PLUGIN_ID, None)
    _write_json_atomic(CLI_CONFIG, cfg, backup_tag=time.strftime("%Y%m%d"))
    _print(f"插件启用态已{'写入' if enabled else '移除'}：{PLUGIN_ID}")


def plugin_explicitly_disabled() -> bool:
    """用户是否在 config.json 里显式关掉了本插件（enabledPlugins[id] is False）。

    P1-x：set_plugin_enabled(True) 用 setdefault 不覆盖显式 false，于是 install 会
    "装好了但 hook 永不加载"，用户只看到角标不出现、无从判断。这里提前拦下并说明。
    """
    try:
        cfg = _read_json_strict(CLI_CONFIG, {})
    except SystemExit:
        raise
    plugins = cfg.get("plugins")
    if not isinstance(plugins, dict):
        return False
    ep = plugins.get("enabledPlugins")
    if not isinstance(ep, dict):
        return False
    return ep.get(PLUGIN_ID) is False


def _print(msg: str) -> None:
    print(f"[lagfix-install] {msg}", flush=True)


def _version() -> str:
    try:
        data = json.loads((SRC / ".zcode-plugin" / "plugin.json").read_text("utf-8"))
        return str(data.get("version", "0.3.2"))
    except Exception:
        return "0.3.2"


IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".lagfix-optout", "observe-*.jsonl*",
                                "monitor.log", "hook-error.log", "config.json")


def copy_payload(ver: str) -> Path:
    """staging 目录 + 原子换入（P1-2），避免 rmtree 半删后 copytree 抛 FileExistsError。"""
    dest = CACHE_DIR / ver
    staging = CACHE_DIR / f".{ver}.staging-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SRC, staging, dirs_exist_ok=True, ignore=IGNORE)

    old = None
    if dest.exists():
        old = CACHE_DIR / f".{ver}.old-{os.getpid()}"
        try:
            os.replace(dest, old)
        except OSError as e:
            shutil.rmtree(staging, ignore_errors=True)
            raise SystemExit(f"[lagfix-install] 旧缓存目录被占用无法替换：{e}\n请关闭 ZCode 后重试")
    os.replace(staging, dest)
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)
    _sweep_old_versions(ver)
    _print(f"插件文件已就位：{dest}")
    return dest


SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def _sweep_old_versions(keep: str) -> None:
    """删掉本市场下其它版本目录。

    每装一次就多一份完整插件副本；只留当前版本，避免缓存目录无声膨胀。
    只匹配纯 semver 目录名，任何其它内容（含 .staging/.old）一律不碰。
    """
    try:
        for p in CACHE_DIR.iterdir():
            if p.is_dir() and p.name != keep and SEMVER_RE.match(p.name):
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


def _atomic_copy(src: Path, dst: Path) -> None:
    """tmp + replace 复制运行时文件（避免读到半文件；被占用则保留旧版）。"""
    tmp = dst.with_name(dst.name + f".tmp-{os.getpid()}")
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    except OSError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        _print(f"运行时文件被占用，保留旧版（下次再同步）：{dst.name}（{e}）")


def _sweep_tmp(dir_path: Path, max_age_s: int = 86400) -> None:
    """清掉原子复制留下的 `*.tmp-<pid>` 孤儿（只匹配我们自己的命名）。"""
    try:
        now = time.time()
        for p in dir_path.glob("*.tmp-*"):
            if not re.match(r"^.+\.tmp-\d+$", p.name):
                continue
            try:
                if now - p.stat().st_mtime > max_age_s:
                    p.unlink()
            except OSError:
                pass
    except OSError:
        pass


def sync_runtime() -> Path:
    """把 loader/observer 复制到 ~/.zcode/zcode-lagfix/（注入行与 hook 共用此目录）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _sweep_tmp(DATA_DIR)
    for name in RUNTIME_FILES:
        src = SRC / name
        if not src.is_file():
            raise FileNotFoundError(f"缺少运行时文件：{src}")
        dst = DATA_DIR / name
        if not (dst.exists() and dst.read_bytes() == src.read_bytes()):
            _atomic_copy(src, dst)
    _print(f"运行时文件已同步：{DATA_DIR}")
    return DATA_DIR


def register_plugin(dest: Path, ver: str) -> None:
    """在 installed_plugins.json 中登记本插件（保留其它插件条目，原子写）。"""
    reg = _read_json_strict(REGISTRY, {"version": 1, "plugins": []})
    plugins = reg.get("plugins")
    if not isinstance(plugins, list):
        raise SystemExit(f"[lagfix-install] {REGISTRY} 的 plugins 不是数组，拒绝改写")
    plugins[:] = [p for p in plugins
                  if not (isinstance(p, dict) and p.get("id") == PLUGIN_ID)]
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    plugins.append({
        "id": PLUGIN_ID,
        "name": PLUGIN_NAME,
        "marketplace": MARKET_ID,
        "version": ver,
        "installPath": str(dest),
        "installedAt": now,
        "updatedAt": now,
        "scope": "user",
        "source": {"source": "directory", "path": str(SRC)},
    })
    _write_json_atomic(REGISTRY, reg, backup_tag=time.strftime("%Y%m%d"))
    _print(f"已在插件列表登记：{PLUGIN_ID} v{ver}")


def register_marketplace() -> None:
    """把本仓库登记为本地目录市场（供将来 zcode CLI 直接识别）。"""
    reg = _read_json_strict(MARKET_REG, {"version": 1, "marketplaces": []})
    mks = reg.get("marketplaces")
    if isinstance(mks, dict):  # 宿主兼容 object 形态，转成数组保住已有条目（P0-2）
        mks = reg["marketplaces"] = list(mks.values())
    if not isinstance(mks, list):
        raise SystemExit(f"[lagfix-install] {MARKET_REG} 的 marketplaces 结构无法识别，拒绝改写")
    mks[:] = [m for m in mks if not (isinstance(m, dict) and m.get("id") == MARKET_ID)]
    mks.append({
        "id": MARKET_ID,
        "source": {"source": "directory", "path": str(REPO_ROOT).replace("\\", "/")},
        "name": MARKET_ID,
        "description": "zcode-lagfix 插件市场：ZCode 超长会话卡顿观测与修复（输入框右上角状态条）。",
        "addedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "pluginCount": 1,
    })
    _write_json_atomic(MARKET_REG, reg, backup_tag=time.strftime("%Y%m%d"))
    _print(f"已登记本地市场：{MARKET_ID} → {REPO_ROOT}")


def sync_market_dir() -> None:
    """把 marketplace.json + 插件清单镜像到 marketplaces/<id>/（与官方布局一致）。"""
    try:
        if MARKET_DIR.exists():
            shutil.rmtree(MARKET_DIR, ignore_errors=True)
        MARKET_DIR.mkdir(parents=True, exist_ok=True)
        (MARKET_DIR / "marketplace.json").write_text(
            (REPO_ROOT / "marketplace.json").read_text("utf-8"), "utf-8")
    except OSError as e:
        _print(f"市场镜像写入失败（不影响插件本身）：{e}")


def _patch():
    sys.path.insert(0, str(SRC))
    import patch_install  # noqa: E402
    return patch_install


def do_install() -> int:
    ver = _version()
    if not (SRC / "lagfix-main.cjs").is_file():
        _print(f"源目录不完整：{SRC}")
        return 1
    if plugin_explicitly_disabled():
        _print(f"❗ 你在 {CLI_CONFIG} 里显式关闭了 {PLUGIN_ID}（enabledPlugins = false）。")
        _print("   安装器不会违背你的选择自动打开它。要安装请先改成 true，或删除该键后重试。")
        return 1
    dest = copy_payload(ver)
    register_marketplace()
    sync_market_dir()
    register_plugin(dest, ver)
    set_plugin_enabled(True)  # P0-1：不写这里 hook/命令永不加载

    pi = _patch()
    pi.set_runtime(sync_runtime())  # 与 hook 共用 ~/.zcode/zcode-lagfix/，避免启动时重装
    try:
        # 必须持久化 asar 路径（P2-11），否则 hook/monitor 可能解析到另一个安装
        from pathlib import Path as _P
        cfg_path = _P.home() / ".zcode" / "zcode-lagfix" / "config.json"
        cfg = json.loads(cfg_path.read_text("utf-8")) if cfg_path.exists() else {}
        cfg["asar_path"] = str(pi.resolve_target())
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        # 与注册表写入同样的原子替换：截断写入中途被杀会留下坏 config，
        # 之后 hook/monitor 解析失败就找不到 asar（三审 P2）。
        tmp_cfg = cfg_path.with_name(cfg_path.name + ".tmp")
        tmp_cfg.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp_cfg, cfg_path)
    except Exception as e:
        _print(f"记录 asar 路径失败（不影响安装）：{e}")
    try:
        result = pi.install()
    except (SystemExit, Exception) as e:
        _print(f"注入失败：{e}")
        return 1
    _print(f"asar 注入结果：{result}")

    if result == "installed":
        _print("✅ 完成。请完全退出 ZCode（含托盘）再打开，输入框右上角会出现 lagfix 状态条。")
        return 0
    if result == "already":
        _print("✅ 已注入过（无需重复）。完全退出并重开 ZCode 生效。")
        return 0
    if result == "pending":
        _print("⏳ ZCode 正在运行，补丁已挂起：完全退出（含托盘 / 任务管理器确认无 ZCode 进程）后自动完成，再打开即生效。")
        return 0
    if result == "optout":
        _print("检测到 optout 标记，已跳过。若要安装请先删除 ~/.zcode/zcode-lagfix/.lagfix-optout")
        return 1
    _print("❌ 注入失败，查看 ~/.zcode/zcode-lagfix/monitor.log")
    return 1


def do_remove() -> int:
    # P1-3：先写 optout 阻止并发 finalize/hook 重装，失败再撤回，绝不留下"已卸载"的假象
    marker = DATA_DIR / ".lagfix-optout"
    pi = None
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("", "utf-8")
        pi = _patch()
        result = pi.remove()
    except BaseException as e:
        # P1-4：patch_install 用 SystemExit 报错，IO/权限问题抛普通异常；
        # Ctrl+C 会在写标记之后、remove 前后任意时刻打断。
        # 只有"确认注入仍在 / 无法确认"时才撤回标记：remove 已经提交后被打断
        # 必须保留标记，否则下次启动 SessionStart 会把刚剥掉的注入装回来（终审 P2）。
        injected = None
        if pi is not None:
            try:
                injected = pi.injected_status().get("present")
            except BaseException:
                injected = None
        if injected is None or injected > 0:
            try:
                marker.unlink(missing_ok=True)
            except OSError as ue:
                _print(f"撤回豁免标记失败（请手动删除 {marker}）：{ue}")
        if isinstance(e, KeyboardInterrupt):
            if injected == 0:
                _print("卸载已完成，但收尾被中断；豁免标记已保留。")
            else:
                _print("卸载已中断，未留下 optout 标记。")
            return 130
        _print(f"卸载失败：{e}")
        return 1
    _print(f"asar 卸载结果：{result}")

    if result not in ("removed", "already"):
        try:
            marker.unlink(missing_ok=True)  # 卸载没成功就不能留 optout
        except OSError as ue:
            _print(f"卸载失败且豁免标记未能撤回（请手动删除 {marker}）：{ue}")
        _print("❗ 卸载未完成：ZCode 运行中会占用 app.asar。")
        _print("   请完全退出 ZCode（含托盘 / 任务管理器确认无 ZCode 进程）后重跑 remove。")
        return 1

    try:
        set_plugin_enabled(False)
    except BaseException as e:
        # asar 已剥离、optout 已写，这里只是插件启用态没更新：不能静默 traceback。
        _print(f"注入已移除，但插件启用态未更新：{e}")
        _print("请在 设置 → 插件 里手动卸载 zcode-lagfix，或修复 config.json 后重跑 remove。")
        return 1
    _print(f"已写入 optout：{marker}")
    _print("请完全退出 ZCode（含托盘）再打开，角标与观测即消失。")
    return 0


def do_unregister() -> int:
    try:
        # P0-2 同源问题：注销也必须严格读 + 原子写，否则一次解析失败就清空所有插件记录
        reg = _read_json_strict(REGISTRY, {"version": 1, "plugins": []})
        plugins = reg.get("plugins")
        if not isinstance(plugins, list):
            _print(f"注销失败：{REGISTRY} 的 plugins 不是数组，拒绝改写")
            return 1
        before = len(plugins)
        kept = [p for p in plugins
                if not (isinstance(p, dict) and p.get("id") == PLUGIN_ID)]
        if len(kept) == before:
            _print("注销：本插件未登记（无需改动）")
            return 0
        reg["plugins"] = kept
        _write_json_atomic(REGISTRY, reg, backup_tag=time.strftime("%Y%m%d"))
        _print(f"已从插件列表注销（{before - len(kept)} 条）")
        return 0
    except (SystemExit, Exception) as e:
        _print(f"注销失败：{e}")
        return 1


def do_status() -> int:
    ver = _version()
    dest = CACHE_DIR / ver
    _print(f"源目录   ：{SRC}")
    _print(f"缓存目录 ：{dest}（{'存在' if dest.exists() else '不存在'}）")
    try:
        reg = json.loads(REGISTRY.read_text("utf-8"))
        hit = [p for p in reg.get("plugins", [])
               if isinstance(p, dict) and p.get("id") == f"{PLUGIN_NAME}@{MARKET_ID}"]
        _print(f"插件登记 ：{'已登记 v' + str(hit[0].get('version')) if hit else '未登记'}")
    except Exception as e:
        _print(f"插件登记 ：读取失败（{e}）")
    pi = _patch()
    try:
        st = pi.injected_status()
        _print(f"asar 注入：{st}")
    except SystemExit as e:
        _print(f"asar 注入：{e}")
    marker = DATA_DIR / ".lagfix-optout"
    _print(f"optout   ：{'有' if marker.exists() else '无'}")
    return 0


AUDIT_LOG = DATA_DIR / "install.log"
AUDIT_CAP = 256 * 1024


def audit(msg: str) -> None:
    """安装器审计日志：谁在什么时候装/卸了什么、结果如何。

    P1-x：控制台输出一关就没了，用户回头问"我上次装的哪个版本、是不是卸过"
    只能靠猜。这里只记动作与结果，不记任何路径之外的隐私信息。
    超限轮转到 .1，不原地截断（否则排查历史同样会被抹掉）。
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if AUDIT_LOG.exists() and AUDIT_LOG.stat().st_size > AUDIT_CAP:
            AUDIT_LOG.replace(AUDIT_LOG.with_name(AUDIT_LOG.name + ".1"))
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    action = (sys.argv[1] if len(sys.argv) > 1 else "install").lower()
    audit(f"start action={action} ver={_version()}")

    if action == "install":
        rc = do_install()
    elif action == "remove":
        rc = do_remove()
    elif action == "unregister":
        rc = do_unregister()
    elif action == "status":
        rc = do_status()
    else:
        _print(f"未知动作：{action}（可用：install / remove / status / unregister）")
        rc = 1

    audit(f"end   action={action} rc={rc}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
