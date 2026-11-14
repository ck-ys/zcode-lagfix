# AGENTS.md

这份文件约束 AI 编程代理在 `zcode-lagfix` 仓库里的工作方式。它参考了 `smart-dock/AGENTS.md` 的“先对齐、再动手、可验证”写法，但按本仓库的定位重写：这是一个通过注入 `app.asar` 在 ZCode 渲染端运行观察器的桌面插件，不是普通 Web 应用。

取舍：安全、可验证、可回滚优先，不追求最快写完。很小的文案/注释改动可以简化流程，但不得越过下面“硬红线”。

## 0. 一句话定位

`zcode-lagfix` 观测 ZCode 超长会话的帧间隔、投影提交和主线程长任务，并提供可逐项关闭的缓解项。核心承诺是：**不修改会话数据、不读写 `db.sqlite`、不打开 CDP、不联网上报、随时可一键还原**。

## 1. 新会话启动 Checklist

任何新会话、切换模型或接手任务前，按顺序完成：

1. 读本文件、`README.md`、`docs/releases/` 里最新的发布说明。
2. 读 `docs/decisions/` 里与当前版本相关的最新拍板页；没有拍板结论时不直接开工。
3. `git log --oneline -10` 对齐最近锚点。完成度以 git、测试和实际运行结果为准，不凭旧文档或记忆推断。
4. 确认当前分支和待办：功能开发在 `feat/*`，不直接在 `main` 上改代码。
5. 改行为前先补/更新 `docs/specs/vX.Y.Z-*.md`；写清产品规则、状态所有者、接口、验收场景。
6. 涉及宿主 DOM、投影 store 或 `app.asar` 行为时，先到本机 ZCode 源码仓（按你的环境定位）grep 确认选择器/方法仍然存在；不要只凭旧版本记忆写代码。
7. 开工前报告一句：“已读 X，准备做 Y，已确认 Z 存在。”

## 2. 仓库结构

```
zcode-lagfix/
├── AGENTS.md                     # 本文件
├── README.md                     # 对外安装/使用/边界说明
├── LICENSE
├── install.py                    # 源码安装器（复制插件、登记市场、同步运行时、注入 asar）
├── marketplace.json              # 插件市场清单
├── docs/
│   ├── decisions/                # 拍板页、方案取舍（可提交）
│   ├── prompts/                  # 可直接粘贴给新会话的开发提示词
│   ├── releases/                 # 每个版本的发布说明
│   ├── specs/                    # 版本行为规格（先于实现）
│   └── v0.2-design.md
├── plugins/zcode-lagfix/
│   ├── .zcode-plugin/plugin.json # 插件版本/描述
│   ├── commands/                 # /lagfix 命令
│   ├── hooks/                    # SessionStart 钩子与运行时同步
│   ├── lagfix-main.cjs           # 主进程 loader：注入、采集泵、日志、设置镜像
│   ├── lagfix-observe.js         # 渲染端 observer：角标、面板、节流、大会话保护
│   ├── lagfix_report.py          # 三段式诊断报告
│   ├── patch_install.py          # 运行时安装/卸载（市场安装走这里）
│   └── install_monitor.py        # 值守进程：ZCode 全退后收尾
├── tests/                        # 合成 asar、注入行、竞态、observer 冒烟
└── tools/                        # 零安装探针、提权收尾、cmd 启动器
```

## 3. 硬红线

以下规则不是建议，违反即返工：

- **测试和开发绝不写真实安装目录**（如 ZCode 安装目录、Program Files 等）。asar 测试只用 `tests/smoke_asar.py` 的合成夹具；真实安装/替换必须由用户明确确认。
- **不读写 `~/.zcode/cli/db.sqlite`**，不读取会话正文、提示词、模型回复、工具参数或任何用户数据。
- **不打开 CDP 端口**，不把调试端口暴露到本机或局域网。
- **不联网上报**。插件只写本机 `~/.zcode/zcode-lagfix/`。
- **不打印、不提交凭据、token、真实用户数据或内部服务地址**。需要 GitHub API 时从本机配置读取，绝不回显。
- **不自动退出、杀掉或重启 ZCode**。安装器可以提示用户完全退出，但不得替用户执行。
- **不删除用户会话、日志或本地改动**。清理只允许删本插件自己的临时文件/日志，且要先确认路径。
- **不 force push、不改写远端历史、不擅自打 tag 或发 Release**。除非用户明确要求。
- **不用超时/兜底分支掩盖同步问题**。修复 bug 时先用源码、日志和运行时证据定位根因；未确认的假设要标注。
- **不把日志、截图、临时脚本、构建产物、`.venv/`、`__pycache__/` 提交进 git**。

## 4. 运行原理与状态边界

注入链：

```
ZCode app.asar 入口尾部
  └─ [lagfix] require(".../lagfix-main.cjs")
       └─ BrowserWindow.webContents 注入 lagfix-observe.js
            ├─ 角标 / 统计浮层 / 设置面板（DOM，fixed 定位，不插 React 树）
            ├─ __lagfixCollect() 每 N 秒回传指标
            └─ 三处宿主包装：
                 ├─ store.subscribe(listener)  → 合并通知（不改数据）
                 ├─ store.loadAllOlder()      → 大会话拦截一次性全量补拉
                 └─ store.loadOlder()         → 只观测耗时/失败/行数（v0.3.2，默认不改返回值；
                                              v0.3.4 翻页降频实验开启时跳过 600ms 内重复触发）
```

状态所有者：

- **设置**：渲染端 `localStorage["lagfix.settings.v1"]` 是唯一事实；主进程 `settings.json` 只是只读镜像，用于排查。
- **观测指标**：渲染端环形缓冲 + 主进程追加 `observe-YYYYMMDD.jsonl`；不进入任何业务 store。
- **节流窗口**：按 store 实例（WeakMap）计时，不按订阅计时。React 19 每次 commit 会重新订阅，按订阅计时会让窗口归零。
- **大会话拦截**：只改 `loadAllOlder` 的返回值，不伪造数据；`not-enough-queries` 是宿主认可的终态。
- **滚动/输入观测**：`scrollRing`/`loadOlderRing`/`inputRing` 是 observer 内存里的 30s 环形窗口；`scrollEvents`/`anyScrollEvents`/`lafCount` 每采集周期清零；`data-lagfix-scroll` 是 `documentElement` 属性，停滚 180ms 或关开关时移除。
- **多会话归因**：`sessionBuckets`（最多 5 个）按 `data-session-id` 分桶，`sessionMO` 是一个观察多个 pane 的 MutationObserver（目标集合不变时不重挂）；发现阶段满 5 个后额外 pane 只观察不建桶，有真实提交/滚动才淘汰最久未活跃的桶；`frames/commitRate` 只在采集周期结算，`mountedTurns/dom` 固定每 60s 采一次（新桶立即采）；暂停不改写 `lastActive`；不写 store。
- **补页明细**：`loadOlderDetail` 是 observer 内存里的 10 条环形窗口，只记 `t/ms/ok/rowsBefore/rowsAfter/trigger`；`rows*` 只读 `rows.window.length`。只包装主 store **实例**，不碰共享原型；暂停期间不累计；明细未变化时样本发 `[]`，报告端向前找最近一次非空。
- **检查更新**：渲染端只置内存标记 `updateCheckRequested`，随一个样本回传；主进程请求 GitHub Releases 后注入 `window.__lagfixUpdate`，不落盘、不带 token。
- **角标位置**：每秒按 composer 的 `getBoundingClientRect()` 同步，不写进 React 树；宿主重渲染不会清掉。同时避让 dock 内横幅与 body 级 Radix 浮层（`[data-slot="hover-card-content"]` 等），上方无余量时隐藏。

所有包装必须满足：

1. 幂等：重复 `attach` / 重订阅 / 看门狗重试不能套两层。
2. 可还原：开关关闭、observer 自禁用、`__lagfixOff()` 时恢复原方法。
3. 不改变数据：只合并通知时机或拦截一次性补拉，不修改消息、会话、工具结果。
4. 跨窗口安全：设置通过 `storage` 事件同步，注意防止回环。

## 5. 宿主契约（改选择器/接口前先核对）

当前依赖的宿主标记：

| 用途 | 选择器 / 接口 |
| --- | --- |
| 会话 pane | `[data-session-id]` |
| 投影提交序号 | `[data-projection-seq]` |
| 时间线滚动容器 | `[data-v4-timeline-scroll="true"]` |
| 消息层（遮罩） | `[data-v4-timeline-message-layer="true"]` |
| turn 单元 | `[data-v4-turn-unit="true"]` |
| 虚拟历史层 | `[data-v4-timeline-virtual-history="true"]` |
| 输入框 | `.chat-composer-input-surface` |
| 回到底部锚点 | `[data-v4-back-to-bottom-anchor="composer-dock"]` |
| 右侧面板外框 | `[data-workspace-side-frame="true"]`，`aria-hidden="true"` 表示收起 |
| 外层可调整面板 | `frame.closest('[data-panel]')` |
| 显式开合信号 | panel class 新增 `transition-[flex-grow]`（拖拽改宽不加） |
| turn 内的行级块（O4 作用对象） | `[data-row-id]`（`ConversationRowView`/`ConversationTurnGroup` 渲染） |
| 正在生成的回合（O4 排除标记） | `[data-v4-running-live-tail="true"]`（CV 选择器用 `:not()` 排除） |

已知宿主事实（v0.3.1 相关）：

- 虚拟单元是**整轮 turn**，不是单行；`ROW_OVERSCAN = 2`，单个超长 turn 可挂载数千 DOM。
- `loadOlder()` 每页 `snapshotTailWindowRows = 60`，单次上限 200 行；它替换 `rows.window` 引用，但不改 `snapshot.seq`。
- `data-projection-seq` 只反映 `snapshot.seq`，**不能用来判断 `loadOlder` 是否发生**。
- `handleScroll` 每次滚动都会调用 `syncMessageLayerMask`，同步写 6 个 mask 样式并读几何；mask 作用于整个消息层。
- `ConversationTimeline` 的 `loadOlder` 触发阈值约为 2 个视口；prepend 锚点在触发时捕获。
- 宿主已有 `content-visibility:auto` 先例（分享只读时间线），但只能加在 turn 内部行级块，不能加在被 virtualizer 测高的 turn wrapper 上。
- 多会话场景下，隐藏 pane 可能仍挂载或已被卸载；`[data-session-id]` 是唯一可靠的分桶键；宿主未分配会话 id 时写 `"draft"`（`sessionId ?? "draft"`），过渡态也可能是空字符串，两者都按占位 sid 处理。`data-projection-seq` 在隐藏 pane 上不一定继续变化，`frames=0` 只代表“没观察到提交”，不代表“不耗资源”。
- v0.3.3 相关：桌面侧栏外框常驻挂载，`isVisible` 只改 `aria-hidden` 与几何；`useAnimatedResizablePanel` 只在显式展开/收起时给外层 `[data-panel]` 加 `transition-[flex-grow] duration-200 ease-out`，`transitionend`/240ms 后移除；拖拽改宽不加。移动端 overlay 不写 `data-workspace-side-frame`，按 `detected=false` 处理。
- `AnimatedSidePanePanel` 的预览内容在 220ms resize settle 后才挂载；`ConversationTimeline` 的 ResizeObserver 会在面板动画期间每帧调用 `syncMessageLayerMask`。这两段是宿主行为，插件只临时停过渡/遮罩，不改布局。

ZCode 大版本改版后，先跑 `/lagfix report` 判断是注入丢失还是选择器不匹配；不要靠猜。

## 6. 性能改动协议

1. **先量因，再改代码**：用 `lagfix_report.py`、角标统计和 `observe-*.jsonl` 建立 baseline / 问题窗口 / 恢复后三段对比。至少记录帧 P95、长任务数量与最大值、DOM 数、提交速率、设置快照。
2. **一次只改一个变量**：每个缓解项独立开关，默认值必须有理由；不要把所有猜测塞进一个“优化”提交。
3. **不接受“隐藏内容”当优化**：折叠/隐藏工具卡、消息或历史，必须由用户拍板，不能偷偷做。
4. **不新增兜底分支来掩盖竞态**：不能用 `setTimeout` 猜同步完成；先明确事件顺序和唯一所有者。
5. **滚动类改动必须 A/B**：同一会话、同一段历史、同样滚动路径，对比开/关；记录 `scrollP95`、长任务、DOM 峰值和顶部空白时间。
6. **可还原**：新增开关关闭后行为回到上一版；`__lagfixOff()` 必须同时清掉新增的 DOM 属性、监听器和包装。

v0.3.1 已拍板范围（Route A）：

- O1 滚动窗口观测：`scrollP95`、滚动事件数、`loadOlder` 次数/耗时、挂载 turn 数、DOM 峰值、可选 long-animation-frame。
- O2 滚动期临时关闭消息层 mask：滚动时给 `documentElement` 加 `data-lagfix-scroll="1"`，180ms 无滚动后移除；CSS 只覆盖 `[data-v4-timeline-message-layer="true"]` 的 `mask-image`。
- O3（补页合并）、O4（turn 内部 `content-visibility`）只做默认关闭的实验开关或后续分支，不进入 v0.3.1 默认路径；O5/O6/O7 不在本版。
- 验收目标见 `docs/decisions/v0.3.1-scroll-lag.html`：滚动 P95 ≤80ms（目标 ≤60ms）、3s 长任务 ≤6、单次最长 ≤150ms（底线 250ms）、DOM 峰值 <6000、顶部空白 <300ms、锚点漂移 ≤现有 E2E 的 48px。

v0.3.2 已拍板范围（Route A，只读归因）：

- S1 多会话归因：按 `[data-session-id]` 分桶（最多 5 个），记录 `sid/visible/lastActive/frames/commitRate/mountedTurns/dom/scrollP95`；`sessionDiagOn` 默认开，关闭后 `sessions=null` 且不遍历 pane；`frames` 只统计 seq 值真的变化。
- S2 `loadOlder` 明细：最近 10 次 `t/ms/ok/rowsBefore/rowsAfter/trigger`；随 `scrollDiagOn`，不改变原 promise、返回值与 `this`。
- 验收目标见 `docs/decisions/v0.3.2-multi-session-and-loadolder.html` 第 06 节；本版不改宿主行为，不把“观测到尖峰”当成“已改善”。
- O3 补页合并、O4 turn 内 `content-visibility` 与 O7 多会话策略不在 v0.3.2；按本版数据在 v0.3.4 再选。

v0.3.3 已拍板范围（Route A，侧栏与回前台）：

- P0 侧栏/回前台归因：`pane`（`detected/open/panelPx/switches/switchP95/switchMax/guardHits`）与 `refocus`（`hiddenMs/sinceVisibleMs/p95/max/flushes/guardHits`）；随 `paneDiagOn`，关闭后两段为 `null` 且不挂对应探针。
- P1 侧栏开合 420ms 保护：显式开合时给 `documentElement` 加 `data-lagfix-pane-switch="1"`，临时 `transition-duration:0s`、关闭消息层 mask、`positionBadge()` 直接返回；420ms 后移除。拖拽改宽不触发。
- P2 面板常开期保护：外框 `aria-hidden !== "true"` 时保持 `data-lagfix-pane-open="1"`，期间 mask 关闭、通知节流下限 300ms、角标定位最多每 1.8s 一次。
- P3 回前台保护：`visibilitychange` 或 `blur→focus` 回前台后 700ms 内通知节流下限 400ms、前 300ms 跳过角标定位；后台积压的通知合并成一次 120ms 后的补发（`refocusGuardOn` 关闭时恢复同步补发）。
- 全部开关默认开、可独立关闭；关闭后行为回到 v0.3.2（`visibilitychange` 基线监听保留，继续重置帧基线并立即补发；P3 只额外挂 `blur/focus` 并接管补发时机）。`__lagfixOff()` 必须清掉两个 DOM 属性、P3 的 `blur/focus` 监听、两个 MutationObserver 与所有定时器；`visibilitychange` 基线与 v0.3.2 一样保留。暂停/自禁用仍移除全部监听。
- 验收目标见 `docs/decisions/v0.3.3-pane-lag.html` 第 06 节；本版只处理侧栏开合、面板常开、回前台三段，不改宿主布局、不折叠内容。
- 历史 backlog（O3 补页合并、O4 turn 内 `content-visibility`、O7 多会话策略、预览 HTML 自身绘制成本）留到 v0.3.4，按 v0.3.3 三段 A/B 数据再选 1–2 项。

v0.3.4 已拍板范围（Route A，归因先行 + 双实验）：

- P0 LoAF 卡顿归因（`lafDiagOn`，默认开，只读）：≥100ms 长帧记最近 10 条 `t/ms/styleMs/scripts[]`；`src` 只留文件名、`invoker` 截 120 字符；环是窗口级，不随会话切换清空；与 `lafCount`/`lafMax` 共用 observer，`(scrollDiagOn || lafDiagOn) && observe` 任一需要才装。
- O3 翻页降频（`loadOlderPaceOn`，默认关，实验）：窗口 >3000 行时两次 `loadOlder` 触发至少隔 600ms；跳过 = 不调原方法、不进观测环/明细、不计 `loadOlderCalls`、返回已结算 promise、不碰 `loadingOlder`/`canLoadOlder`。降频与 `scrollDiagOn` 独立，两者同关才卸载包装。宿主后端全量过滤是 O(全会话行数)/次的宿主侧成本，插件只减次数，文档不得包装成已解决。
- O4 turn 内 content-visibility（`turnContentVisOn`，默认关，实验）：`data-lagfix-cv="1"` + CSS 只作用 `[data-v4-turn-unit]:not([data-v4-running-live-tail]) [data-row-id]`，`contain-intrinsic-size:auto 160px` 用 remembered size 保证已渲染块对 virtualizer 测高无扰动；不碰 turn wrapper、不碰 live tail；纯 CSS 无新增监听器。
- 三键均可独立关闭；`__lagfixOff()`/自禁用/暂停三条路径必须清掉 CV 属性、归因环、降频计数。两项实验保留门槛：A/B 滚动 P95 或长任务下降 ≥20%（或长任务 ≥30%），否则永久默认关闭并如实标注。
- 行为规格见 `docs/specs/v0.3.4-loadolder-dom.md`；路线与数据门槛见 `docs/decisions/v0.3.4-route.html` 第 04/07 节。O7 多会话策略与预览绘制成本本版不做。

v0.3.5 已拍板范围（推荐 A：P0 + O5 + U1）：

- P0 长帧上下文归因（`lafCtxOn`，默认开，只读）：每条 ≥100ms 长帧记录 `sinceNotify/sinceFlush/sinceScroll/sinceCommit`（信号相对帧的滞后：帧前=距帧起点，帧内=0，晚于帧结束或未发生=`null`），归类 `flush/notify/scroll/other`；候选为 flush/notify/scroll 中滞后最小者，必须 ≤1000ms；帧内候选按信号发生时间取更早者，完全同毫秒按 flush→notify→scroll；commit 只作上下文不成类，attach/切会话清零。`ctx` 是本周期四类计数；样本带 `paneOpen`（未检测到侧栏为 `null`）与 `panelQuiet`（0/1）。P0 需要 `lafDiagOn` 父开关同时开启；滚动时间戳独立为 `lastLafScrollAt`，不得复用/污染滚动诊断的 `lastScrollAt`。
- O5 面板期进一步合并（`panelQuietOn`，默认关，实验）：面板打开且观察到时通知下限 300→400ms、角标上限 1.8s→3s；面板关闭后新通知立即回基础间隔（在途一次最多按原窗口送达，400ms 下限在 1s 缓存之外计算）；不新增 DOM 属性、不碰 mask；即使 P2/P1/P0 全关，只要 O5 开就保留 pane 探针。过线门槛沿用 A/B：长帧数或 `frameP95` 下降 ≥20%，否则永久默认关闭。
- U1 只出文档：把右侧预览是 Electron `<webview>` guest、合成落在宿主 renderer 的证据写进 README/发布说明，不改注入链、不声称插件已修。
- 两键均可独立关闭；`__lagfixOff()`/自禁用/暂停三条路径必须清空四个时间戳、`ctx` 计数与 `paneOpen/panelQuiet` 输出。行为规格见 `docs/specs/v0.3.5-laf-context.md`；拍板页见 `docs/decisions/v0.3.5-next-optimization.html`。O3b（自动补拉降频）与 O6（非活动 pane 节流）本版不做。

v0.3.6 已拍板范围（推荐 A：O8 补页批量，默认关闭的实验）：

- O8 补页批量（`loadOlderPageLimitOn`，默认关）：只包装当前主 store **实例**的 `loadOlder`；仅当调用方无参且开关开、未自禁用时，改为 `orig.call(this, 200)`（协议上限内）；显式参数、开关关、自禁用一律原样 `orig.apply(this, arguments)`。必须保留 `this`、Promise、异常、`loadingOlder/canLoadOlder` 与返回内容；不跳过、不合并、不缓存、不写 store。包装安装条件扩展为 `scrollDiagOn || loadOlderPaceOn || loadOlderPageLimitOn`；只开 O8 也必须生效。计数 `page={limit,installed,applied,passthrough}` 随包装器生命周期：从关到开/换 store/自禁用/`__lagfixOff()` 清零，暂停观测不重置（替换仍生效）；`__lagfixOff()` 同时把开关置 false。样本 `page` 仅在开关开时上报，关闭为 `null`；`installed=false` 表示包装未装上、计数不可用。报告补页段显示页大小、生效与放行次数，遇到 dead/显式 `page=null` 停止回退，不回显旧计数。
- 依赖宿主契约：ZCode v3.17.2 源码与安装版 v3.18.1 `app.asar` 均已核对 `loadOlder(limit = 60)` 与 `rowsRangeMaxLimit = 200`；宿主调用点为无参。未来若参数消失或上限变化，本实验必须停用并在报告提示，不得猜参数。
- 明确不做：O3 行为改动、O3b 自动补拉降频、O6/O7 隐藏 pane 策略、预览 HTML 优化；不折叠/不隐藏任何内容；不改消息、会话、工具结果；不读 `db.sqlite`；不开 CDP；不联网。
- A/B 门槛：同一会话、同一段历史、同一滚动路径做关→开→关至少 3 轮；补页次数下降 ≥50%（目标约 -66%），且补页总阻塞或滚动 P95/长任务下降 ≥20%，顶部空白 ≤300ms、锚点漂移 ≤48px、DOM 峰值不增加 >20%；未过线保持默认关闭并如实标注。行为规格见 `docs/specs/v0.3.6-loadolder-page.md`；拍板页见 `docs/decisions/v0.3.6-loadolder-page.html`。

v0.3.7 已拍板范围（更新提醒：小红点 + 可选自动检查）：

- U2 有新版本小红点：检查结果缓存在 `localStorage["lagfix.update.v1"]`（只含版本号、`newer`、release 链接、时间戳），跨窗口与重启保留；仅当 `newer===true`、缓存 `current===VERSION` 且 `latest!==VERSION` 时，在角标右侧（文字与齿轮之间）与维护页「检查更新」行显示红点。缓存版本不一致、`latest` 与当前相同、`newer=false` 一律不显示。
- U3 自动检查更新（`autoUpdateCheckOn`，默认关）：开启后 ZCode 启动/窗口打开时最多检查一次，`checkedAt` 写本机，24 小时内不重复；主进程再按 24 小时去重并缓存成功结果，多窗口同时到期只发一次网络请求。只请求公开 GitHub Releases（`api.github.com`、HTTPS、最多 2 跳、10 秒总时限、2MB 上限），不带 token，不自动下载/安装，不上报本机数据。
- 手动检查保持原样：点击后置 `updateCheckRequested` 并清 `updateCheckAuto`；样本带 `updateAuto=0/1`。`__lagfixOff()` 关闭自动检查、清更新缓存与两处红点、清在途标记；手动按钮仍可用。
- 反馈入口（U4）：维护页「反馈问题」按钮只打开固定 GitHub issue 模板（优先 `window.zcode.openExternal`，失败退回 `window.open`）；README 增加「遇到问题」章节，issue 模板要求 `/lagfix report`、`main.log` 与最近一个 `observe-*.jsonl`。插件不自动读取或上传日志。
- 明确不做：自动下载、自动安装、自动重启、后台常驻轮询、把更新结果写进会话或日志正文；不改注入链与其他缓解项。
- 行为规格见 `docs/specs/v0.3.7-update-dot.md`；发布说明见 `docs/releases/v0.3.7.md`。

v0.3.8 已拍板范围（日志清理加固，只删不覆盖）：

- 用户拍板继续使用「删除」而不是覆盖/`truncate`；本版只加固删除判定，不改日志内容、观测字段、注入链与任何缓解项。
- 运行目录安全：清理前 `lstat` DATA_DIR，必须是普通目录、非符号链接/junction；不满足或读取失败时 14 天保留与预算清理都跳过，只写一条告警。结果进程内缓存。
- 文件名校验：`observe-YYYYMMDD.jsonl(.N)` 的日期必须真实（round-trip、年份 2020–2100）；非法日期不认作插件日志。
- 预算清理：最小删除年龄 10 分钟；删前重新 `lstat` 复核名字/路径/普通文件/非链接/年龄；按当前大小修正总量，文件变小已回到预算内立即停止；删除失败不扣总量、同一文件每进程只告警一次。
- 安装器临时文件：`install.py:_sweep_tmp` 与 `patch_install.py:sweep_tmp` 只删 `RUNTIME_FILES` 文件名 + `.tmp-<pid>` 的普通文件，跳过符号链接/非普通文件；不再匹配任意 `*.tmp-<pid>`。
- 明确不做：覆盖/截断、递归删除、删除运行目录外文件、跟随符号链接、压缩/回收站/外部删除命令、提权强删。
- 行为规格见 `docs/specs/v0.3.8-log-retention.md`；发布说明见 `docs/releases/v0.3.8.md`。

v0.3.9 已拍板范围（设置面板滚动/焦点与还原边界，不改观测字段）：

- B 面板开关跳顶：`rebuildPanel()` 重建前读取 `.dlg-content` 的 `scrollTop`，重建后写回；内容区固定 id `lagfix-panel-content`。只影响重建，不改变分区与开关值。
- 模态焦点：首次打开记录 `document.activeElement` 并把焦点移到面板容器（`tabindex="-1"`，无焦点框）；打开期间 Tab/Shift+Tab 在面板内循环，无可聚焦控件时保持面板焦点；关闭时若原元素仍连接则归还焦点。`rebuildPanel()` 优先恢复同一序号的可聚焦控件，否则聚焦面板容器。
- `restoreTarget` 还原守卫：`subscribe` 包装记录 `{orig, wrapped}`，只有 `target.subscribe === wrapped` 时才写回 `orig`；宿主运行期替换了 `subscribe` 时不得覆盖，标记属性可以删除。`__lagfixOff()`、关闭「合并刷新」、observer 自禁用共用该规则。
- 订阅回调异常：仍不向宿主冒泡，但每页面最多 `console.error` 一次；不写 `observe-*.jsonl`，不改变采样与开关。
- 更新状态文案：`newer=false` 且 `current > latest` 时显示「当前 vX 高于最新发布 vY（发布通道尚未更新）」，不显示红点；`current === latest` 保持「已是最新」。
- 明确不做：不把 `__lagfixOff()` 改成完全卸载（v0.3.0–v0.3.2 已拍板保留观测、角标与 Ctrl+Alt+L 入口）；不改 composer、不改消息/会话/工具结果、不改注入链、不新增网络请求。
- 行为规格见 `docs/specs/v0.3.9-panel-focus.md`；发布说明见 `docs/releases/v0.3.9.md`。

v0.3.10 已拍板范围（更新红点可见性，单点修复）：

- 根因：两处红点样式默认 `display:none`，`syncUpdateDot()` 显示时写空串，浏览器回落到样式表默认值，红点永远不显示。
- 修复：显示时写显式 `inline-block`，隐藏时写 `none`；条件、位置、颜色、点击行为与缓存结构不变。
- 自动化：红点可见断言从 `display === ""` 改为 `display === "inline-block"`，覆盖默认隐藏、有新版本、跨窗口、`current > latest`、`__lagfixOff` 五条路径。
- 明确不做：不改检查更新请求、24 小时自动检查、缓存 key、红点判定条件、注入链或其它缓解项。
- 行为规格见 `docs/specs/v0.3.10-update-dot-visibility.md`；发布说明见 `docs/releases/v0.3.10.md`。

v0.4.0 已拍板范围（推荐 A：T1 + U2 + O8b）：

- T1 第三方定时器归因（`timerDiagOn`，默认关，只读）：包装 `window.setTimeout` / `setInterval` 的函数 handler，只记录单次同步执行 ≥50ms 的明细 `t/ms/delay/kind/src/invoker`；`src` 只留函数名，`invoker` 只留 `basename:line:col` 并截断 120；环 10 条、未变化发 `[]`；`count/max` 周期口径。不改时机/参数/返回值/异常；字符串 handler 原样放行；插件自己的定时器统一走安装前原始方法（`lafSetTimeout`/`lafSetInterval`），不测自己；调用栈命中 `lagfix-(observe|main)` 的外部调度也跳过。关闭/暂停/自禁用/`__lagfixOff()` 四条路径恢复原引用并清空。
- O8b 自适应补页（`loadOlderPageLimitOn`，默认关，实验）：常量 120 行 / 3000 行门槛 / 600ms 连续窗口；只对无参调用且窗口 >3000 行生效；600ms 内第二次回到宿主默认 60；小窗口/行数不可读按 60；显式参数原样放行；**不跳过**、不合并/缓存/删除/改序，保留 `this`/Promise/异常/`loadingOlder`/`canLoadOlder`。计数 `applied/downgraded/small/passthrough`，从关到开/换 store/自禁用/`__lagfixOff()` 清零，暂停观测不清零。替代 v0.3.6 固定 200 行。
- U2 共存文档：zusage 1.5.17 每 100ms `getState()` 深拷贝 6868 行（≈86ms/次）是已确认的卡顿源，1.5.18 已修（#309）；README/发布说明写清证据与升级建议，不声称插件已修上游。
- 报告：新增 `timer` 段（关闭/暂停/未装上/0 条分别说明；明细与按回调名聚合 top3）；补页段显示 120 与四类计数，旧样本只显示已有字段。
- 明确不做：不修改/延迟/取消定时器，不读回调参数或内容；不跳过补页、不合并分页；不改注入链、消息/会话/工具结果；不读 `db.sqlite`、不开 CDP、不联网上报。
- A/B 门槛：O8b 调用次数下降 ≥30%，补页总耗时或滚动 P95/长任务不退化 >10%，锚点漂移 ≤48px，DOM 峰值增加 ≤20%；未过线保持默认关闭，调用次数也没明显下降则退役该项。行为规格见 `docs/specs/v0.4.0-t1-timer-attribution.md`、`docs/specs/v0.4.0-o8b-adaptive-page.md`；发布说明见 `docs/releases/v0.4.0.md`。

v0.4.1 已拍板范围（角标更新红点移到齿轮右上角，单点视觉修复）：

- DOM：红点 id 不变（`lagfix-overlay-badge-update-dot`），从角标容器移到齿轮按钮 `lagfix-gear` 内部；`aria-hidden="true"`，不再自带 `title`。
- CSS：`.lg-gear` 加 `position:relative`；`.lg-update-dot` 改为 `position:absolute; top:-2px; right:-2px; width:6px; height:6px`，带 `box-shadow:0 0 0 1.5px var(--color-popover,#161b22)` 描边，`pointer-events:none`。
- 角标容器保持 `overflow:hidden`；红点只伸进角标自身内边距，不越过裁切边界；点红点等同点齿轮。
- 状态：显示条件、`syncUpdateDot()` 的 `inline-block`/`none`、缓存 key 与检查逻辑全部不变；齿轮 `title` 在有新版本时为「打开设置（有新版本）」，否则「打开设置」。
- 维护页「检查更新」行红点保持行内，不移动。
- 明确不做：不改网络请求、24 小时自动检查、红点判定条件、角标尺寸/指标文字/齿轮点击行为；不新增设置项或日志字段。
- 行为规格见 `docs/specs/v0.4.1-update-dot-corner.md`；发布说明见 `docs/releases/v0.4.1.md`。

v0.4.2 已拍板范围（观测口径与包装器生命周期加固，不新增缓解项）：

- S1 帧统计：`frameRing` 扩到 3600（30s × 120Hz）；`frameStats().max` 为窗口内最大值；样本新增 `frameMaxAll`（attach/切会话以来）与 `frameMaxWindow`（最近 30s），旧 `frameMax` 保留为历史值兼容；角标/悬停只用窗口值。
- S2/S3 包装器 identity：`loadAllOlder` 与 `subscribe` 的 marker 记录 `{orig, wrapped}`；宿主运行期替换实现后不复用旧 marker，按当前实现重装；释放时只还原本插件那一层，不覆盖宿主。
- S4 O3 代际门控：`loadOlder` 旧 wrapper 在 `gen !== loadOlderGen` 时原样直通，不跳过、不计数、不写明细；丢弃旧 marker 时递增代际。
- S5 T1 失配：定时器 probe 校验全局 identity；失配时 `supported=0/lost=1`，旧 wrapper 直通、不抓栈；重装以当前实现为 original；关闭只还原自己那层。
- S6 报告一致性：滚动/输入关闭态明示且不回退旧数据；`timer.epoch`/`laf.epoch`/`scroll.loadOlderEpoch` 跨代际停止回退；`_fmt_ts_full` 只接受 2000–2100 年，越界显示 `-`。
- 明确不做：不新增设置项、不改默认值、不把实验项转默认；不做插件自身开销微优化与安装器/日志清理改动（v0.4.3 或独立 chore）；不折叠/隐藏内容，不改消息、会话、工具结果，不读 `db.sqlite`，不开 CDP，不联网上报。
- 行为规格见 `docs/specs/v0.4.2-observability-accuracy.md`；拍板页见 `docs/decisions/v0.4.2-observability-accuracy.html`；发布说明见 `docs/releases/v0.4.2.md`。

v0.4.3 已拍板范围（会话切换归因 + 修复失灵的翻页降频 + O8b 退役）：

- P0 切换归因（`switchDiagOn`，默认开，只读）：复用 `attach()`/MO 的 sid 变化信号，150ms 去重；双窗口 = 切换后 2s 帧切片（`afterMax2s/afterP95`，live 累加、冻结时算 P95）+ 30s 长帧/强制布局与成功补页累计（`lafN2s/styleMs2s/lafN30s/styleMs30s/loadOlderN30s/loadOlderMs30s`）；`domBefore/After`、`turnsBefore/After` 取缓存值，切换瞬间不做 O(DOM) 扫描；`blockedLoadAll` 为冻结时增量；环 10 条，`from/to` 只留 sid 前 8 字符，被淘汰的会话桶不影响记录；未变化样本发 `[]`，关闭/暂停/dead 为 `null`。
- O3 触发口径修复：删除 `paceInScrollDispatch` 同步门控，改为与 `classifyLoadOlderTrigger` 一致的时间窗（`performance.now() - lastScrollAt <= 2000ms`）；首调（`callsInWrap===0`）或挂载 5s 内一律放行，保护 SessionPane 冷快照修复补拉；所有非跳过调用计入 `allowed`；`lastScrollAt` 在滚动诊断或降频任一开启时刷新，两者同关/自禁用才清。
- O3 计数双口径：`paceStats`（当前 store 生命周期）与 `paceTotal`（全天累计，只在自禁用/`__lagfixOff()` 清零）；样本 `pace` 增 `totalAllowed/totalSkipped`，报告并列显示、旧样本标「无累计口径」。
- O8b 退役：移除 `loadOlderPageLimitOn` 的行为、常量、面板行与 `page` 样本字段；旧设置键读取时忽略；包装安装条件 = `scrollDiagOn || loadOlderPaceOn`；报告对旧日志保留 `page` 计数并统一标注「已退役」。
- 明确不做：切换期保护实验（P1 推迟到 v0.4.4，等本版数据）；插件自身开销微优化；T1 异步口径；O6/O7 隐藏 pane 策略；不折叠/隐藏内容，不改消息、会话、工具结果，不读 `db.sqlite`，不开 CDP，不联网上报。
- 行为规格见 `docs/specs/v0.4.3-session-switch-and-pace.md`；拍板页见 `docs/decisions/v0.4.3-session-switch.html`；发布说明见 `docs/releases/v0.4.3.md`。

v0.4.4 已拍板范围（推荐 B：切换回填大页实验 + 只读行数归因）：

- O9 切换后大页补页（`switchBackfillPageOn`，默认关，实验）：真实会话切换后的 30 秒内，无参 `loadOlder` 的页大小从宿主默认 60 提到 120（协议上限 200）；已载行数 >3000、窗口过期、行数不可读、占位 sid（`""`/`"draft"`）或调用方显式传参时原样直通。不跳过、不合并、不缓存、不预取、不删除、不改顺序；保留 `this` / Promise 引用 / 同步异常 / `loadingOlder` / `canLoadOlder` / 返回内容。只包当前主 store 实例，不碰共享原型。
- 窗口在 `recordSwitch(fromSid,toSid)` 入口、`switchWatchActive()` 门控之前写入（`performance.now()` 域）；只认真实 sid 之间的切换，首次挂载、同 sid 重挂、draft/空 sid 不新开窗口；从真实会话切到占位会话时清掉旧窗口。切换识别依赖 `observe=true`，但不依赖 `switchDiagOn` / `scrollDiagOn`；暂停观测不新开窗口，已开窗口继续走表且计数继续累加，样本暂停上报。
- 包装安装条件扩展为 `scrollDiagOn || loadOlderPaceOn || switchBackfillPageOn`；sid 变化后的立即安装与 5s 看门狗条件同步加入本项。只开本项、关滚动诊断与降频时也必须装上并生效。
- S3 补页行数归因（只读）：切换记录新增 `loadOlderRows30s`，只累加成功补页的 `max(0, rowsAfter-rowsBefore)`；非数字按 0，不猜。样本新增 `switchPage={limit:120,applied,passthrough,installed}`，仅开关开时上报，关闭为 `null`；计数随包装器生命周期，关→开、换 store、自禁用、`__lagfixOff()` 清零；暂停观测不清零。`installed=false` 表示包装未装上，不伪装成 0/0。
- 报告新增「切换回填页（实验）」段（开+已装/未装、`applied=0` 提示、关闭、旧样本）；切换段每条 30 秒补页显示 `N 次 / R 行 / Xms`，旧样本无 R 显示 `-`，不回退成次数或 0。
- 三键（`scrollDiagOn`/`loadOlderPaceOn`/`switchBackfillPageOn`）同关才释放 `loadOlder` 包装；关闭本项立即停止 120 行并清窗口/计数；`__lagfixOff()`、自禁用清 `switchBackfillAt` 与计数，面板复选框取消勾选。
- A/B：同一会话、同一段历史、同一滚动路径；`observe/switchDiagOn/scrollDiagOn` 全开、`loadOlderPaceOn=false`、`turnContentVisOn` 固定；只切 `switchBackfillPageOn`，关→开→关至少 3 轮，不暂停观测。按每 1000 行归一化 `loadOlderN30s/loadOlderRows30s*1000` 下降 ≥30%，`loadOlderMs30s/loadOlderRows30s*1000` 下降 ≥20%（或滚动 P95/长任务下降 ≥10%）；2 秒切换帧不退化 >10%、顶部空白 ≤300ms、锚点漂移 ≤48px、DOM 峰值增加 ≤20%。每轮必须 `switchPage.installed=true` 且 `applied>0`，否则无效重做。未过线保持默认关闭并如实标注；归一化调用次数无明显下降则退役。
- 明确不做：切换瞬间微批（留给 v0.4.5）；不改 O3 默认值/门槛/跳过行为；不处理 1 秒切换帧本身、不声称切换变快；不升级/禁用 zusage；不折叠/隐藏内容，不改消息、会话、工具结果，不读 `db.sqlite`，不开 CDP，不联网上报。
- 行为规格见 `docs/specs/v0.4.4-switch-backfill.md`；拍板页见 `docs/decisions/v0.4.4-switch-backfill.html`；发布说明见 `docs/releases/v0.4.4.md`。

## 7. 版本与发布

每次版本变更必须同步以下位置，缺一不可：

| 位置 | 内容 |
| --- | --- |
| `plugins/zcode-lagfix/.zcode-plugin/plugin.json` | `version` 与描述 |
| `marketplace.json` | 市场描述与插件 `version` |
| `install.py` | `_version()` 的 fallback 版本 |
| `plugins/zcode-lagfix/hooks/hooks.json` | 描述里的版本号 |
| `README.md` | 顶部 badge、当前版本说明、路线图 |
| `plugins/zcode-lagfix/lagfix-observe.js` | 面板底部版本行 |
| `docs/releases/vX.Y.Z.md` | 新增/修复/安装注意/验证/已知边界 |
| `docs/specs/vX.Y.Z-*.md` | 本版行为规格（先于实现） |

发布通道：

- `main`：源码与文档。
- `plugin-releases`：市场安装读取的稳定渠道，指向已验证的发布提交。
- tag `vX.Y.Z`：附注标签，指向同一提交。
- GitHub Release 页面默认由用户手动创建；未得到明确指示不自动发布。

## 8. 测试与验证

从仓库根目录执行：

```bash
node --check plugins/zcode-lagfix/lagfix-main.cjs
node --check plugins/zcode-lagfix/lagfix-observe.js
python -m py_compile install.py plugins/zcode-lagfix/*.py plugins/zcode-lagfix/hooks/*.py

python tests/line_regex.py      # 注入行正则与 zusage 互不误伤
python tests/peer_gate.py       # 多插件收尾礼让
python tests/smoke_asar.py      # 合成 asar 夹具，绝不碰真实安装目录
python tests/install_remove.py  # 卸载异常边界
node tests/observe_smoke.mjs    # 渲染端 observer 冒烟
python tests/report_session_diag.py  # 报告会话桶/补页明细的边界（旧样本、回退、关闭、坏行）
node tests/update_check.mjs     # 主进程检查更新：白名单/重定向/版本比较/体积上限（不联网）
node tests/log_budget.mjs       # 主进程日志预算：超限删最旧/保留活动文件/14 天清理（假 fs，不写盘）
```

规则：

- 改动 observer 行为必须扩展 `tests/observe_smoke.mjs`，覆盖默认值、开关关闭、DOM 属性生命周期、payload 字段、面板行和 `__lagfixOff()` 清理。
- 改动主进程「检查更新」必须跑 `tests/update_check.mjs`（vm + 假 https，不联网）。
- 改动 asar 注入/卸载必须跑 `smoke_asar.py` 和 `install_remove.py`；测试只用合成夹具。
- 实际执行了哪些命令、结果如何，必须如实报告；未执行或环境受限要明确说明，不把“应该能过”写成“已通过”。
- 自动化测试不等同于 Windows/macOS 实机验收；首次安装后必须提示用户完全退出并重开 ZCode。

## 9. 日志与隐私

- 运行时目录：`~/.zcode/zcode-lagfix/`。
- 观测/运行日志共享总预算（默认 50MB，可在面板调整），单个 `observe-*.jsonl` 5MB 轮转，14 天保留。清理只允许删 `~/.zcode/zcode-lagfix/` 直接子项里命中白名单的普通文件；删前 `lstat` 复核非符号链接、非目录、路径未越界；活动 `observe-*.jsonl`、未轮转日志与 `settings.json` 永不删除，任何异常一律跳过。
- 只记录指标、窗口 id、设置快照、会话 sid 与计数、`loadOlder` 元数据、长帧的脚本文件名与调用点（`invoker` 截断 120 字符，不含路径/源码位置）；不记录提示词、回复、文件内容、分页内容、消息 id、工具参数。
- UI 日志用 `packages/ui/src/logger.ts` 的等价约束不适用于本仓库；本仓库渲染端不引入宿主 logger，调试输出走观测器内部 `err()`/日志，不往控制台刷敏感信息。
- 不把日志文件提交进 git。

## 10. 产物归置

- 拍板页、方案对比：`docs/decisions/`，可提交。
- 版本规格：`docs/specs/`，可提交。
- 发布说明：`docs/releases/`，可提交。
- 可直接粘贴的开发提示词：`docs/prompts/`，可提交。
- 临时脚本、验证输出、截图：放系统临时目录（如 `%TEMP%` 或 `$TMPDIR`），**不要平铺在仓库根**；需要长期留的证据才脱敏后放 `docs/decisions/assets/`。
- 不把 `.venv/`、`__pycache__/`、`*.log`、`*.tmp`、`.lagfix-stage-*` 提交进 git。

## 11. Git 与提交

- `main` 保持可发布；功能开发开 `feat/<version>-<topic>` 分支。
- 一个提交只做一件事：spec/拍板、实现、测试、版本文档尽量分开。
- 提交信息用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀，中文描述可以。
- 不在未确认时 `push`、`tag`、`release`、`force push` 或改写远端历史。
- 本地仓库已与远端同步；若在新环境重新初始化为 shallow，推送前先 `git fetch --unshallow`，避免把不完整历史推上去。

## 12. 常见坑

- 节流只包装**一参** `subscribe(listener)`；`subscribeWithSelector` 必须原样放行，否则 UI 会冻结。
- 窗口按 store 实例计时，不能按订阅闭包计时；React 19 每次 commit 会重新订阅。
- `loadAllOlder` 拦截返回 `not-enough-queries`，不要返回 `undefined` 或抛错，否则宿主会重试风暴。
- 大会话保护只拦“全量补拉”，不要误伤正常 `loadOlder` 分页。
- 角标是 fixed 定位，不插 React 树；位置要避开输入区、排队面板、额度横幅和“回到最新”按钮。
- `data-projection-seq` 不变不代表没有补页；判断 `loadOlder` 要看独立计数。
- 注入行必须与 zusage 的 `inject-main.cjs` / `[zusage] load failed` 错开；loader 名 `lagfix-main.cjs` 不要改。
- Windows 下 `.cmd` 文件编码敏感（GBK/UTF-8 与 `chcp` 的顺序会影响中文显示）；改启动器时保留现有注释里的编码约定。
- 任何新增的全局监听器/属性都要在 `__lagfixOff()`、关闭开关、observer 自禁用三条路径清理。

## 13. 对外介绍页与视觉

- README 首屏只做四件事：图标 → 一句话定位 → 三条硬边界 → 一张真实界面截图；不堆版本号、功能清单和内部字段名。
- 界面截图放 `docs/assets/`，必须来自真实 observer；演示环境截图要在图前写明“模拟数据、不含真实会话内容”，不得使用真实会话截图。
- 设置面板与对外文案用用户语言：不写 P95、DOM、loadOlder、mask、pane、store、turn 等内部词；每项说明按「会做什么 / 不会做什么 / 代价」组织。
- 截图只放在对应章节，一屏一个重点；不给图片加说明性 caption，事实、边界和代价用正文写清。
- 新增或替换截图后同步 `marketplace.json` 的 `icon` / `heroImage`（只接受 HTTPS，用 jsdelivr `@main`），并检查 GitHub 渲染与窄屏不横向溢出。
- 视觉优化参考 taste skill；美化不得改事实、删边界或隐藏代价。
