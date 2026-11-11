<p align="center">
  <img src="docs/assets/icon.png" width="84" height="84" alt="zcode-lagfix 图标">
</p>

<h1 align="center">zcode-lagfix</h1>

<p align="center">
  <strong>ZCode 超长会话的卡顿观测与缓解插件</strong><br>
  把“卡不卡”变成可读的数字，在不改会话数据的前提下减少卡顿。
</p>

<p align="center">
  <a href="https://github.com/ck-ys/zcode-lagfix/tree/plugin-releases"><img src="https://img.shields.io/badge/version-0.3.3-blue.svg" alt="version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license"></a>
  <a href="#兼容性"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg" alt="platform"></a>
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/python-3.8%2B-3776ab.svg" alt="python"></a>
</p>

<p align="center">
  <sub>不读写 db.sqlite · 不读会话正文 · 不开 CDP · 不联网上报 · 一键还原</sub>
</p>

下面是在演示页面运行真实 observer 的截图：数据来自模拟卡顿，不含任何真实会话内容。

<p align="center">
  <img src="docs/assets/preview-status.png" width="360" alt="状态条与统计浮层">
</p>

ZCode 桌面版**超长会话卡顿**的观测与缓解插件。它做两件事：

1. 把"卡不卡"变成可读的数字——帧间隔、投影提交速率、主线程长任务；
2. 在不修改会话数据的前提下，合并高频渲染通知，并拦住进入大历史会话时的一次性全量补拉。

所有缓解项都可以**单独关闭**；全部关闭后，三处宿主包装（`subscribe` / `loadAllOlder` / `loadOlder` 观测）会还原为原始实现，观测仍按"观测"开关运行，角标常驻（布局受限时自动隐藏）。插件不读写 `db.sqlite`、不改消息与会话内容、不开 CDP 端口、不联网上报（唯一网络请求是用户手动点击「检查更新」）。

> 社区项目，非 ZCode 官方功能。通过修改 `app.asar` 加载，依赖客户端内部 DOM 与接口；ZCode 大版本改版可能需要适配。MIT License，按「现状」提供。

## 已解决的问题

长会话卡顿通常不是单一原因。zcode-lagfix 把它们拆成三条独立指标，避免"帧率低"和"提交太频繁"混为一谈：

| 指标 | 采集方式 | 回答的问题 |
| --- | --- | --- |
| 帧间隔 | `requestAnimationFrame` 相邻时间戳 | 界面看上去卡不卡 |
| 提交速率 | `[data-session-id]` 上 `data-projection-seq` 的变化 | 宿主投影提交有多频繁（负载，不是帧率） |
| 长任务 | `PerformanceObserver("longtask")` | 主线程被单次阻塞多久、多少次 |

插件版本演进：

- **v0.1**：观测与实时角标，建立采集基线。
- **v0.2**：投影订阅通知节流，解决流式期间高频重渲染。
- **v0.3.0**：状态条移到输入框上方且只在主页面显示；新增四项可逐项关闭的性能增强；日志预算与当前日志量展示；市场安装支持一键卸载。
- **v0.3.1**：新增滚动窗口、`loadOlder` 与输入延迟三项只读观测；滚动期临时隐藏消息层遮罩；角标改为常驻（删除隐藏开关）；设置面板重排为 状态条 / 观测 / 性能 / 维护；「检查更新」可用（手动请求一次 GitHub Releases）。
- **v0.3.2**：新增多会话归因（按 `sid` 分桶记录提交/帧、DOM、挂载 turn、滚动 P95，最多 5 个）与 `loadOlder` 最近 10 次明细（耗时/行数/触发来源）；只读、默认开，不改宿主行为；`/lagfix report` 新增对应两段。
- **v0.3.3（当前）**：新增侧栏开合 420ms 保护、面板常开期保护与回前台 700ms 保护，默认开、可单独关；新增 `pane`/`refocus` 只读归因（开合帧 P95、面板宽度、后台时长、回前台帧 P95/合并补发数）；`/lagfix report` 新增「侧栏开合」「回前台」两段；设置面板的「!」说明统一改成「会做什么 / 不会做什么 / 代价」的大白话。

## 安装

### 一键安装（推荐）

需要 **ZCode 桌面版**（Windows / macOS）与 **Python 3.8+**。不需要 Node，也不需要第三方 Python 包。

把下面整段发给 ZCode：

```text
请安装或更新并启用 ZCode 插件：https://github.com/ck-ys/zcode-lagfix#plugin-releases
完成后在新会话里执行 /lagfix install，确认补丁已注入；成功后提醒我完全退出并重新打开 ZCode（仅关闭窗口不算），不要自动重启。
若安装失败，请说明原因；若当前会话无法执行命令，请提示我手动执行，不要跳过或声称安装成功。
```

安装流程：

1. ZCode 从 `plugin-releases` 渠道拉取插件并启用。
2. `SessionStart` 钩子把运行时文件同步到 `~/.zcode/zcode-lagfix/`，并幂等注入 `app.asar`。
3. `/lagfix install` 可在当前会话立刻触发一次，适合修复被 ZCode 升级覆盖的注入。
4. 首次注入成功后**必须完全退出 ZCode（含托盘）再重开**；只关窗口或重开会话不算。

### 安装失败时

- **权限不足**（例如 ZCode 装在 `Program Files`）：让 ZCode 以管理员身份运行一次，或按 `/lagfix install` 输出的提示提权执行。钩子触发的失败写入 `~/.zcode/zcode-lagfix/hook-error.log`；手动执行 `install.py` 的失败写在终端和 `install.log`。
- **ZCode 正在运行**：`app.asar` 被占用时注入会挂起为 pending；完全退出后由值守进程自动收尾，重开即生效。
- **注入成功但状态条不出现**：先看 `/lagfix report` 的三段式诊断（未注入 / 注入了但观测器没起来 / 还没采到数据），再检查是否完全重启过。
- **以前卸载过，现在重新安装却没反应**：卸载会写 `~/.zcode/zcode-lagfix/.lagfix-optout`，钩子看到它会跳过注入。删除该标记后重试即可（见下文「恢复使用」）。

## 使用

### 状态条

主页面输入框上方显示：

```text
● 流畅  每帧 18ms  ⚙
```

- 判定词来自帧 P95 档位：极流畅 / 流畅 / 正常 / 轻微 / 卡 / 很卡；另有空闲 / 卡死 / 已暂停 / 已停。
- **颜色由面板里的黄/红阈值决定**：帧 P95、"卡死"停顿、最近 30 秒峰值都套同一组阈值；超过 30 秒的历史峰值不参与，不会因为一次 788ms 永久报红。
- 状态条用 fixed 定位，每秒按输入框 `getBoundingClientRect()` 同步坐标，不插进 React 树，避免被宿主重渲染清掉。
- 位置在输入框顶边上方，**不压输入区、模型选择与发送按钮**；与排队面板、额度横幅、待恢复提示、回到最新按钮相交时整体上移；上方没有余量时暂时隐藏。
- **只在主页面显示**：设置页、弹窗、被浮层盖住的输入框一律排除；分屏或草稿页同时存在多个 composer 时，取最靠下的可用者。

### 统计浮层

**悬停或点击状态条**打开统计浮层：

- 大号帧 P95、六档颜色图例；
- 最近 18 个采集周期的柱状图；
- 峰值 / 最低 / 最新帧间隔；
- 投影提交速率与长任务次数。

点击是固定展开，点页面别处或再点一次收起；悬停 120ms 后自动展开，移开 260ms 收起。

### 设置

点状态条末尾的齿轮，打开居中分类设置：

| 分类 | 内容 |
| --- | --- |
| 状态条 | 显示文字、信息量（简洁/详细）、警告/严重阈值 |
| 观测 | 观测开关、采集间隔 1 / 3 / 5 / 10 / 30 秒、滚动诊断、输入延迟、多会话分别统计 |
| 性能 | 合并刷新与最短刷新间隔、卡顿时自动放慢、切换会话时放慢、后台时减少刷新、大历史会话保护、滚动时去掉渐隐、侧栏与回前台保护（可逐项关闭） |
| 维护 | 日志路径与上限、当前日志量、重启 ZCode、检查更新、恢复默认 |

性能页每一项标题后都有圆圈「!」，点开用「会做什么 / 不会做什么 / 代价」三段说明，不写内部字段名。

设置面板的「性能」页：

<p align="center">
  <img src="docs/assets/preview-settings.png" width="720" alt="设置面板：侧栏与回前台保护">
</p>

**角标常驻显示**（v0.3.1 起删除了隐藏开关）：在设置页/弹窗内、被浮层遮挡、没有可用输入框时仍会自动隐藏，这是布局避让，不是用户开关。设置入口始终可用：

- 点角标末尾的齿轮
- `Ctrl+Alt+L`（macOS：`Cmd+Alt+L`）
- 控制台执行 `__lagfixSettings()`

「检查更新」只在你点击时请求一次 GitHub Releases（`api.github.com`，https，无 token），不会自动下载或安装；升级仍走下面的插件市场流程。

设置保存在 `localStorage["lagfix.settings.v1"]`（只此一个键），多窗口通过 `storage` 事件同步；主进程侧镜像到 `~/.zcode/zcode-lagfix/settings.json`，便于排查。

## 性能增强与取舍

### 订阅通知节流（v0.2）

宿主大约每 30ms 提交一次投影并通知所有订阅者，React 在 `useSyncExternalStore` 回调里整树重渲染，把主线程切碎。节流把**通知**合并为最多每窗口一次：

- **trailing 必达**，不是 debounce——持续流式时也会持续刷新；
- 只包装 `subscribe(listener)` 这种一参调用；带 selector 的 `subscribeWithSelector` 原样放行，否则会冻结 UI；
- 状态照常写入 store，只延后渲染通知，**不改任何数据**；
- 节流窗口按 **store 实例**计时，而不是按订阅——React 19 每次 commit 都会用新的内联箭头重新订阅，按订阅计时会让窗口在每次重订阅时清零；
- 找不到 store 时降级显示"待生效"，并每 3 秒重试（最多 20 次）；
- 关开关立即恢复即时通知；观测器自禁用时同步还原。

稳态默认窗口 120ms（面板可调 30~1000ms）。开启下面的增强后，窗口会按条件延长：

| 场景 | 最大通知间隔 |
| --- | --- |
| 稳态 | 120ms（面板可调） |
| 自适应窗口：帧 P95 ≥ 80ms / ≥ 150ms | 至少 200ms / 300ms（面板值更大时保持面板值） |
| 切会话后 10 秒内 | 不低于 250ms |
| 窗口在后台 | 最多 1 秒 1 次，回前台立即补一次 |

因此"渲染最多滞后 120ms"只适用于稳态。开启增强后实际窗口取 `max(面板窗口, 200/300ms)`：面板保持默认 120ms 时，极端情况约 300ms；若用户把窗口调到 1000ms，则保持 1000ms。后台最多 1 秒。这是用可感知的延迟换取主线程先完成首屏挂载与布局。

### v0.3 四项增强（全部可单独关闭）

进入或切换大历史会话时，宿主会为问题导航目录、分享目录做**一次性全量补拉**（`loadAllOlder` 分页读完再一次性换 snapshot），DOM 从几千行突然涨到上万行。v0.3 在"不动宿主数据"的前提下提供四个开关：

| 开关 | 默认 | 触发条件 | 行为 | 关掉后 |
| --- | --- | --- | --- | --- |
| 自适应窗口 | 开 | 最近帧 P95 ≥ 80ms / ≥ 150ms | 通知窗口至少 200ms / 300ms（以面板值为下限），帧恢复后回落 | 只按固定窗口 |
| 切会话冷静期 | 开 | 切/新建会话后 10 秒内 | 窗口不低于 250ms，让主线程先完成首屏挂载 | 切会话立即按固定窗口 |
| 后台降频 | 开 | `document.hidden` | 通知最多 1 秒 1 次；回前台立即补一次 | 后台仍按前台频率通知 |
| 大历史会话保护 | 开 | 总行数 ≥ 800 且只加载了一部分 | 拦下 `loadAllOlder` 全量补拉，返回 `not-enough-queries`（宿主视为终态，不会重试风暴）；分享入口点击后 15 秒内、分享弹层挂载期间自动放行 | 恢复宿主的一次性全量补拉 |

边界与取舍：

- 前三个开关只影响"什么时候通知 React 渲染"；大历史会话保护影响"要不要执行一次性全量补拉"。两者都**不改 store 数据、不改消息、不碰 `db.sqlite`**。
- 大历史会话保护的代价：大历史会话里问题导航的目录只覆盖已加载部分；正常上翻分页（`loadOlder`）、当前可见消息不受影响。
- 自适应窗口有 1 秒缓存，避免每次通知都重算帧统计。
- 全部关闭等价于 v0.2.3 行为；`__lagfixOff()` 会同时关掉节流与大历史会话保护、还原被包装的方法，并在本轮真的拦过补拉时自动补拉一次。

### v0.3.1 滚动观测与遮罩抑制

滚动卡顿和"进入会话时的一次性全量补拉"不是同一回事，v0.3.1 先把滚动这条链路量清楚，再提供一个可 A/B 的绘制层缓解：

| 项 | 默认 | 行为 | 关掉后 |
| --- | --- | --- | --- |
| 滚动诊断 | 开 | 只统计滚动后 200ms 内的帧（P95/max）、时间线 `scroll` 事件数、`loadOlder` 次数/耗时/失败、挂载 turn 数、DOM 峰值、浏览器支持时的 `long-animation-frame` | `collect` 的 `scroll` 为 `null`，不再做额外 DOM 扫描 |
| 输入延迟 | 开 | 只统计输入框内 `keydown` 到下一帧的间隔（P95/max/样本数），复用现有 rAF 循环 | `collect` 的 `input` 为 `null` |
| 滚动期隐藏遮罩 | 开 | 时间线滚动时给 `documentElement` 加 `data-lagfix-scroll="1"`，停滚 180ms 后移除；CSS 只覆盖消息层的 `mask-image` | 不添加属性，滚动时遮罩保持原样 |

边界与取舍：

- `loadOlder` **只观测**：不拦截、不延迟、不改返回值；`scroll.p95` 只代表"滚动后 200ms 内的帧"，不等于整段会话帧率。
- `input.p95` 只能说明"按键到下一帧"变慢，不能区分是浏览器输入延迟还是主线程排队；它**不修复**按键卡顿。
- 遮罩抑制只影响绘制，不改布局与 DOM。它的前提是宿主当前用**内联** `mask-image`（无 `!important`）；若宿主改成 `!important` 内联写法，本项会静默失效，靠 `scroll.p95` 与人工 A/B 发现。
- `scroll.mismatch`（`anyEvents>0 && events===0`）说明"有人在滚，但没命中已知时间线选择器"，先跑 `/lagfix report` 判断宿主是否改版。

### v0.3.2 多会话归因与补页明细

v0.3.1 能证明"有尖峰"，但分不清尖峰来自当前会话、隐藏会话还是一次补页。v0.3.2 只补证据，不改任何渲染/补页行为：

| 项 | 默认 | 行为 | 关掉后 |
| --- | --- | --- | --- |
| 多会话归因 | 开 | 按 `data-session-id` 分桶（最多 5 个），记录每个会话的投影提交次数/速率、DOM 节点数、挂载 turn 数、滚动帧 P95、可见性与最近活跃时间；隐藏 pane 也记录并标 `visible=false`；占位 sid（`draft`/空）切成真实会话后删除占位桶 | `collect` 的 `sessions` 为 `null`，不再遍历会话 pane |
| `loadOlder` 明细 | 随滚动诊断 | 最近 10 次调用的耗时、promise 是否正常结算、调用前后 `rows.window` 长度、触发来源（`scroll` / `initial` / `unknown`）；只读长度，不读分页内容。只包装主 store 实例，暂停期间不累计 | `collect` 的 `loadOlderDetail` 为 `null` |

边界与取舍：

- 最多 5 个桶；发现阶段满 5 个后额外 pane 只观察不建桶，等它有真实提交/滚动才淘汰最久未活跃的旧桶，历史数字随之丢失。切会话本身不算活跃，同值 SID/seq 重写也不计数。
- `visible` 只代表 CSS/几何可见，不代表"最前台"；分屏时两个 pane 可以同时为 `true`。
- `frames`/`commitRate` 依赖宿主继续更新 `data-projection-seq`，且只统计值真的变化；隐藏 pane 若被宿主停止渲染，会如实显示 0，这不等于"隐藏 pane 不耗资源"。
- `mountedTurns`/`dom` 是 pane 子树口径，固定每 60s 采样一次（新桶立即采）；`scroll.mountedTurns`/`domPeak` 仍是整窗口径，两者不能直接相加对比。
- `loadOlderDetail` 只覆盖当前主 store 实例（主 pane），不修改共享原型；`trigger` 是时间启发式（滚动后 2s 内 / 挂载后 5s 内的首次调用），不能证明宿主内部调用原因。
- 宿主 `loadOlder` 内部失败会打日志后正常 resolve，因此 `ok=true` 只表示"promise 正常结算"；报告会把行数未变标成"无变化"。
- `loadOlderDetail` 只在变化时携带完整数组，未变化样本发 `[]`；多会话归因每个样本约增加 0.4–0.6KB。默认 50MB 日志预算下如需要更长历史，可在面板调大 `logMaxMB`。
- 本版不改变任何渲染/补页行为，不应期待帧率变化；它的价值是让 v0.3.3 的缓解项有数据依据。

### v0.3.3 侧栏开合、面板常开期与回前台

右侧面板不只是"打开那一拍"贵：面板常开时仍有遮罩与重绘成本，从别的应用切回 ZCode 还会同步补发后台通知。v0.3.3 把它拆成三段，每段独立开关：

| 项 | 默认 | 行为 | 关掉后 |
| --- | --- | --- | --- |
| 侧栏与回前台统计 | 开 | 只读记录 `pane.detected/open/panelPx/switches/switchP95/switchMax/guardHits` 与 `refocus.hiddenMs/sinceVisibleMs/p95/max/flushes/guardHits`；回前台同时听 `visibilitychange` 与 `window.focus/blur` | `collect` 的 `pane`/`refocus` 为 `null`；若保护项仍开，只保留最小开合检测 |
| 侧栏开合保护 | 开 | 开合后 420ms 内给 `documentElement` 加 `data-lagfix-pane-switch="1"`：停掉 `[data-panel]` 的过渡、临时关消息层 mask、暂停角标定位 | 不加属性，宿主原过渡与遮罩完全不变 |
| 面板常开保护 | 开 | 面板打开期间加 `data-lagfix-pane-open="1"`：关消息层 mask、通知窗口至少 300ms、角标定位最多 1 次/1.8s | 不加属性，节流与角标回到原规则 |
| 回前台保护 | 开 | `hidden→visible` 或 `blur→focus` 后，把后台挂起的通知合并到一个 120ms 定时器；700ms 内通知窗口至少 400ms；前 300ms 不定位角标 | 恢复同步补发，不抬下限、不跳过角标 |

边界与取舍：

- 开合保护只覆盖 420ms（200ms flex 过渡 + 220ms 重内容 settle）；代价是开合从滑动变成瞬开/瞬收，不想要就关 P1。
- 面板常开期停 mask、把通知窗口抬到 300ms，聊天文字最多晚 300ms 刷新；Agent 收流、工具执行、消息落盘不受影响。
- 回前台最多晚 120ms 补状态；只延迟插件自己挂起的通知，宿主自己的首帧重绘不被拦截。
- `pane.detected=false` 表示宿主改版或当前布局没有桌面侧栏（如移动端 overlay），插件不猜选择器、也不加保护属性；先跑 `/lagfix report` 判断。
- 三段都只改通知时机、绘制层属性与角标定位；不改消息、会话数据、补页返回值，不写 store。若卡顿来自预览 HTML 自身绘制或宿主其它长任务，这三段仍可能不够。

## 日志、体积与隐私

运行时目录：`~/.zcode/zcode-lagfix/`

| 文件 | 内容 |
| --- | --- |
| `observe-YYYYMMDD.jsonl` | 每个采集周期的指标（帧、提交、长任务、堆内存、DOM 数量、滚动/输入诊断、多会话归因、loadOlder 明细、侧栏/回前台归因、设置快照） |
| `main.log` | 主进程加载器（注入、采集泵、自禁用原因） |
| `inject.log` | 每个窗口的注入结果 |
| `monitor.log` | 值守进程（何时等到、为何收不了尾） |
| `install.log` | 安装器动作与退出码 |
| `hook-error.log` | `SessionStart` 钩子异常 |
| `elevated-finalize.log` | 管理员权限收尾（仅使用提权工具时产生） |
| `settings.json` | 渲染端设置的只读镜像 |

日志清理只操作 `~/.zcode/zcode-lagfix/` 的直接子项，且文件名必须命中本插件白名单；每次删除前用 `lstat` 复核「普通文件、非符号链接、路径仍在运行目录」。符号链接、目录、用户文件、`settings.json`、今天正在写的 `observe-*.jsonl` 与未轮转的活动日志一律不删；任何异常都跳过（宁可超预算，也不误删）。

体积控制：

- 上述日志共享一个总预算，默认 **50MB**，面板「维护」页可改 20 / 50 / 100 / 200MB；
- 单个 `observe-*.jsonl` 达到 5MB 自动轮转为 `.1`；
- 超出总预算时**从最旧的文件开始删**，当天的活动观测文件不删；
- 观测日志另有 14 天保留上限（启动时检查一次，之后每小时补查）；
- 维护页实时显示**当前日志量与文件数**（不足 1MB 按 KB 显示），随每个采集周期刷新。

隐私边界：

- 只记录指标、窗口 id 与设置快照，**不记录**提示词、模型回复、文件内容、工具参数或数据库；
- 所有数据只写本机目录，不上传、不自动联网；唯一网络请求是用户手动点击「检查更新」时对 GitHub Releases 的一次查询（无 token、不自动下载/安装）；
- 不打开 CDP 端口，不读取 `db.sqlite`。

## 卸载

**先完全退出 ZCode（含托盘 / 任务管理器确认无 `ZCode.exe` 与 `zcode-runtime-host.exe`）**，再执行对应命令。`uninstall` 会先写豁免标记占位（堵住并发的钩子/收尾重装），再剥注入行；ZCode 仍在运行时 `remove` 返回 `failed` 并撤回标记，**最终状态仍是未卸载**，避免"号称卸了其实还在"。

### 从 GitHub 市场安装

```bash
python "$HOME/.zcode/zcode-lagfix/patch_install.py" uninstall
```

然后到 **设置 → 插件 → 已安装 → zcode-lagfix → 卸载**，再重开 ZCode。顺序不要反。即使不小心先卸载了插件，`~/.zcode/zcode-lagfix/patch_install.py` 仍然保留，完全退出 ZCode 后跑同一条 `uninstall` 即可清干净。

### 从源码安装

在仓库根目录执行：

```bash
python install.py remove
```

### 恢复使用

任何一次成功卸载都会留下 `~/.zcode/zcode-lagfix/.lagfix-optout`，它会让 SessionStart 钩子静默跳过注入。所以恢复顺序固定为：**先删标记，再安装**。

```bash
python -c "import pathlib;pathlib.Path.home().joinpath('.zcode','zcode-lagfix','.lagfix-optout').unlink(missing_ok=True)"
```

- 插件仍在启用：执行 `/lagfix install`。
- 插件已从市场卸载：先在 **设置 → 插件** 里重新安装并启用 zcode-lagfix，再执行 `/lagfix install`。运行时目录里的 `patch_install.py install` 只会重新注入 asar，不会恢复插件注册、命令和钩子。

`uninstall` / `remove` 只剥 lagfix 自己的注入行，绝不影响已装的其它注入插件（如 zusage 状态条）。

## 零安装探针（先看数，再决定装不装）

仓库自带一个外部响应探针，不改 `app.asar`、不用退出 ZCode：

```bash
python tools/lagfix-probe.py --overlay
```

> 探针仅支持 **Windows**（使用 Win32 消息队列）；插件本体支持 Windows / macOS。

右下角出现置顶小窗，每秒显示 ZCode UI 线程的消息泵延迟。原理是向 ZCode 主窗口发送 `WM_NULL` 空消息并计时：UI 线程被渲染占满时消息只能排队，回得就慢。这与系统判定"窗口无响应"走同一条路径；**不注入、不读窗口内容、不改任何文件**。

判读：

- P50 < 20ms：流畅
- P95 20~80ms：轻微掉帧
- P95 > 80ms：明显卡顿
- 单次 > 500ms：卡死级别

方法本身有自动化验证（`tests/probe_latency.py`：空闲约 0.03ms vs 人为占死 UI 线程 1024ms）。

## 从源码安装（开发）

在仓库根目录执行：

```bash
python install.py
```

安装器会：

1. 复制插件到 `~/.zcode/cli/plugins/cache/lagfix-marketplace/zcode-lagfix/<version>/`（只保留当前版本）；
2. 登记市场与插件，写 `enabledPlugins`；
3. 同步运行时文件到 `~/.zcode/zcode-lagfix/`；
4. 注入 `app.asar`。

ZCode 运行中时补丁会挂起（pending）。收尾不靠"数进程数 == 0"，而是每 2 秒直接尝试 `os.replace`，由操作系统仲裁：Windows 不允许 rename 覆盖已被打开或映射的文件，所以"能替换"就等于"确实没人握着它"。完全退出 ZCode 后 2 秒内自动完成，再打开即生效。

查看状态：

```bash
python install.py status
python "$HOME/.zcode/zcode-lagfix/lagfix_report.py"
```

报告按三段式诊断：未注入 / 注入了但观测器没起来 / 还没采到数据。

## 兼容性与共存

- **与 zusage 等注入插件共存**：注入行标记 `[lagfix] load failed`、loader 名 `lagfix-main.cjs`，与 zusage 的 `inject-main.cjs` / `[zusage] load failed` 互不匹配；锁、TMP、sidecar 文件名全部错开。
- **多插件收尾错峰**：检测到其它待收尾包时主动让对方先落地（累计上限 120 秒），等不到就放弃本轮，避免让别人的补丁永久失效。
- **宿主改版**：状态条依赖 `.chat-composer-input-surface`、`[data-v4-back-to-bottom-anchor="composer-dock"]` 与投影 store 的内部形状；侧栏保护依赖 `[data-workspace-side-frame="true"]` 的 `aria-hidden` 和外层 `[data-panel]`。ZCode 大版本改版后若状态条消失或 `pane.detected=false`，先执行 `/lagfix report` 判断是注入丢了还是选择器不匹配。
- **平台**：Windows 与 macOS 桌面版；Linux 桌面版未验证。

## 安全设计

- asar 手术逐文件断言读取长度 == 节点 size；stage 写入后 flush + fsync；替换前校验源 asar 指纹（size + mtime_ns + st_dev + st_ino）。
- 替换失败挂 pending，由值守进程在 ZCode 全退后收尾；收尾遇他人替换时基于当前文件重打。
- 注册表读失败一律中止，绝不回退空结构覆盖用户插件列表；写回采用 tmp + 原子替换，并保留当日备份。
- 改后入口用 `ZCode.exe --check`（`ELECTRON_RUN_AS_NODE`）做语法自检，30 秒超时。
- 运行时宿主包装只有三处：`subscribe`（只合并通知）、`loadAllOlder`（只在大会话且未全载时拦截）、`loadOlder`（只观测量耗时，不改参数与返回值）。v0.3.3 另加两个临时 `documentElement` 属性（`data-lagfix-pane-switch` / `data-lagfix-pane-open`）和对应 CSS，只在保护窗口/面板常开期存在；三条路径（关开关、自禁用、`__lagfixOff()`）都会立即移除。

## 测试

在仓库根目录执行：

```bash
node --check plugins/zcode-lagfix/lagfix-main.cjs
node --check plugins/zcode-lagfix/lagfix-observe.js
python -m py_compile install.py plugins/zcode-lagfix/*.py plugins/zcode-lagfix/hooks/*.py

python tests/line_regex.py      # 注入行正则与 zusage 互不误伤（11 项）
python tests/peer_gate.py       # 多插件收尾礼让与上限（5 项）
python tests/smoke_asar.py      # 合成 asar 夹具，byte 级验证重打包、busy 与卸载竞态（46 项，不碰真实安装目录）
python tests/install_remove.py  # install.py 卸载异常边界：Ctrl+C / 占用 / 插件态写入失败（8 项）
python tests/report_session_diag.py # 报告：会话桶/补页明细/侧栏与回前台/暂停回退/关闭边界/坏行（40 项）
python tests/probe_latency.py   # 外部探针方法有效性：空闲 vs UI 线程占死
node tests/observe_smoke.mjs    # 渲染端：可见性/角标/节流/滚动诊断/输入延迟/多会话/loadOlder/侧栏与回前台/日志/一键还原（326 项）
node tests/update_check.mjs     # 主进程检查更新：白名单/重定向/过滤/版本比较/体积上限/注入（19 项，不联网）
node tests/log_budget.mjs      # 主进程日志预算：超限删最旧/保留活动文件/14 天清理/符号链接与目录跳过/权限失败（24 项，假 fs 不写盘）
```

自动化测试不等同于所有 Windows / macOS 实机验收；首次安装后请按上文完全重启，确认状态条出现且 `/lagfix report` 有数据。

## 路线图

- **v0.3.4**：按 v0.3.3 数据从历史 backlog 里选 1–2 项——补页合并（O3）或 turn 内部行级 `content-visibility`（O4）；默认关闭的实验开关先上，A/B 通过再考虑默认开。
- **v0.3.5**：多会话策略（O7）——如果 v0.3.2/v0.3.3 证明是隐藏 pane 的提交/DOM 拖累，再评估"跨 store 共享调度器 / 全局通知预算 / 按可见性分级"，不提前合并全局调度器。
- **v0.4**：轻量模式（O5）与 turn 内再虚拟化（O6），需要宿主配合或更大的渲染端改造。
- **候选**：打开子智能体（Subagent）面板或多级任务时的卡顿：先量清是 DOM 规模、订阅通知还是面板挂载，再决定是否做成默认关闭的独立开关。
- **长期**：宿主改版后的选择器适配；自动更新（当前只做手动检查，不自动下载/安装）。

## License

[MIT](LICENSE) © 2026 ck-ys
