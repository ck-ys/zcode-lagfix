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
                 └─ store.loadOlder()         → 只观测耗时/失败/行数（v0.3.2，不改返回值）
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

已知宿主事实（v0.3.1 相关）：

- 虚拟单元是**整轮 turn**，不是单行；`ROW_OVERSCAN = 2`，单个超长 turn 可挂载数千 DOM。
- `loadOlder()` 每页 `snapshotTailWindowRows = 60`，单次上限 200 行；它替换 `rows.window` 引用，但不改 `snapshot.seq`。
- `data-projection-seq` 只反映 `snapshot.seq`，**不能用来判断 `loadOlder` 是否发生**。
- `handleScroll` 每次滚动都会调用 `syncMessageLayerMask`，同步写 6 个 mask 样式并读几何；mask 作用于整个消息层。
- `ConversationTimeline` 的 `loadOlder` 触发阈值约为 2 个视口；prepend 锚点在触发时捕获。
- 宿主已有 `content-visibility:auto` 先例（分享只读时间线），但只能加在 turn 内部行级块，不能加在被 virtualizer 测高的 turn wrapper 上。
- 多会话场景下，隐藏 pane 可能仍挂载或已被卸载；`[data-session-id]` 是唯一可靠的分桶键；宿主未分配会话 id 时写 `"draft"`（`sessionId ?? "draft"`），过渡态也可能是空字符串，两者都按占位 sid 处理。`data-projection-seq` 在隐藏 pane 上不一定继续变化，`frames=0` 只代表“没观察到提交”，不代表“不耗资源”。

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
- O3 补页合并、O4 turn 内 `content-visibility` 留到 v0.3.3，按 v0.3.2 数据二选一；O7 多会话策略留到 v0.3.4。

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
- 只记录指标、窗口 id、设置快照、会话 sid 与计数、`loadOlder` 元数据；不记录提示词、回复、文件内容、分页内容、消息 id、工具参数。
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
