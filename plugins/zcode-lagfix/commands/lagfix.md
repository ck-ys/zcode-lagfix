---
description: 查看 zcode-lagfix 观测报告（帧/长任务/内存/节流状态）、立即安装/修复注入或卸载
argument-hint: "[report|install|off]"
---

按用户参数执行对应动作，无参数时默认 report。

## report（默认）

优先用运行时目录里的脚本（安装器每次都同步，永远是最新版，不依赖仓库位置）：

```bash
python "$HOME/.zcode/zcode-lagfix/lagfix_report.py" || py -3 "$HOME/.zcode/zcode-lagfix/lagfix_report.py"
```

没有这个文件时再用仓库路径（`<仓库根目录>` 是同时包含 `install.py` 与 `plugins/` 的那一层）：

```bash
python "<仓库根目录>/plugins/zcode-lagfix/lagfix_report.py"
```

转述时重点回答三个问题：
1. 活跃期帧间隔 P95 是多少（>50ms 即能感知卡顿）；
2. 长任务次数与最长一次（直接对应主线程被阻塞）；
3. 节流是否生效（报告里"修复开关"一行），帧/长任务相比关闭时是否下降。

## install（立即安装/修复）

插件从 GitHub 市场安装后，SessionStart 钩子会在新会话自动同步并注入；本命令用于**当前会话立刻执行一次**或修复被 ZCode 升级覆盖的注入。

优先用 `ZCODE_PLUGIN_ROOT`；它没设置时，从插件登记表读 `installPath`：

```bash
python "${ZCODE_PLUGIN_ROOT}/hooks/session-start.py" || py -3 "${ZCODE_PLUGIN_ROOT}/hooks/session-start.py"
```

```bash
python -c "import json,pathlib;d=json.load(open(pathlib.Path.home()/'.zcode/cli/plugins/installed_plugins.json',encoding='utf-8'));print([p.get('installPath') for p in d.get('plugins',[]) if str(p.get('id','')).startswith('zcode-lagfix@')][0])"
```

拿到目录后执行 `<installPath>/hooks/session-start.py`（同样用 `python` 或 `py -3`）。
完成后核对运行时目录与注入状态：

```bash
python "$HOME/.zcode/zcode-lagfix/patch_install.py" status || py -3 "$HOME/.zcode/zcode-lagfix/patch_install.py" status
```

确认成功后提醒用户：**完全退出 ZCode（含托盘）再重开**，只关窗口不算；不要自动重启。若报权限不足，说明需要以管理员身份运行 ZCode 或手动执行，并指路 `~/.zcode/zcode-lagfix/hook-error.log`。

## 设置（面板）

无需命令：**悬停或点击输入框上方的状态条**看实时统计；**点末尾齿轮**打开居中分类设置（Esc 或点遮罩关闭）。状态条只在主页面显示，设置页/弹窗/被遮挡时自动隐藏。
**角标关掉后**：按 `Ctrl+Alt+L`（Mac：`Cmd+Alt+L`）或控制台执行 `__lagfixSettings()` 重新打开设置。
设置分类：状态条（显隐/文字/简洁·详细/黄红阈值）、观测（开关/采集间隔 1·3·5·10·30s）、修复（节流开关与窗口 + 自适应窗口/切会话冷静期/后台降频/大会话保护，四项可逐项关闭；关掉节流后前三项与窗口自动变灰）、维护（日志路径与上限 20/50/100/200MB、重启 ZCode/检查更新/恢复默认）。
修复页每一项标题后的圆圈「!」点开写明该项影响什么、不影响什么。
「检查更新」当前置灰（GitHub 已发布，但版本检查/自动更新尚未接入；升级请重新执行安装口令）。
一键还原节流与大会话保护：控制台执行 `__lagfixOff()`。
主进程侧镜像：`~/.zcode/zcode-lagfix/settings.json`（便于排查）。

## off（卸载）

先**完全退出 ZCode**（含托盘；任务管理器确认没有 `ZCode.exe` 与 `zcode-runtime-host.exe`）。运行中替换 asar 会被占用，此时不要写豁免标记，否则会留下“号称卸了其实还在”的假状态。

**源码安装（仓库根目录有 `install.py`）**：

```bash
python install.py remove || py -3 install.py remove
```

它内部做了「失败就撤回 optout」的保护，成功后会自己写豁免标记。

**从 GitHub 市场安装（没有仓库根目录）**：先从插件登记表读出 `installPath`：

```bash
python -c "import json,pathlib;d=json.load(open(pathlib.Path.home()/'.zcode/cli/plugins/installed_plugins.json',encoding='utf-8'));print([p.get('installPath') for p in d.get('plugins',[]) if str(p.get('id','')).startswith('zcode-lagfix@')][0])"
```

然后用该目录下的 `patch_install.py` 剥注入行；**只有命令成功（退出码 0）才写豁免标记**，否则钩子会在下次会话重新注入：

```bash
python "<installPath>/patch_install.py" remove
```

```bash
python -c "import pathlib; p=pathlib.Path.home()/'.zcode/zcode-lagfix/.lagfix-optout'; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('removed by /lagfix off')"
```

最后在 **设置 → 插件 → 已安装 → zcode-lagfix → 卸载**，再重开 ZCode。若不卸载插件，插件仍启用但豁免标记会阻止重新注入；要恢复使用，删除 `.lagfix-optout` 后执行 `/lagfix install`。

注意：remove 只剥 lagfix 自己的注入行，绝不影响已装的其它注入插件（如 zusage 状态条）。
