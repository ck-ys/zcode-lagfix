# zcode-lagfix

ZCode 超长会话卡顿的观测与修复插件。**v0.3.0**：浮在输入框上方的状态条（判定结论 + 帧 P95 + 齿轮，只在主页面显示，不遮挡输入区与工具行）+ 悬停/点击的档位统计浮层 + 齿轮打开的居中分类设置 + 订阅通知节流 + 四项可逐项关闭的性能增强（自适应窗口 / 切会话冷静期 / 后台降频 / 大会话保护）+ 日志路径与上限（默认 50MB，超了删最旧）。设置里可直接重启 ZCode。

另有 **零安装的外部响应探针**（`tools/lagfix-probe.py`）：不改 app.asar、不用退出 ZCode，现在就能看到卡顿数字。

## 一键安装（推荐）

把下面这段话整段发给 ZCode：

```text
请安装或更新并启用 ZCode 插件：https://github.com/ck-ys/zcode-lagfix#plugin-releases
完成后在新会话里执行 /lagfix install，确认补丁已注入；成功后提醒我完全退出并重新打开 ZCode（仅关闭窗口不算），不要自动重启。
若安装失败，请说明原因；若当前会话无法执行命令，请提示我手动执行，不要跳过或声称安装成功。
```

- 需要 **ZCode 桌面版**（Windows / macOS）和 **Python 3.8+**；不用装 Node，也不用装第三方 Python 包。
- 插件启用后，`SessionStart` 钩子会自动同步运行时文件并幂等注入；`/lagfix install` 可在当前会话立刻触发一次。
- 安装会修改 ZCode 的 `app.asar`，**首次注入成功后必须完全退出 ZCode（含托盘）再重开**；只关窗口或重开会话不算。
- 权限不足（例如 ZCode 装在 `Program Files`）时注入会失败；请让 ZCode 以管理员身份运行，或按 `/lagfix install` 输出的提示手动执行。失败原因会写到 `~/.zcode/zcode-lagfix/hook-error.log`。
- 卸载：先完全退出 ZCode，执行 `/lagfix off` 的 `patch_install.py uninstall`（市场安装）或 `install.py remove`（源码安装），再在 **设置 → 插件** 里卸载，最后重开。即使先卸载了插件，运行时目录里的 `patch_install.py` 仍可完成清理。

> 本项目是社区插件，非 ZCode 官方功能；通过修改 `app.asar` 加载，依赖客户端内部 DOM 与接口，不承诺兼容未来所有 ZCode 版本。MIT License，按「现状」提供。

## 它做什么

1. 安装时在 ZCode 安装版 `app.asar` 入口尾部追加一行 import（仿 zusage 插件的已验证机制，但文件名/标记与其完全错开，互不干扰）。
2. ZCode 启动后，主进程加载器 `lagfix-main.cjs` 向每个窗口注入 `lagfix-observe.js`（含启动前已存在的窗口），注入结果写 `inject.log`。
3. 观测脚本量三件互相独立的事，不再混为一谈：
   - **帧间隔**（rAF 时间戳）：帧 P50/P95/最差，对应"看上去卡不卡"；
   - **提交速率**（`[data-session-id]` 上 `data-projection-seq` 的变化）：宿主投影提交频率，是负载指标而不是帧率；
   - **长任务**（PerformanceObserver `longtask`）：单次 >50ms 的主线程阻塞次数与最大值。
   按采集间隔（默认 5s，面板可调 1/3/5/10/30s）由主进程收走，写入 `~/.zcode/zcode-lagfix/observe-YYYYMMDD.jsonl`。日志总预算默认 **50MB**（面板可设 20/50/100/200MB），超了从最旧的日志文件开始删，今天的活动文件不删。
4. 输入框上方的状态条：`● 流畅  每帧 18ms  ⚙`。圆点与判定词来自帧 P95 档位（极流畅/流畅/正常/轻微/卡/很卡，另有空闲/卡死/已暂停）；配色只看**最近 30 秒**最差帧，不会因为历史上一次 788ms 永久报红。末尾齿轮是设置入口。status 条用 fixed 定位 + 每秒按输入框 `getBoundingClientRect()` 同步坐标（不插进 React 树，避免被重渲染清掉），位置在输入框顶边上方，**不压输入区、模型选择与发送按钮**。**只在主页面显示**：设置页/弹窗里的输入框一律排除，被浮层盖住的排除，同时挂着多个（草稿页在会话页后面）取最靠下的那个；一个可用的都没有就整个隐藏，不再退回窗口右上。判定方式与 zusage 一致（`settings-page` 等根标记 + 顶层命中测试）。**不挡排队**：排队面板（`v4-queue`）与角标位置相交时，角标整体让到队列上沿，不会盖住「立即发送 / 编辑 / 删除」；上方没有余量时宁可不显示。
5. **悬停或点击状态条**打开统计浮层（参照 zusage 的生成速度浮层）：大号帧 P95、六档颜色图例、最近 18 个采集周期的柱状图、峰值/最低/最新、提交速率与长任务。点击是固定展开，点页面别处或再点一次收起；悬停 120ms 后自动展开、移开 260ms 收起。
6. **点末尾齿轮打开居中设置弹窗**（左侧分类：状态条 / 观测 / 修复 / 维护）：角标显隐与简洁/详细、黄红阈值、观测开关、采集间隔（1/3/5/10/30s）、**订阅通知节流开关与窗口**、**v0.3 四项性能增强**、**日志存储路径与上限**、**重启 ZCode**、**检查更新（暂置灰）**、恢复默认。修复页每一项标题后都有圆圈「!」，点开写明"影响什么 / 不影响什么"。**角标可以完全隐藏；隐藏后按 `Ctrl+Alt+L`（Mac：`Cmd+Alt+L`）或控制台 `__lagfixSettings()` 仍能打开设置**，不会把自己锁在外面。设置存 `localStorage["lagfix.settings.v1"]`（只此一个键），多窗口通过 `storage` 事件自动同步。
7. `/lagfix` 命令打印完整观测报告（帧间隔分布、提交速率、长任务、堆内存峰值、DOM 规模、节流状态）。

## v0.2 修复：订阅通知节流

宿主每 ~30ms 提交一次投影并通知所有订阅者，React 在 `useSyncExternalStore` 回调里整树重渲染，把主线程切碎（实测流式期间每 5 秒 24~34 次长任务）。v0.2 把**通知**合并成最多 1/120ms 一次：

- **trailing 必达**，不是 debounce——持续流式时也会持续刷新；
- 只包装 `subscribe(listener)` 这种一参调用，带 selector 的 `subscribeWithSelector` 原样放行（否则会冻结 UI）；
- 状态照常写入 store，只延后渲染通知，**不改任何数据**；
- 节流窗口按 **store 实例**计时，而不是按订阅：React 19 每次 commit 都会用新的内联箭头重新订阅，按订阅计时会在每次重订阅时把窗口清零，稳态下等于没节流；
- store 从锚点的 React fiber 上找（沿 hook 链表与 `binding.lease.store` 链路，允许 function 形态的 zustand store）；找不到就降级显示"待生效"，并每 3s 重试（最多 20 次）；
- 关开关立即恢复即时通知；`window.__lagfixOff()` 一键还原；观测器自禁用时同步还原并把开关置 false（不落盘）。

取舍：极端情况下渲染最多滞后 120ms（面板里可调 30~1000ms）。

## v0.3 性能增强（四项，全部可单独关闭）

进入/切换大历史会话时的主要开销并不只是通知频率：宿主会为问题导航目录、分享目录做**一次性全量补拉**（`loadAllOlder` 分页读完再一次性换 snapshot），DOM 从几千行突然涨到上万行，主线程被布局/虚拟列表切碎。v0.3 在"不动宿主数据"的前提下加了四个开关（设置 → 修复）：

| 开关 | 默认 | 触发条件 | 行为 | 关掉后 |
| --- | --- | --- | --- | --- |
| 自适应窗口 | 开 | 最近帧 P95 ≥ 80ms / ≥ 150ms | 通知窗口抬到 200ms / 300ms，帧恢复后回落 | 只按固定"节流窗口" |
| 切会话冷静期 | 开 | 切/新建会话后 10s 内 | 窗口不低于 250ms，让主线程先完成首屏挂载 | 切会话立即按固定窗口 |
| 后台降频 | 开 | `document.hidden` | 通知最多 1 秒 1 次；回前台立即补一次 | 后台仍按前台频率通知 |
| 大会话保护 | 开 | 总行数 ≥ 800 且只加载了一部分 | 拦下 `loadAllOlder` 全量补拉，直接返回 `not-enough-queries`（宿主视为终态，不会重试风暴）；分享入口点击后 15s 内、以及分享弹层挂载期间自动放行 | 恢复宿主的一次性全量补拉 |

边界与取舍：

- 四个开关都只影响"什么时候通知 React 渲染 / 要不要做全量补拉"，**不改 store 数据、不改消息、不碰 db.sqlite**。
- 大会话保护的代价：大历史会话里问题导航的目录只覆盖已加载部分；正常上翻分页（`loadOlder`）、当前可见消息不受影响。
- 自适应窗口有 1 秒缓存，避免每次通知都重算帧统计。
- 面板「修复」页每项标题后的「!」会展开完整说明（影响什么、不影响什么）。
- 全部关闭等价于 v0.2.3 行为；`__lagfixOff()` 会同时关掉节流与大会话保护并还原被包装的方法。

## 日志预算

`~/.zcode/zcode-lagfix/` 下所有匹配的日志（`observe-*.jsonl`、`main/inject/monitor/install/hook-error.log`）共享一个总预算：默认 **50MB**，面板「维护」页可改 20/50/100/200MB。主进程在收到首个样本、拿到真实上限后才开始检查，之后每 60s 一次；超预算就**从最旧的文件开始删**，当天的活动观测文件不删；观测日志另有 14 天保留上限。面板同时显示实际路径、「复制路径」按钮，以及**当前日志量与文件数**（随每个采集周期刷新，不足 1MB 按 KB 显示）。

## 设置面板里的"应用"

- **重启 ZCode**：两次点击确认（5s 内），渲染端只置内存标记，随下一个采集周期回传，主进程执行 `app.relaunch()` + `app.quit()`（宿主清理超过 15s 才 `app.exit(0)` 强制；主进程未收到时按钮 60s 后自动放开可重试）。标记不落盘，进程重启即消失，不会出现"重启后立刻再重启"的死循环。等待时间 = 当前采集间隔（默认 5s，最长 120s）。
- **检查更新**：**置灰**。GitHub 仓库已发布，但版本检查/自动更新尚未接入；当前请按 README 的安装口令重新安装来升级，面板不提供“已是最新”这类假结论。

## 零安装：外部响应探针（先看到数，再决定装不装）

```bash
python D:\Git\git-github\zcode-lagfix\tools\lagfix-probe.py --overlay
```

右下角出现置顶小窗，每秒显示 ZCode UI 线程的消息泵延迟。原理：向 ZCode 主窗口发一条 `WM_NULL` 空消息并计时——UI 线程被渲染占满时消息只能排队，回得就慢。这和系统判定"窗口无响应"走同一条路径；**不注入、不读窗口内容、不改任何文件，也不需要退出 ZCode**。

判读：P50 < 20ms 流畅 / P95 20~80ms 轻微掉帧 / P95 > 80ms 明显卡顿 / 单次 > 500ms 卡死级别。
方法本身有自动化验证（`tests/probe_latency.py`：空闲 0.03ms vs 人为占死 UI 线程 1024ms）。

## 本地开发安装（从仓库源码）

```bash
python D:\Git\git-github\zcode-lagfix\install.py
```

安装器会：复制插件到 `~/.zcode/cli/plugins/cache/lagfix-marketplace/zcode-lagfix/<ver>/`（只保留当前版本）、登记市场与插件、
写 `enabledPlugins`（不写这个 hook 不会加载）、同步 5 个运行时文件到 `~/.zcode/zcode-lagfix/`、注入 asar。

ZCode 运行中时补丁会挂起（pending）。**收尾不再靠"数进程数 == 0"，而是每 2s 直接尝试
`os.replace`，由操作系统仲裁**——Windows 不允许 rename 覆盖已被打开/映射的文件，
所以"能替换"就等于"确实没人握着它"，既不会误判也不会损坏运行中的实例。
进程计数只用于写日志。完全退出 ZCode（含托盘）后 2s 内自动完成，再打开即生效。

查看状态：`python install.py status`，或直接看 `python ~/.zcode/zcode-lagfix/lagfix_report.py`
的三段式诊断（未注入 / 注入了但观测器没起来 / 还没采到数据）。

一键退出并收尾：`tools\退出并安装补丁.cmd`（taskkill → 最多重试 4 轮 finalize → 重启 ZCode）。

## 卸载

**先完全退出 ZCode（含托盘）**，再执行对应的一条命令。`uninstall` 会先剥注入行，成功后才写豁免标记；ZCode 还在运行时会返回 `failed`，**不会**写豁免（避免“号称卸了其实还在”）。

GitHub 市场安装（运行时目录由钩子同步，插件卸载后仍在）：

```bash
python "$HOME/.zcode/zcode-lagfix/patch_install.py" uninstall
```

本地源码安装（仓库根目录）：

```bash
python D:\Git\git-github\zcode-lagfix\install.py remove
```

市场安装的完整顺序：先在插件还在时跑上面的 `uninstall` → 再在 **设置 → 插件 → 已安装 → zcode-lagfix → 卸载** → 重开 ZCode。顺序不要反；即使不小心先卸载了插件，`~/.zcode/zcode-lagfix/patch_install.py` 仍然保留，完全退出 ZCode 后跑同一条 `uninstall` 即可清干净。要恢复使用，删除 `~/.zcode/zcode-lagfix/.lagfix-optout` 后执行 `/lagfix install`。

`uninstall`/`remove` 只剥 lagfix 自己的注入行，绝不影响已装的其它注入插件（如 zusage 状态条）。

## 安全设计（三轮审查结论落地）

- 与 zusage 共存：注入行标记 `[lagfix] load failed` / loader 名 `lagfix-main.cjs`，与其 `inject-main.cjs` / `[zusage] load failed` 互不匹配，互不误删；锁/TMP/sidecar 文件名全部错开。
- 多插件收尾错峰：检测到他人待收尾包时主动让对方先落地（累计上限 120s），等不到就放弃本轮而不是强行替换，避免让别人的补丁永久失效。
- asar 手术：逐文件断言长度、stage fsync、替换前指纹三重校验、收尾替换前复查 ZCode 已全退、替换失败挂 pending 由值守进程在 ZCode 全退后收尾、收尾遇他人替换自动基于当前文件重打。
- 注册表安全：读失败一律中止（绝不回退空结构覆盖用户插件列表），写回 tmp+replace 原子替换并留一份当日备份。
- 语法自检：改后入口用 `ZCode.exe --check`（ELECTRON_RUN_AS_NODE）校验，30s 超时。
- 运行时改动只有一处：v0.2 起包装 store 的 `subscribe`（实例上有就包实例，没有才回退到**原型**方法；真实宿主 `ConversationProjectionStore` 就是原型方法）。**无论走哪条路径，监听者都登记到"调用 subscribe 的那个实例"上**，只合并通知、不改数据、不碰 db.sqlite、不开 CDP；开关关闭或观测器自禁用时立即还原。
- 与数据安全相关的边界（模型上下文/持久化/分享产物均不受影响）已在插件设计阶段逐条验证。

## 测试

```bash
node --check plugins/zcode-lagfix/lagfix-main.cjs
node --check plugins/zcode-lagfix/lagfix-observe.js
python -m py_compile plugins/zcode-lagfix/*.py plugins/zcode-lagfix/hooks/*.py install.py
python tests/line_regex.py      # 注入行正则与 zusage 互不误伤（11 项）
python tests/smoke_asar.py      # 合成 asar 夹具，byte 级验证重打包正确（含 busy 路径，不碰真实安装目录）
python tests/peer_gate.py       # 多插件收尾礼让/上限
python tests/probe_latency.py   # 外部探针方法有效性：空闲 vs UI 线程占死
node tests/observe_smoke.mjs    # renderer：可见性判定/角标/节流合并/大会话保护/日志上限/一键还原
```

## 路线

- v0.1.x：观测 + 实时角标，采集基线。
- v0.2.x：渲染通知节流 + 输入框右上角状态条（判定式文案 + 档位统计）+ 居中分类设置 + 面板内重启。
- v0.3.0（本版）：角标浮在输入框上方且只在主页面显示 + 自适应窗口 / 切会话冷静期 / 后台降频 / 大会话保护（四项可逐项关闭）+ 日志路径与 50MB 预算；已发布到 GitHub（`#plugin-releases` 渠道），面板内版本检查仍待接入。
- v0.3.x（待做）：打开子智能体（Subagent）面板/多级任务时也会明显卡顿——先量清是 DOM 规模、订阅通知还是面板挂载，再决定是否纳入本插件（默认关闭的独立开关）。
