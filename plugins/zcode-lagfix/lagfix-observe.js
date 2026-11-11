/**
 * zcode-lagfix renderer 观测脚本 v0.3.5
 *
 * v0.3.5（长帧上下文归因 + 面板期进一步合并）：
 *   - P0 lafCtxOn（默认开，只读）：每条 ≥100ms 长帧记录距上次通知/补发/滚动/
 *     投影提交的毫秒数，并归类 flush/notify/scroll/other；样本带 paneOpen/panelQuiet。
 *   - O5 panelQuietOn（默认关，实验）：面板常开期通知下限 300→400ms、角标
 *     1.8s→3s；面板关闭立即恢复。只改插件侧时序，不碰宿主 DOM/数据。
 *
 * v0.3.4（卡顿归因 + 翻页降频 + 长回合渲染减负）：
 *   - P0 LoAF 归因（lafDiagOn，默认开，只读）：时长 ≥100ms 的长帧记录
 *     最近 10 条（总时长/强制布局占比/脚本 top5），sourceURL 只留文件名。
 *     与 v0.3.1 的 lafCount/lafMax 共用一个 PerformanceObserver。
 *   - O3 翻页降频（loadOlderPaceOn，默认关，实验）：rows.window > 3000 行时
 *     两次 loadOlder 触发至少隔 600ms；被跳过的触发不碰 store，返回已结算
 *     promise，宿主在下次滚动事件自然重试（锚点反而更新）。
 *   - O4 长回合渲染减负（turnContentVisOn，默认关，实验）：data-lagfix-cv
 *     属性 + content-visibility:auto 只作用于 turn 内部行级块
 *     （[data-row-id]，排除 live tail），contain-intrinsic-size:auto 让
 *     已渲染过的块对 virtualizer 测高无扰动。
 *   - 后端全量过滤是宿主侧成本，插件只减少触发次数，不声称降低单次成本。
 *
 * v0.3.3（侧栏开合 / 面板常开期 / 回前台，默认开、可单独关）：
 *   - P0 归因：pane.detected/open/panelPx/switches/switchP95/switchMax/guardHits；
 *     refocus.hiddenMs/sinceVisibleMs/p95/max/flushes/guardHits。只读，不写 store。
 *   - P1 开合 420ms：data-lagfix-pane-switch 停 [data-panel] 过渡、关消息层 mask、
 *     暂停角标定位；把 200ms flex 动画变成一次跳变。
 *   - P2 面板常开期：data-lagfix-pane-open 关消息层 mask；通知窗口至少 300ms；
 *     角标定位最多 1 次/1.8s。
 *   - P3 回前台：visibilitychange + focus/blur；120ms 合并补发后台通知；
 *     700ms 内通知窗口至少 400ms；前 300ms 不定位角标。
 *
 * v0.3.2（多会话归因 + loadOlder 明细，只读）：
 *   - 按 data-session-id 分桶（最多 5 个）：每个会话的投影提交次数/速率、
 *     DOM 节点数、挂载 turn 数、滚动帧 P95、可见性与最近活跃时间；
 *     隐藏 pane 也记录并标 visible=false。不读消息正文，不写 store。
 *   - loadOlder 最近 10 次明细：耗时、promise 是否正常结算、rows.window 长度变化、
 *     触发来源（scroll/initial/unknown）。只包主 store 实例，暂停不累计；
 *     只观测，不改参数/返回值/this。
 *   - 新增 sessionDiagOn 开关；关闭后 sessions=null，不再遍历会话 pane。
 *
 * v0.3.1（O1/O1b/O2/A8/A9）：
 *   - O1 滚动诊断：只统计「最近 200ms 内有滚动」的帧 P95、滚动事件数、
 *     loadOlder 次数/耗时/失败、挂载 turn 数、DOM 峰值、可选 long-animation-frame。
 *     loadOlder 只观测，不拦截、不延迟、不改返回值。
 *   - O1b 输入延迟：keydown（输入框内）到下一帧的间隔，回答「卡顿时按键没反应」。
 *     只测量，不修复。
 *   - O2 滚动期临时关闭消息层 mask：滚动时给 documentElement 加 data-lagfix-scroll，
 *     停滚 180ms 后移除；只覆盖 mask-image，不影响布局与 DOM。
 *   - A8 角标常驻：删除「显示角标」开关，避免用户把自己锁在设置外面。
 *   - A9 面板重排：状态条 / 观测 / 性能 / 维护，行名去掉颜色与内部术语。
 *   - 维护页「检查更新」：点击后由主进程请求一次 GitHub Releases，不自动联网。
 *
 * v0.2.3 UI 改版（交互参照 zusage 状态条）：
 *   - 角标浮在输入框卡片上方（.chat-composer-input-surface），显示判定结论
 *     （极流畅/流畅/正常/轻微/卡/很卡/空闲/卡死）+ 最近 30s 的帧 P95，
 *     末尾是齿轮；只有齿轮进设置，点角标/悬停出统计浮层。
 *   - 配色只看最近 30s 最差帧，不再被"历史上的一次 788ms"永久染红。
 *   - 设置改成居中弹窗 + 左侧分类（状态条/观测/修复/维护）。
 *
 * v0.3.0：
 *   - 角标只在主页面显示：设置页/弹窗/被遮挡/无可用输入框时隐藏，多个 composer 取最靠下的。
 *   - 修复页四项增强（自适应窗口/切会话冷静期/后台降频/大会话保护），全部可逐项关闭；
 *     大会话保护包装 loadAllOlder，分享入口点击或分享弹层出现时自动放行。
 *   - 节流关闭时，依赖它的窗口与前三项在面板里变灰；大会话保护独立生效。
 *   - 修复页每项标题后有「!」，展开影响/不影响说明；维护页显示日志路径与上限。
 *   - 角标可整体隐藏；隐藏后 Ctrl+Alt+L 或 __lagfixSettings() 仍能打开设置。
 *
 * 观测两个不同的量，绝不混为一谈：
 *   1. 投影提交率（commitRate）：[data-session-id] 上 data-projection-seq 变化次数。
 *      它是宿主每秒重渲染 pane 的次数 = 负载指标，数值越高越吃力，但不等于卡。
 *   2. 真实帧间隔（frameP95/frameMax）：requestAnimationFrame 相邻时间戳差值。
 *      这是浏览器真的画出下一帧的间隔，是"用户感不感觉卡"的直接度量。
 *   3. 长任务（longTasks/maxLongTask）：PerformanceObserver('longtask')，
 *      主线程被单次阻塞超过 50ms 的次数与最长值。
 *
 * v0.1.2 修的实测坑（多轮终审）：
 *   - 首帧把「挂载到首个投影」的加载耗时（常见 3-30s）记成帧间隔 → 假阳性。
 *     现在每次（重）挂载后第一次变化只建基线，不计数（primed）。
 *   - ring 跨会话继承 → 新会话带着旧会话的 P95。现在 attach / sid 变化都重置。
 *   - sid 检查被 seq 变化门控 → 同水位切会话漏检。现在先查 sid 再查 seq。
 *   - 锚点取 DOM 最后一个 → 分屏时盯到次要 pane。现在 primary pane 优先，
 *     其次取可见面积最大的 pane。
 *   - disable 后仍每 5s 全量 querySelectorAll('*') → 已禁用还在制造长任务。
 *     现在 collect 立刻返回廉价 dead payload，DOM 计数降频到 60s。
 *   - 单帧最长间隔只在 300 样本窗口内滚动 → 最严重的一次可能被滚掉。
 *     现在额外维护 allTimeMax。
 *
 * 安全约束：单例守卫；观测逻辑纯只读（不碰 store/原型/宿主数据）；注入的
 * 角标/统计/弹窗都挂在 document.body，不改宿主 React 树；所有回调 try/catch；
 * 连续失败自禁用并移除全部注入元素。
 *
 * v0.1.4 新增设置面板（交互参照 zusage 的悬浮状态条：点角标展开面板）：
 *   - 观测开关、角标文字开关、黄/红阈值、采集间隔（5/10/30s）、恢复默认。
 *   - 设置只写 localStorage 的独立键 "lagfix.settings.v1"，绝不碰宿主任何键。
 *   - 采集间隔需要主进程配合，随 __lagfixCollect 的 payload 回传，
 *     由 loader 调整定时器并落盘 settings.json。
 */
(function () {
  if (window.__lagfixObs) return;
  window.__lagfixObs = true;

  var ATTR = "data-projection-seq";
  var SID_ATTR = "data-session-id";
  var ACQUIRE_POLL_MS = 2000;
  var ACQUIRE_RETRY_MS = 30000;     // 找不到锚点时降频重试（不永久放弃）
  var ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;
  var RING_MAX = 300;
  var INPUT_RING_MAX = 3600;        // 30s × 120Hz：高频输入不截断 30s 窗口
  var WINDOW_MS = 30000;            // P95 只看最近 30 秒
  var SCROLL_HOLD_MS = 200;         // 滚动后 200ms 内的帧才算「滚动帧」
  var SCROLL_RING_MAX = 3600;       // 30s × 120Hz：高刷屏也保留完整 30s 窗口
  var SESSION_BUCKET_MAX = 5;       // 按 sid 归因：最多 5 个会话桶
  var SESSION_SCROLL_RING_MAX = 3600;
  var LOAD_OLDER_DETAIL_MAX = 10;   // 最近 10 次 loadOlder 调用
  var LOAD_OLDER_SCROLL_WINDOW_MS = 2000;
  var LOAD_OLDER_INITIAL_WINDOW_MS = 5000;
  var MASK_IDLE_MS = 180;           // 停滚后多久恢复消息层遮罩
  // v0.3.3：侧栏开合 / 面板常开 / 回前台保护
  var PANE_GUARD_MS = 420;          // 200ms flex 过渡 + 220ms 重内容 settle
  var PANE_SWITCH_WINDOW_MS = 800; // 开合后帧窗口
  var PANE_HOLD_FLOOR_MS = 300;    // 面板常开期节流下限
  var PANE_BADGE_MIN_MS = 1800;    // 面板常开期角标定位上限频率
  // v0.3.5 O5：面板期进一步合并（实验，默认关）；取比 P2 更严格的值。
  var PANEL_QUIET_FLOOR_MS = 400;  // 面板期通知下限
  var PANEL_QUIET_BADGE_MS = 3000; // 面板期角标定位上限频率
  // v0.3.5 P0：长帧能被归因到某个信号的最大滞后。
  var LAF_CTX_WINDOW_MS = 1000;
  var REFOCUS_DELAY_MS = 120;      // 回前台合并补发延迟
  var REFOCUS_GUARD_MS = 700;      // 回前台节流下限窗口
  var REFOCUS_BADGE_SKIP_MS = 300; // 回前台前 300ms 不定位角标
  var REFOCUS_WINDOW_MS = 800;     // 回前台帧窗口
  var PANE_SWITCH_DEDUPE_MS = 150; // aria-hidden 与 class 双信号去重
  var REFOCUS_DEDUPE_MS = 500;     // visibilitychange 与 focus 双信号去重
  var VERSION = "0.3.5";
  var ERR_LIMIT = 50;
  var OVERLAY_ID = "lagfix-overlay-badge";
  // 宿主浮层（Radix portal）：上下文容量、模型/工具菜单、对话框等。
  // 这些内容不在 composer dock 子树里，必须单独查，否则角标会盖在面板上。
  var HOST_FLOATING_SEL = '[data-slot="hover-card-content"],[data-slot="popover-content"],'
    + '[data-slot="dropdown-menu-content"],[data-slot="select-content"],'
    + '[data-slot="dialog-content"],[role="dialog"][data-state="open"]';
  var PANEL_ID = "lagfix-settings-panel";
  var SETTINGS_KEY = "lagfix.settings.v1";
  var OVERLAY_TICK_MS = 1000;
  var LONG_TASK_MS = 50;

  var DEFAULTS = {
    observe: true,      // 观测开关
    badgeText: true,    // 角标是否显示文字（关掉只留小圆点）
    badgeMode: "simple",// 角标内容：simple=判定+帧 / detail=提交+帧+长任务+堆
    // v0.3 性能增强（全部可开关）
    adaptiveOn: true,   // 帧变差时自动放大节流窗口
    switchGuardOn: true,// 切会话后 10s 内至少 250ms，避让首屏水合
    hiddenSkipOn: true, // 窗口在后台时最多 1s 通知一次
    bigSessionOn: true, // 超大历史会话不自动补拉全部旧问题
    // v0.3.1 观测与缓解
    scrollDiagOn: true,     // 滚动窗口观测（只读）
    sessionDiagOn: true,    // v0.3.2 多会话归因（只读）
    inputLagOn: true,       // 输入延迟观测（只读）
    maskOffOnScroll: true,  // 滚动期临时关闭消息层 mask
    // v0.3.3 侧栏与回前台（全部可单独关闭）
    paneDiagOn: true,          // 侧栏开合 + 回前台归因（只读）
    paneSwitchGuardOn: true,   // 开合 420ms 过渡/mask/角标保护
    paneHoldOn: true,          // 面板常开期 mask/节流/角标保护
    refocusGuardOn: true,      // 回前台 120ms 合并 + 700ms 保护
    // v0.3.4 卡顿归因 + 两个实验缓解（缓解项默认关，A/B 达标前不进默认路径）
    lafDiagOn: true,           // LoAF 卡顿来源定位（只读）
    loadOlderPaceOn: false,    // O3 大会话翻页降频（实验）
    turnContentVisOn: false,   // O4 turn 内 content-visibility（实验）
    // v0.3.5 P0 归因补强 + O5 面板期进一步合并（默认关，A/B 达标前不进默认路径）
    lafCtxOn: true,            // 长帧上下文归因（只读）
    panelQuietOn: false,       // O5 面板期进一步合并（实验）
    logMaxMB: 50,       // 观测日志总预算（MB），超过自动删最旧
    warnMs: 50,         // 帧 P95 黄阈值
    badMs: 100,         // 帧 P95 红阈值
    collectSec: 5,      // 主进程采集间隔
    throttleOn: true,   // v0.2 修复：投影订阅通知节流
    throttleMs: 120,    // 节流窗口（trailing 必达）
  };

  function clampNum(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  // 把 localStorage 里的对象合并进目标设置（初始加载与跨窗口 storage 事件共用，
  // 避免两处校验规则漂移）。
  function mergeStored(o, s) {
    if (!o || typeof o !== "object") return s;
    if (typeof o.observe === "boolean") s.observe = o.observe;
    if (typeof o.badgeText === "boolean") s.badgeText = o.badgeText;
    if (o.badgeMode === "simple" || o.badgeMode === "detail") s.badgeMode = o.badgeMode;
    if (typeof o.adaptiveOn === "boolean") s.adaptiveOn = o.adaptiveOn;
    if (typeof o.switchGuardOn === "boolean") s.switchGuardOn = o.switchGuardOn;
    if (typeof o.hiddenSkipOn === "boolean") s.hiddenSkipOn = o.hiddenSkipOn;
    if (typeof o.bigSessionOn === "boolean") s.bigSessionOn = o.bigSessionOn;
    // v0.3.1：A8 起 badgeVisible 不再读取（旧值直接被忽略，角标常驻显示）
    if (typeof o.scrollDiagOn === "boolean") s.scrollDiagOn = o.scrollDiagOn;
    if (typeof o.sessionDiagOn === "boolean") s.sessionDiagOn = o.sessionDiagOn;
    if (typeof o.inputLagOn === "boolean") s.inputLagOn = o.inputLagOn;
    if (typeof o.maskOffOnScroll === "boolean") s.maskOffOnScroll = o.maskOffOnScroll;
    // v0.3.3：四项独立开关，只接受布尔值。
    if (typeof o.paneDiagOn === "boolean") s.paneDiagOn = o.paneDiagOn;
    if (typeof o.paneSwitchGuardOn === "boolean") s.paneSwitchGuardOn = o.paneSwitchGuardOn;
    if (typeof o.paneHoldOn === "boolean") s.paneHoldOn = o.paneHoldOn;
    if (typeof o.refocusGuardOn === "boolean") s.refocusGuardOn = o.refocusGuardOn;
    // v0.3.4：三项独立开关，只接受布尔值。
    if (typeof o.lafDiagOn === "boolean") s.lafDiagOn = o.lafDiagOn;
    if (typeof o.loadOlderPaceOn === "boolean") s.loadOlderPaceOn = o.loadOlderPaceOn;
    if (typeof o.turnContentVisOn === "boolean") s.turnContentVisOn = o.turnContentVisOn;
    // v0.3.5：两项独立开关，只接受布尔值。
    if (typeof o.lafCtxOn === "boolean") s.lafCtxOn = o.lafCtxOn;
    if (typeof o.panelQuietOn === "boolean") s.panelQuietOn = o.panelQuietOn;
    if (o.logMaxMB != null) s.logMaxMB = clampNum(o.logMaxMB, 5, 1000, DEFAULTS.logMaxMB);
    if (o.warnMs != null) s.warnMs = clampNum(o.warnMs, 1, 5000, DEFAULTS.warnMs);
    if (o.badMs != null) s.badMs = clampNum(o.badMs, 2, 10000, DEFAULTS.badMs);
    if (o.collectSec != null) s.collectSec = clampNum(o.collectSec, 1, 120, DEFAULTS.collectSec);
    if (typeof o.throttleOn === "boolean") s.throttleOn = o.throttleOn;
    if (o.throttleMs != null) s.throttleMs = clampNum(o.throttleMs, 30, 1000, DEFAULTS.throttleMs);
    return s;
  }

  var settings = (function () {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) mergeStored(JSON.parse(raw), s);
    } catch (e) {}
    if (s.badMs <= s.warnMs) s.badMs = s.warnMs + 1;
    return s;
  })();

  var saveFailed = false;

  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      saveFailed = false;
      return true;
    } catch (e) {
      // 隐私模式/配额满时 setItem 会抛：必须让面板说实话，
      // 否则"设置会记住"是假承诺。
      saveFailed = true;
      return false;
    }
  }

  var state = {
    since: Date.now(),
    el: null,
    sid: "",
    lastSeq: null,
    lastT: 0,
    primed: false,          // 本次挂载后是否已建立基线（首帧不计数）
    frames: 0,              // 自上次 collect 的投影提交次数
    tickFrames: 0,          // 自上次角标刷新的提交次数
    ring: [],               // [{t, ms}] 投影提交间隔
    allTimeMax: 0,          // 本次挂载以来的最大提交间隔
    lastCollectAt: 0,       // 上次 collect 的时间基准（用于算真实 dt）
    lastCommitRate: 0,      // 最近一次角标刷新算出的提交速率（悬停浮层直接用）
    lostSince: 0,
    missed: false,
    missedReason: "",
    errCount: 0,
    dead: false,
    panelOpen: false,
    switchedAt: Date.now(),    // 最近一次挂载/切会话的时间（冷静期用）
    attachedPerfAt: 0,         // 最近一次 attach 的 performance.now()（loadOlder trigger 用）
    lastEffMs: 0,              // 最近一次实际生效的节流窗口（面板展示）
    restartRequested: false,   // 只存内存：随样本回传给主进程，不落盘（防重启死循环）
    updateCheckRequested: false, // 只存内存：随下一个样本回传一次，主进程检查 GitHub Releases
    updateCheckWaiting: false,   // 请求已随样本发出，等主进程注入 __lagfixUpdate
    updateCheckSentAt: 0,        // 发出请求时的本地时间，用于判断结果是否已更新
  };

  // rAF 真实帧间隔
  var frameRing = [];       // [{t, ms}]
  var frameMaxAll = 0;
  var rafLast = 0;

  // 长任务
  var longTaskCount = 0;
  var maxLongTaskMs = 0;

  // ---- v0.3.1：滚动诊断 / 输入延迟 / 遮罩 ----
  // 环形窗口按 30s 时间窗滚动；events/lafCount 按采集周期清零。
  var scrollRing = [];       // [{t, ms}] 滚动后 200ms 内的帧
  var scrollEvents = 0;      // 本周期时间线滚动事件数
  var anyScrollEvents = 0;   // 本周期所有 scroll 事件数（区分「没人滚」与「选择器失配」）
  var lastScrollAt = 0;      // performance.now()
  // v0.3.5 P0：长帧上下文时间戳（0 = 尚未发生）；暂停/关闭/自禁用一律清空。
  var lastNotifyAt = 0;      // 宿主通知进入 subscribe 包装
  var lastFlushAt = 0;       // 插件把合并后的通知真正交给宿主
  var lastCommitAt = 0;      // 活动 pane 的 data-projection-seq 变化
  var lastLafScrollAt = 0;   // P0 专用滚动时间戳（不与滚动诊断共用，互不污染）
  var loadOlderRing = [];    // [{t, ms}]
  var loadOlderCalls = 0;    // 自 observer 启动累计
  var loadOlderErrors = 0;   // 同步抛错 + promise reject
  var loadOlderTarget = null;// 当前被包装的 store 实例（只包主 pane，不碰共享原型）
  var inputRing = [];        // [{t, ms}] keydown → 下一帧
  var inputPendingAt = 0;    // 0 表示没有待处理按键
  // v0.3.2：按 sid 的多会话归因。桶只存在内存，不写宿主 store。
  var sessionBuckets = [];   // [{sid, pane, visible, lastActive, frames, sampleAt, ...}]
  var sessionPanes = [];     // [{pane, bucket}]
  var sessionMO = null;      // 一个 MutationObserver 同时观察多个 pane
  var sessionObservedPanes = []; // sessionMO 当前实际观察的 pane（集合不变就不重挂）
  var loadOlderDetail = [];  // 最近 10 次 loadOlder 调用（只记元数据）
  var detailVersion = 0;     // 每次追加都 +1，防止 t/ms/ok 恰好相同的指纹碰撞
  var lastDetailKey = "";    // 上次随样本发出的明细指纹；未变化时只发 []，避免日志膨胀
  var domPeak = 0;           // 最近 30s 内采样到的最大 DOM 数
  var domPeakAt = 0;         // 峰值窗口起点
  var domProbeAt = 0;        // 上次 domPeak 采样时间（独立于旧 domAt，避免降频后被冻结）
  var domCostMs = 0;         // 最近一次全量计数耗时（>5ms 自动退回 60s 降频）
  var lafCount = 0;          // long-animation-frame 次数（本周期）
  var lafMax = 0;
  var scrollMaskTimer = null;
  var scrollMaskDeadline = 0;
  var lastUpdateAskAt = 0;   // 「检查更新」点击节流
  // 实际上经过我们 wrapper 的通知次数：用来判断"装了但宿主没走这条路"
  // （applied=true 却完全不增长 → 包装无效，只能靠这个看出来）
  var throttleHits = 0;
  var logStatsRow = null;    // 维护页「当前日志量」文本节点（主进程随采集注入字节数）
  var bigBlocked = 0;        // 大会话保护拦下的全量补拉次数
  var bigBlockedMark = 0;    // 本轮保护启用时的拦截计数快照（只有真拦过才在关闭时补拉）
  var loadAllInFlightAt = 0; // 关闭保护后的补拉去重：防止快速关/开/关并发跑两遍
  var bgFlushers = [];       // 后台挂起的通知：回前台合并补发（见 visibilitychange）

  // ---- v0.3.3：侧栏开合 / 面板常开期 / 回前台 ----
  // 这些状态只存在 observer 内存；属性只加在 documentElement 上，不改宿主 React 树。
  var paneFrame = null;          // [data-workspace-side-frame="true"]
  var panePanel = null;          // frame.closest('[data-panel]')
  var paneMO = null;             // 同时观察 frame aria-hidden 与 panel class
  var paneDetected = false;
  var paneOpen = false;
  var paneSwitches = 0;
  var paneGuardHits = 0;
  var paneGuardUntil = 0;        // performance.now()
  var paneGuardTimer = null;
  var paneLastSwitchAt = 0;      // 双信号去重
  var paneLastSignal = "";       // 上一次开合来自 aria-hidden 还是 class
  var paneSwitchRing = [];       // [{t, ms}] 最近一次开合后 800ms
  var paneSwitchWindowUntil = 0;
  var paneLastBadgeAt = 0;       // 面板常开期角标定位频率

  var refocusRing = [];          // [{t, ms}] 最近一次回前台后 800ms
  var refocusWindowUntil = 0;
  var refocusGuardUntil = 0;     // performance.now()
  var refocusBadgeUntil = 0;
  var refocusFlushTimer = null;
  var refocusFlushes = 0;
  var refocusGuardHits = 0;
  var refocusBound = false;
  var visibilityBound = false;
  var lastHiddenAt = 0;
  var hiddenMs = null;
  var sinceVisibleAt = 0;
  var lastBlurAt = 0;
  var lastRefocusAt = 0;

  // ---- v0.3.4：LoAF 归因 + 翻页降频 + content-visibility ----
  var LAF_DETAIL_MAX = 10;    // 最近 10 条 ≥100ms 长帧归因
  var LAF_MIN_DETAIL_MS = 100;
  var lafDetail = [];         // [{t, ms, styleMs, scripts:[{src, invoker, ms}]}]
  var lafDetailKey = "";      // 上次随样本发出的归因指纹；未变化时只发 []
  var lafSupported = false;   // 浏览器是否支持 long-animation-frame 条目
  // v0.3.5 P0：本周期每条 ≥100ms 长帧的来源计数；随采集周期清零。
  var lafCtxCounts = { flush: 0, notify: 0, scroll: 0, other: 0 };

  function resetLafCtx() {
    lastNotifyAt = 0;
    lastFlushAt = 0;
    lastCommitAt = 0;
    lastLafScrollAt = 0;
    lafCtxCounts = { flush: 0, notify: 0, scroll: 0, other: 0 };
  }

  // v0.3.5：关闭来源细分后，环里旧条目也不能再带上下文字段——否则下一次
  // 明细重发会把旧 src 一起发出去，报告出现「已关闭 + 来源=…」自相矛盾。
  function stripLafCtxFromDetail() {
    var changed = false;
    for (var i = 0; i < lafDetail.length; i++) {
      var d = lafDetail[i];
      if (!d || typeof d !== "object") continue;
      if ("src" in d || "sinceNotify" in d || "sinceFlush" in d
        || "sinceScroll" in d || "sinceCommit" in d) {
        delete d.src;
        delete d.sinceNotify;
        delete d.sinceFlush;
        delete d.sinceScroll;
        delete d.sinceCommit;
        changed = true;
      }
    }
    if (changed) lafDetailKey = "";
  }

  // 长帧归因可用的上下文时间戳：父开关/观测/自禁用任一不满足就不更新。
  function lafCtxWanted() {
    return settings.lafDiagOn && settings.lafCtxOn
      && settings.observe && !state.dead;
  }

  // 信号相对长帧的滞后：帧开始前 = start - ts；发生在帧内（含帧首）= 0；
  // 晚于帧结束（不属于这一帧）或未发生 = null。
  // LoAF entry.startTime 是**帧起点**，滚动/通知/补发/提交回调通常发生在帧内，
  // 它们的 performance.now() 晚于 startTime 是正常的同帧因果，不能当成“未来时间”。
  function lafLagOf(ts, start, end) {
    if (!ts) return null;
    if (ts < start) return Math.round(start - ts);
    if (ts <= end) return 0;
    return null;
  }

  // 在 flush/notify/scroll 中取滞后最小的候选；超过窗口或没有候选归 other。
  // 帧内信号（lag=0）按发生时间取更早者：滚动处理里同步触发的通知/补发，
  // 根因仍是滚动；真正由延迟补发触发的帧，lastFlushAt 会晚于 lastNotifyAt。
  // 完全同一毫秒时按 flush → notify → scroll。
  function lafCtxOf(startTime, duration) {
    var start = Number(startTime) || 0;
    var end = start + Math.max(0, Number(duration) || 0);
    var cands = [
      { src: "flush", ts: lastFlushAt },
      { src: "notify", ts: lastNotifyAt },
      { src: "scroll", ts: lastLafScrollAt },
    ];
    var best = "other";
    var bestLag = Infinity;
    var bestTs = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var lag = lafLagOf(cands[i].ts, start, end);
      if (lag === null || lag > LAF_CTX_WINDOW_MS) continue;
      if (lag < bestLag || (lag === bestLag && cands[i].ts < bestTs)) {
        best = cands[i].src;
        bestLag = lag;
        bestTs = cands[i].ts;
      }
    }
    return {
      src: best,
      sinceNotify: lafLagOf(lastNotifyAt, start, end),
      sinceFlush: lafLagOf(lastFlushAt, start, end),
      sinceScroll: lafLagOf(lastLafScrollAt, start, end),
      sinceCommit: lafLagOf(lastCommitAt, start, end),
    };
  }
  // 降频参数是拍板值（docs/specs/v0.3.4-loadolder-dom.md §1.2）：改值必须重新 A/B。
  var PACE_MIN_ROWS = 3000;   // 窗口行数不超过它时完全不计时
  var PACE_INTERVAL_MS = 600; // 大窗口下两次放行的最小间隔
  // 只有「正在派发时间线 scroll 事件」的同步调用才允许降频。不能用「最近 N ms
  // 有滚动」的时间窗：宿主前插锚定后会 scheduleMicrotask 里 dispatchEvent(new
  // Event("scroll")) 补发通知（ConversationTimeline notifyScrollObserversAfterCommit），
  // 那个合成 scroll 会把时间窗刷新，导致随后的 SessionPane 首 turn header 自动补拉
  // 被误判成滚动触发——它用 cursor 去重，跳过就永不重试。
  // 标志在 document capture 阶段置位、微任务里清掉：React 的 onScroll 处理与其
  // 同步调用的 loadOlder 都在这段窗口内，而 effect 里的自动补拉已经出栈。
  var paceInScrollDispatch = false;
  var paceStats = null;       // 当前 loadOlder 包装闭包里的计数（换 store 归零）
  var CV_ATTR = "data-lagfix-cv";

  // v0.3.4 O4：data-lagfix-cv 是 documentElement 上的唯一新增痕迹；所有效果
  // 都由 ensureStyle 里带属性前缀的 CSS 生效。幂等：重复调用只做一次属性读写。
  function syncCvAttr() {
    try {
      var root = document.documentElement;
      if (!root) return;
      var want = settings.turnContentVisOn && settings.observe && !state.dead;
      var cur = root.getAttribute(CV_ATTR) === "1";
      if (want && !cur) root.setAttribute(CV_ATTR, "1");
      else if (!want && cur) root.removeAttribute(CV_ATTR);
    } catch (e) {}
  }

  function paneWatchNeeded() {
    return !state.dead && settings.observe
      && (settings.paneDiagOn || settings.paneSwitchGuardOn || settings.paneHoldOn
        || settings.panelQuietOn);
  }

  function refocusWatchNeeded() {
    return !state.dead && settings.observe
      && (settings.paneDiagOn || settings.refocusGuardOn);
  }

  function readPaneOpen() {
    // 宿主用 aria-hidden={!isVisible}，正常只会是 "true"/"false"。
    // 属性缺失或值异常时按“不知道”处理，宁可不加常开保护，也不永久关闭渐隐/抬节流。
    try { return !!paneFrame && paneFrame.getAttribute("aria-hidden") === "false"; } catch (e) { return false; }
  }

  function applyPaneHoldAttribute() {
    try {
      var root = document.documentElement;
      if (!root) return;
      var want = settings.paneHoldOn && settings.observe && !state.dead && paneDetected && paneOpen;
      var cur = root.getAttribute("data-lagfix-pane-open") === "1";
      if (want && !cur) root.setAttribute("data-lagfix-pane-open", "1");
      else if (!want && cur) root.removeAttribute("data-lagfix-pane-open");
      if (want !== cur) effCache.at = -1e9;
    } catch (e) {}
  }

  function stopPaneGuard() {
    if (paneGuardTimer) { clearTimeout(paneGuardTimer); paneGuardTimer = null; }
    paneGuardUntil = 0;
    try {
      var root = document.documentElement;
      if (root) root.removeAttribute("data-lagfix-pane-switch");
    } catch (e) {}
  }

  function startPaneGuard(now) {
    paneGuardHits++;
    paneGuardUntil = now + PANE_GUARD_MS;
    try {
      var root = document.documentElement;
      if (root) root.setAttribute("data-lagfix-pane-switch", "1");
    } catch (e) {}
    if (paneGuardTimer) { clearTimeout(paneGuardTimer); paneGuardTimer = null; }
    paneGuardTimer = setTimeout(function () {
      paneGuardTimer = null;
      paneGuardUntil = 0;
      try {
        var el = document.documentElement;
        if (el) el.removeAttribute("data-lagfix-pane-switch");
      } catch (e) {}
      effCache.at = -1e9;
    }, PANE_GUARD_MS);
  }

  function onPaneSwitch(source) {
    var now = performance.now();
    // 同一次开合会同时改 aria-hidden 和 panel class：150ms 内只认一个来源。
    // 同来源再次出现视为用户又开合了一次（快速连点也算），保护窗口重新计时。
    if (now - paneLastSwitchAt < PANE_SWITCH_DEDUPE_MS
      && paneLastSignal && source && paneLastSignal !== source) {
      applyPaneHoldAttribute();
      return;
    }
    paneLastSwitchAt = now;
    if (source) paneLastSignal = source;
    // 新一次开合：允许保护结束后立即定位一次，不用等上一轮的 1.8s 配额。
    paneLastBadgeAt = 0;
    if (settings.paneDiagOn) {
      paneSwitches++;
      paneSwitchRing.length = 0;
      paneSwitchWindowUntil = now + PANE_SWITCH_WINDOW_MS;
    }
    if (settings.paneSwitchGuardOn && !state.dead) startPaneGuard(now);
    applyPaneHoldAttribute();
    effCache.at = -1e9;
  }

  function onPaneMutation(records) {
    try {
      if (!paneFrame) return;
      var sawAria = false;
      var sawClass = false;
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.target === paneFrame && rec.attributeName === "aria-hidden") {
          var open = readPaneOpen();
          if (open !== paneOpen) { paneOpen = open; sawAria = true; }
        } else if (panePanel && rec.target === panePanel && rec.attributeName === "class") {
          var cls = panePanel.getAttribute("class") || "";
          var old = rec.oldValue || "";
          // 宿主只在显式展开/收起时加 transition-[flex-grow]；拖拽改宽不加。
          if (cls.indexOf("transition-[flex-grow]") >= 0
            && old.indexOf("transition-[flex-grow]") < 0) {
            var open2 = readPaneOpen();
            if (open2 !== paneOpen) paneOpen = open2;
            sawClass = true;
          }
        }
      }
      if (sawAria || sawClass) onPaneSwitch(sawAria ? "aria" : "class");
      else applyPaneHoldAttribute();
    } catch (e) { err(); }
  }

  function releasePaneProbe() {
    try { if (paneMO) paneMO.disconnect(); } catch (e) {}
    paneFrame = null;
    panePanel = null;
    paneDetected = false;
    paneOpen = false;
    stopPaneGuard();
    applyPaneHoldAttribute();
  }

  function resetPaneDiagnostics() {
    paneSwitches = 0;
    paneGuardHits = 0;
    paneSwitchRing.length = 0;
    paneSwitchWindowUntil = 0;
    paneLastSwitchAt = 0;
    paneLastSignal = "";
  }

  function resetRefocusDiagnostics() {
    // 只清“输出计数”，不动 P3 仍需要的 lastHiddenAt/lastBlurAt/保护截止时间。
    refocusRing.length = 0;
    refocusWindowUntil = 0;
    refocusFlushes = 0;
    refocusGuardHits = 0;
    hiddenMs = null;
    sinceVisibleAt = 0;
  }

  function resetRefocusRuntime() {
    resetRefocusDiagnostics();
    refocusGuardUntil = 0;
    refocusBadgeUntil = 0;
    lastHiddenAt = 0;
    lastBlurAt = 0;
    lastRefocusAt = 0;
    if (refocusFlushTimer) { clearTimeout(refocusFlushTimer); refocusFlushTimer = null; }
  }

  function syncPaneProbe() {
    if (!paneWatchNeeded()) { releasePaneProbe(); return; }
    var frame = null;
    try { frame = document.querySelector('[data-workspace-side-frame="true"]'); } catch (e) {}
    if (!frame || frame.isConnected === false) {
      var had = paneDetected;
      if (paneFrame) releasePaneProbe();
      else applyPaneHoldAttribute();
      paneDetected = false;
      paneOpen = false;
      if (had) resetPaneDiagnostics();
      return;
    }
    var panel = null;
    try { panel = frame.closest ? frame.closest('[data-panel]') : null; } catch (e) {}
    if (frame !== paneFrame || panel !== panePanel) {
      paneFrame = frame;
      panePanel = panel;
      paneDetected = true;
      if (!paneMO && typeof MutationObserver === "function") {
        paneMO = new MutationObserver(onPaneMutation);
      }
      try { if (paneMO) paneMO.disconnect(); } catch (e) {}
      try {
        if (paneMO) paneMO.observe(frame, {
          attributes: true, attributeFilter: ["aria-hidden"], attributeOldValue: true,
        });
      } catch (e) {}
      try {
        if (paneMO && panel) paneMO.observe(panel, {
          attributes: true, attributeFilter: ["class"], attributeOldValue: true,
        });
      } catch (e) {}
      paneOpen = readPaneOpen();
      paneLastSwitchAt = 0;
    }
    applyPaneHoldAttribute();
  }

  function flushBackgroundNow() {
    var list = bgFlushers.slice();
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      try { if (list[i]() === true) n++; } catch (e) {}
    }
    if (settings.paneDiagOn) refocusFlushes = n;
    return n;
  }

  function onRefocus(source, now) {
    try {
      if (state.dead || !settings.observe) return;
      now = now || performance.now();
      // 500ms 内重复到达的 visible/focus 只算一次事件；但补发不能因此丢掉。
      var fresh = !(now - lastRefocusAt < REFOCUS_DEDUPE_MS);
      if (fresh) {
        lastRefocusAt = now;
        sinceVisibleAt = now;
        if (settings.paneDiagOn) {
          refocusRing.length = 0;
          refocusWindowUntil = now + REFOCUS_WINDOW_MS;
        }
        if (settings.refocusGuardOn) {
          if (settings.paneDiagOn) refocusGuardHits++;
          refocusGuardUntil = now + REFOCUS_GUARD_MS;
          refocusBadgeUntil = now + REFOCUS_BADGE_SKIP_MS;
        }
        effCache.at = -1e9;
      }
      if (settings.refocusGuardOn) {
        // 不再在 visibilitychange 里同步遍历所有 flusher：先让窗口完成恢复/首帧，
        // 120ms 后把所有 pending 合并到同一任务里补发一次。
        if (!refocusFlushTimer) {
          refocusFlushTimer = setTimeout(function () {
            refocusFlushTimer = null;
            flushBackgroundNow();
          }, REFOCUS_DELAY_MS);
        }
      } else {
        flushBackgroundNow();
      }
    } catch (e) { err(); }
  }

  function onVisibilityChange() {
    try {
      if (document.hidden) {
        // 后台 rAF 基本不跑；不清掉会把整段后台时长记成一次按键延迟。
        inputPendingAt = 0;
        rafLast = 0;
        if (settings.paneDiagOn) lastHiddenAt = performance.now();
        return;
      }
      var now = performance.now();
      rafLast = 0;
      // 后台 overlay 定时器会被降到 1/min；回前台的第一个 tick 不能拿几十秒的
      // dt 去算 stallMs，否则角标会闪一下"卡死"。
      lastTickAt = 0;
      if (settings.paneDiagOn && lastHiddenAt) {
        hiddenMs = Math.max(0, Math.round(now - lastHiddenAt));
      }
      lastHiddenAt = 0;
      if (settings.paneDiagOn || settings.refocusGuardOn) {
        onRefocus("visible", now);
      } else {
        // v0.3.2 基线：两个新开关都关掉时，回前台仍然立即补发挂起通知。
        flushBackgroundNow();
      }
    } catch (e) { err(); }
  }

  function onWindowBlur() {
    try { lastBlurAt = performance.now(); } catch (e) {}
  }

  function onWindowFocus() {
    try {
      if (document.hidden) return;
      if (!lastBlurAt) return;   // 首次加载的 focus 没有前置 blur
      var now = performance.now();
      var gap = Math.max(0, Math.round(now - lastBlurAt));
      lastBlurAt = 0;
      // 可见但失焦的 Alt-Tab：用失焦时长补 hiddenMs，避免报告沿用上一次最小化的旧值。
      if (settings.paneDiagOn && gap > 0) hiddenMs = gap;
      onRefocus("focus", now);
    } catch (e) { err(); }
  }

  function setVisibilityListener(on) {
    try {
      if (on && !visibilityBound) {
        visibilityBound = true;
        document.addEventListener("visibilitychange", onVisibilityChange);
      } else if (!on && visibilityBound) {
        visibilityBound = false;
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    } catch (e) {}
  }

  function setFocusListeners(on) {
    try {
      if (on && !refocusBound) {
        refocusBound = true;
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("focus", onWindowFocus);
      } else if (!on && refocusBound) {
        refocusBound = false;
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
      }
    } catch (e) {}
  }

  function setRefocusListeners() {
    // visibilitychange 是 v0.3.2 的基线：只要观测在跑就保留，负责重置 rAF 基线
    // 和回前台补发。P3 只额外挂 blur/focus 并接管补发时机。
    setVisibilityListener(!state.dead && settings.observe);
    setFocusListeners(refocusWatchNeeded());
    if (state.dead || !settings.observe || !settings.refocusGuardOn) {
      if (refocusFlushTimer) { clearTimeout(refocusFlushTimer); refocusFlushTimer = null; }
    }
  }

  function applyPaneSettings() {
    if (!settings.observe || state.dead) {
      resetPaneDiagnostics();
      resetRefocusRuntime();
    } else if (!settings.paneDiagOn) {
      resetPaneDiagnostics();
      resetRefocusDiagnostics();
    }
    if (!settings.paneSwitchGuardOn) stopPaneGuard();
    if (!settings.paneHoldOn) applyPaneHoldAttribute();
    if (!settings.refocusGuardOn) {
      refocusGuardHits = 0;
      refocusGuardUntil = 0;
      refocusBadgeUntil = 0;
      if (refocusFlushTimer) { clearTimeout(refocusFlushTimer); refocusFlushTimer = null; }
    }
    if (paneWatchNeeded()) syncPaneProbe();
    else releasePaneProbe();
    applyPaneHoldAttribute();
    setRefocusListeners();
    effCache.at = -1e9;
  }

  function paneSnapshot(now) {
    if (!settings.paneDiagOn || state.dead) return null;
    var px = null;
    if (paneDetected && paneFrame) {
      try {
        var r = paneFrame.getBoundingClientRect();
        if (r && isFinite(r.width)) px = Math.round(r.width);
      } catch (e) {}
    }
    var vals = [];
    for (var i = 0; i < paneSwitchRing.length; i++) vals.push(paneSwitchRing[i].ms);
    return {
      detected: paneDetected,
      open: paneDetected ? paneOpen : false,
      panelPx: paneDetected ? px : null,
      switches: paneSwitches,
      switchP95: pctOf(vals, 0.95),
      switchMax: vals.length ? Math.max.apply(null, vals) : null,
      guardHits: paneGuardHits,
    };
  }

  function refocusSnapshot(now) {
    if (!settings.paneDiagOn || state.dead) return null;
    var vals = [];
    for (var i = 0; i < refocusRing.length; i++) vals.push(refocusRing[i].ms);
    return {
      hiddenMs: hiddenMs,
      sinceVisibleMs: sinceVisibleAt ? Math.round(now - sinceVisibleAt) : null,
      p95: pctOf(vals, 0.95),
      max: vals.length ? Math.max.apply(null, vals) : null,
      flushes: refocusFlushes,
      guardHits: refocusGuardHits,
    };
  }

  setRefocusListeners();

  // DOM 计数（降频）
  var domCount = null;
  var domAt = 0;

  var mo = null;
  var acquireTimer = null;
  var watchdogTimer = null;
  var slowRetryTimer = null;   // 找不到锚点时的慢速重试句柄（暂停观测/自禁用要能清掉）
  var overlayTimer = null;
  var rafRunning = false;
  // v0.2 节流状态（这里声明：attach() 可能在首轮轮询就用到）
  var fixState = { applied: false, target: null, orig: null, reason: "", retryTimer: null, tries: 0,
    loadTarget: null, loadOrig: null, blockedStore: null, resumeTimer: null };

  function err() {
    if (++state.errCount >= ERR_LIMIT) disable("too-many-errors");
  }

  function disable(reason) {
    if (state.dead) return;
    state.dead = true;
    state.missed = true;
    state.missedReason = reason || "unknown";
    // 自禁用必须把宿主还原：不能留下一个半生效的包装。
    // 已经发出去的订阅 wrapper 每次回调都会读 settings.throttleOn，
    // 所以这里必须把它置 false（只在内存里，不落盘，下次启动仍尊重用户选择），
    // 否则"已禁用"的观测器还在偷偷节流宿主。
    settings.throttleOn = false;
    try { releaseThrottle(); } catch (e) {}
    try { releaseLoadAllGuard(); } catch (e) {}
    // v0.3.1：自禁用时必须把滚动观测/遮罩一起收干净，不能留半个包装或属性。
    try { releaseLoadOlderProbe(); } catch (e) {}
    try { releaseSessionProbe(); } catch (e) {}
    // v0.3.3：自禁用不能留下侧栏/回前台属性、观察器或监听。
    try { releasePaneProbe(); } catch (e) {}
    try { setRefocusListeners(); } catch (e) {}
    resetPaneDiagnostics();
    resetRefocusRuntime();
    try { setScrollMaskActive(false); } catch (e) {}
    try { if (lafObserver) lafObserver.disconnect(); } catch (e) {}
    try { setScrollListener(false); } catch (e) {}
    try { setPageUnloadListener(false); } catch (e) {}
    try { setInputListener(false); } catch (e) {}
    try { stopRaf(); } catch (e) {}
    try { inputPendingAt = 0; } catch (e) {}
    // 自禁用后不再有下一次 collect，环形窗口与周期计数一并清掉。
    scrollRing.length = 0;
    loadOlderRing.length = 0;
    loadOlderDetail.length = 0;
    lastDetailKey = "";
    // v0.3.4：归因环与 CV 属性同样不留痕（state.dead 已置位，syncCvAttr 会移除属性）。
    lafDetail.length = 0;
    lafDetailKey = "";
    paceInScrollDispatch = false;
    try { syncCvAttr(); } catch (e) {}
    inputRing.length = 0;
    scrollEvents = 0;
    anyScrollEvents = 0;
    loadOlderCalls = 0;
    loadOlderErrors = 0;
    lafCount = 0;
    lafMax = 0;
    lastScrollAt = 0;
    resetLafCtx();
    domPeak = 0;
    domPeakAt = 0;
    domProbeAt = 0;
    domCostMs = 0;
    fixState.reason = "已自禁用";
    try { if (mo) mo.disconnect(); } catch (e) {}
    try { if (acquireTimer) clearInterval(acquireTimer); } catch (e) {}
    try { if (watchdogTimer) clearInterval(watchdogTimer); } catch (e) {}
    try { if (overlayTimer) clearInterval(overlayTimer); } catch (e) {}
    try { if (slowRetryTimer) { clearTimeout(slowRetryTimer); slowRetryTimer = null; } } catch (e) {}
    // 自禁用后不再保留任何观测/浮层资源：长任务观察器、composer 的
    // ResizeObserver、悬停定时器、后台补发队列都要断开，避免继续回调和持有 DOM。
    try { if (ltObserver) ltObserver.disconnect(); } catch (e) {}
    try { if (surfaceRO) surfaceRO.disconnect(); } catch (e) {}
    surfaceRO = null;
    try { if (statsShowTimer) clearTimeout(statsShowTimer); } catch (e) {}
    try { if (statsHideTimer) clearTimeout(statsHideTimer); } catch (e) {}
    bgFlushers.length = 0;
    state.panelOpen = false;
    uiBound = false;
    // 面板若正好开着，Esc/遮罩的 document 监听也要摘掉（原先只在关闭面板时移除）。
    try { document.removeEventListener("keydown", onKeydown, true); } catch (e) {}
    try { document.removeEventListener("mousedown", onDocDown, true); } catch (e) {}
    try { removeOverlay(); } catch (e) {}
  }

  function resetWindow() {
    state.ring.length = 0;
    state.frames = 0;
    state.tickFrames = 0;
    state.allTimeMax = 0;
    state.primed = false;
    // 帧环按窗口滚动，但切会话后旧会话的"最差一帧"不该继续染红新会话的角标。
    // （注释一直写着 attach/sid 变化会重置，这里补齐实际清理。）
    try { frameRing.length = 0; frameMaxAll = 0; } catch (e) {}
    // v0.3.5：lastCommitAt 跟随活动 pane；attach/切会话后不能把旧 pane 的提交
    // 当成本会话长帧的上下文（通知/滚动时间戳是窗口级，保留）。
    lastCommitAt = 0;
  }

  function windowValues(ring, now) {
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      if (now - ring[i].t <= WINDOW_MS) out.push(ring[i].ms);
    }
    return out;
  }

  function pctOf(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var idx = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
    return s[idx];
  }

  function commitStats() {
    var now = performance.now();
    var vals = windowValues(state.ring, now);
    return { p50: pctOf(vals, 0.5), p95: pctOf(vals, 0.95), n: vals.length };
  }

  function frameStats() {
    var now = performance.now();
    var vals = windowValues(frameRing, now);
    return { p50: pctOf(vals, 0.5), p95: pctOf(vals, 0.95), n: vals.length };
  }

  // ---- rAF 采样：真实绘制帧间隔 ----
  // generation 防止「隐藏窗口 + 关/开观测」留下两条自续链：旧回调被挂起后
  // 恢复可见时仍会执行，若只看 rafRunning 布尔值就会和新链并存。
  var rafGen = 0;

  function scheduleRafTick(gen) {
    requestAnimationFrame(function (t) {
      if (gen !== rafGen) return;   // 已被暂停/重开取代的旧链
      rafTick(t);
    });
  }

  function startRaf() {
    if (rafRunning || state.dead || !settings.observe) return;
    rafRunning = true;
    rafGen++;
    scheduleRafTick(rafGen);
  }

  function stopRaf() {
    rafRunning = false;
    rafGen++;
  }

  function rafTick(t) {
    if (state.dead || !settings.observe) { stopRaf(); return; }
    try {
      if (!document.hidden) {
        if (rafLast) {
          var d = t - rafLast;
          if (d > 0 && d < 60000) {
            frameRing.push({ t: t, ms: Math.round(d) });
            if (frameRing.length > RING_MAX) frameRing.shift();
            if (d > frameMaxAll) frameMaxAll = Math.round(d);
            // v0.3.1：只把「滚动后 200ms 内」的帧计入 scrollRing。
            // 全部帧都算会被空闲帧稀释，看不出滚动到底有多卡。
            if (settings.scrollDiagOn && lastScrollAt && t - lastScrollAt <= SCROLL_HOLD_MS) {
              scrollRing.push({ t: t, ms: Math.round(d) });
              if (scrollRing.length > SCROLL_RING_MAX) scrollRing.shift();
            }
            // v0.3.2：按会话记录滚动帧；每个桶只看自己的 lastScrollAt。
            if (settings.sessionDiagOn && settings.observe) {
              for (var si = 0; si < sessionBuckets.length; si++) {
                var sb = sessionBuckets[si];
                if (sb.lastScrollAt && t - sb.lastScrollAt <= SCROLL_HOLD_MS) {
                  sb.scrollRing.push({ t: t, ms: Math.round(d) });
                  if (sb.scrollRing.length > SESSION_SCROLL_RING_MAX) sb.scrollRing.shift();
                }
              }
            }
            // v0.3.3：开合/回前台后的 800ms 帧窗口。窗口内只记帧间隔，
            // 不改变任何宿主行为；下一次开合/回前台会清空重开。
            if (settings.paneDiagOn && paneSwitchWindowUntil && t <= paneSwitchWindowUntil) {
              paneSwitchRing.push({ t: t, ms: Math.round(d) });
              if (paneSwitchRing.length > 240) paneSwitchRing.shift();
            }
            if (settings.paneDiagOn && refocusWindowUntil && t <= refocusWindowUntil) {
              refocusRing.push({ t: t, ms: Math.round(d) });
              if (refocusRing.length > 240) refocusRing.shift();
            }
          }
        }
        rafLast = t;
        // 输入延迟：按键后第一帧就是「界面能响应」的时刻；d=0 也算有效样本，
        // 所以不受上面 d>0 门控影响。超过 60s 的待处理按键按无效丢弃
        // （启动期/页面冻结不应污染 max）。
        if (settings.inputLagOn && inputPendingAt) {
          var lag = Math.round(t - inputPendingAt);
          if (lag >= 0 && lag < 60000) {
            inputRing.push({ t: t, ms: lag });
            if (inputRing.length > INPUT_RING_MAX) inputRing.shift();
          }
          inputPendingAt = 0;
        }
      } else {
        rafLast = 0;  // 后台窗口不采样，回来时重新建基线
        inputPendingAt = 0;  // 后台不采样，避免把整段后台时长记成一次按键延迟
      }
    } catch (e) { err(); }
    if (!state.dead && settings.observe) scheduleRafTick(rafGen);
    else stopRaf();
  }
  // 后台期间 rAF 通常整段挂起，rafLast 停在进入后台前；onVisibilityChange
  // 会在 hidden/visible 两边都归零，避免把整段后台时长记成一帧。

  // ---- 长任务：主线程被单次阻塞 ----
  try {
    if (typeof PerformanceObserver === "function") {
      var ltObserver = new PerformanceObserver(function (list) {
        try {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            longTaskCount++;
            if (entries[i].duration > maxLongTaskMs) {
              maxLongTaskMs = Math.round(entries[i].duration);
            }
          }
        } catch (e) { err(); }
      });
      ltObserver.observe({ entryTypes: ["longtask"] });
    }
  } catch (e) { /* 浏览器不支持就静默跳过，不致命 */ }

  // ---- v0.3.1：long-animation-frame（可选，不支持就静默跳过）----
  // v0.3.4：lafCount/lafMax 口径不变（随 scrollDiagOn）；lafDiagOn 额外把
  // ≥100ms 的长帧归因（脚本归属）记进 lafDetail 环，只留文件名，不记路径。
  var lafObserver = null;
  // 开关关闭/观测暂停/自禁用/一键还原时都要断开：PerformanceObserver 是常驻
  // 全局观察器，不能只把输出字段置 null 却在后台继续吃 entry。
  function setLafObserving(on) {
    if (!lafObserver) return;
    try {
      if (on) lafObserver.observe({ type: "long-animation-frame", buffered: false });
      else lafObserver.disconnect();
    } catch (e) {}
  }
  function lafWatchNeeded() {
    return !state.dead && settings.observe
      && (settings.scrollDiagOn || settings.lafDiagOn);
  }
  // sourceURL 只留最后一段文件名（去查询串）：生产构建是 app.js 这类短名，
  // 不含用户路径，也不该把开发者机器的绝对路径写进日志。
  function lafBaseName(url) {
    try {
      var s = String(url || "").split("?")[0].split("#")[0];
      // data:/blob: 不是文件路径，整段塞进日志既无意义又浪费预算。
      if (/^(data|blob):/i.test(s)) return "";
      // 同时认 Windows 反斜杠路径，并硬截 64 字符：src 也要有长度上限。
      var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      return (i >= 0 ? s.slice(i + 1) : s).slice(0, 64);
    } catch (e) { return ""; }
  }
  function recordLafDetail(entry) {
    var scripts = [];
    // forcedStyleAndLayoutDuration 在**脚本条目**上（PerformanceScriptTiming），
    // 帧对象（PerformanceLongAnimationFrameTiming）没有这个属性——读帧级会恒为 0。
    // 这里对所有脚本求和（截断 top5 之前），得到该帧的强制布局/样式总时长。
    var forcedMs = 0;
    try {
      var src = entry.scripts;
      if (src && src.length) {
        for (var i = 0; i < src.length; i++) {
          var sc = src[i];
          if (!sc || typeof sc !== "object") continue;
          forcedMs += Number(sc.forcedStyleAndLayoutDuration) || 0;
          scripts.push({
            src: lafBaseName(sc.sourceURL),
            invoker: String(sc.invoker || "").slice(0, 120),
            ms: Math.round(sc.duration || 0),
          });
        }
        // 按耗时降序取前 5：归因只关心最贵的脚本。
        scripts.sort(function (a, b) { return b.ms - a.ms; });
        if (scripts.length > 5) scripts.length = 5;
      }
    } catch (e) { scripts = []; }
    var rec = {
      t: Date.now(),
      ms: Math.round(entry.duration || 0),
      styleMs: Math.round(forcedMs),
      scripts: scripts,
    };
    // v0.3.5 P0：上下文只在开关开着时记录（关掉后明细不带这些键，旧消费端不受影响）。
    if (settings.lafCtxOn) {
      var ctx = lafCtxOf(entry.startTime, entry.duration);
      rec.src = ctx.src;
      rec.sinceNotify = ctx.sinceNotify;
      rec.sinceFlush = ctx.sinceFlush;
      rec.sinceScroll = ctx.sinceScroll;
      rec.sinceCommit = ctx.sinceCommit;
      lafCtxCounts[ctx.src]++;
    }
    lafDetail.push(rec);
    if (lafDetail.length > LAF_DETAIL_MAX) lafDetail.shift();
  }
  try {
    if (typeof PerformanceObserver === "function") {
      lafObserver = new PerformanceObserver(function (list) {
        try {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var ms = Math.round(e.duration || 0);
            // 计数随滚动诊断或卡顿归因任一（归因段要显示「本周期长帧 N 次」，
            // 只开归因、关滚动诊断时不能一路 0）；归因环只随 lafDiagOn。
            if ((settings.scrollDiagOn || settings.lafDiagOn)
              && settings.observe && !state.dead) {
              lafCount++;
              if (ms > lafMax) lafMax = ms;
            }
            if (settings.lafDiagOn && settings.observe && !state.dead
              && ms >= LAF_MIN_DETAIL_MS) {
              recordLafDetail(e);
            }
          }
        } catch (e2) { /* 观测失败不能影响宿主 */ }
      });
      // 用 type 形式：浏览器不支持该 entry 类型时会抛，由外层 catch 吞掉。
      setLafObserving(lafWatchNeeded());
      // 一次性支持探测：creation 时两个诊断开关可能都关着（此时不会 observe），
      // 但样本仍要如实报告 supported，不能把「还没开」写成「不支持」。
      try {
        var probe = new PerformanceObserver(function () {});
        probe.observe({ type: "long-animation-frame", buffered: false });
        probe.disconnect();
        lafSupported = true;
      } catch (e3) { lafSupported = false; }
    }
  } catch (e) { lafObserver = null; }

  // ---- v0.3.1 滚动：观测 + 滚动期临时关闭消息层 mask ----
  // 只认时间线滚动容器的 scroll 事件。capture 阶段必须开：scroll 不冒泡，
  // 但 capture 会经过 document，能收到所有后代的 scroll。
  function setScrollMaskActive(active) {
    try {
      var root = document.documentElement;
      if (!root) return;
      if (active && settings.maskOffOnScroll && !state.dead) {
        // 只在第一次滚动时写属性；后续 scroll 只刷新 deadline，避免热路径反复
        // 触发同值属性写入。属性被宿主/别的脚本删掉时会重新补上。
        if (root.getAttribute("data-lagfix-scroll") !== "1") {
          root.setAttribute("data-lagfix-scroll", "1");
        }
        // 用 deadline + 单定时器自重排：滚动事件每秒可达 60 次，
        // 每个事件都 clearTimeout+setTimeout 会白白制造 60 次/秒的定时器抖动。
        scrollMaskDeadline = performance.now() + MASK_IDLE_MS;
        if (!scrollMaskTimer) scrollMaskTimer = setTimeout(checkScrollMaskIdle, MASK_IDLE_MS);
      } else {
        if (scrollMaskTimer) { clearTimeout(scrollMaskTimer); scrollMaskTimer = null; }
        scrollMaskDeadline = 0;
        root.removeAttribute("data-lagfix-scroll");
      }
    } catch (e) {}
  }

  function checkScrollMaskIdle() {
    scrollMaskTimer = null;
    try {
      var left = scrollMaskDeadline - performance.now();
      if (left > 0 && !state.dead && settings.maskOffOnScroll) {
        scrollMaskTimer = setTimeout(checkScrollMaskIdle, Math.ceil(left));
        return;
      }
      scrollMaskDeadline = 0;
      var root = document.documentElement;
      if (root) root.removeAttribute("data-lagfix-scroll");
    } catch (e) {}
  }

  function onTimelineScroll(ev) {
    try {
      if (state.dead) return;
      if (!settings.scrollDiagOn && !settings.maskOffOnScroll
        && !(settings.sessionDiagOn && settings.observe)
        && !settings.loadOlderPaceOn
        && !(settings.lafDiagOn && settings.lafCtxOn && settings.observe)) return;
      var el = ev && ev.target;
      // 滚动事件的 target 就是滚动容器本身，不向上 closest()；target 没有
      // matches（合成事件/测试 stub）时直接放行，不能因此报错。
      // Document 本身没有 matches：宿主若把滚动改到 document，仍要计入 anyEvents。
      if (!el) return;
      var countDiag = settings.scrollDiagOn && settings.observe;
      var isDoc = el === document;
      if (!isDoc && typeof el.matches !== "function") return;
      if (isDoc || !el.matches('[data-v4-timeline-scroll="true"]')) {
        // 非时间线的滚动也计数：用来区分「没人滚」与「选择器失配」（宿主改版）。
        // 只认会话 pane 内或 document 级目标：宿主设置页等区域滚动不算信号，
        // 本插件自己的面板/浮层同样排除，避免伪造 mismatch。
        if (countDiag && !isOwnUiScroll(el) && isSessionScrollTarget(el)) anyScrollEvents++;
        return;
      }
      // v0.3.4：降频判定用的「在 scroll 派发栈内」标记——只开降频、关诊断时也要记。
      if (settings.loadOlderPaceOn) {
        paceInScrollDispatch = true;
        // 微任务在整次 dispatch（含宿主同步的 handleScroll → loadOlder）之后执行，
        // 到宿主 effect 里的自动补拉时已出栈，不会被判成滚动触发。
        Promise.resolve().then(function () { paceInScrollDispatch = false; });
      }
      if (countDiag) {
        lastScrollAt = performance.now();
        scrollEvents++;
        anyScrollEvents++;
      }
      // v0.3.5 P0：独立时间戳，关掉滚动诊断也不影响上下文归因。
      if (lafCtxWanted()) lastLafScrollAt = performance.now();
      if (settings.maskOffOnScroll) setScrollMaskActive(true);
      // v0.3.2：按 pane 记录滚动活动；找不到 pane 时归到当前主会话。
      if (settings.sessionDiagOn && settings.observe) {
        var pane = null;
        try { if (el.closest) pane = el.closest("[data-session-id]"); } catch (e) {}
        if (!pane && state.el && state.el.contains && state.el.contains(el)) pane = state.el;
        var sid = pane ? (pane.getAttribute(SID_ATTR) || "") : state.sid;
        var sb = ensureSessionBucket(sid, pane, true);
        if (sb) {
          sb.lastScrollAt = performance.now();
          sb.lastActive = Date.now();
        }
      }
    } catch (e) {}
  }

  function isOwnUiScroll(el) {
    try {
      if (el === document || el === document.documentElement || el === document.body) {
        return false;   // document 级滚动可能就是宿主改版，照常计数
      }
      if (typeof el.closest !== "function") return true;
      return !!(el.closest("#" + PANEL_ID) || el.closest("#" + STATS_ID));
    } catch (e) { return true; }
  }

  // 非时间线滚动的归属判定：只有会话 pane 子树或 document 级目标才算「宿主改版信号」。
  // 宿主设置页、侧栏等区域的滚动不进入 anyScrollEvents，否则 mismatch 会误报。
  function isSessionScrollTarget(el) {
    try {
      if (el === document || el === document.documentElement || el === document.body) return true;
      if (typeof el.closest !== "function") return false;
      return !!el.closest("[data-session-id]");
    } catch (e) { return false; }
  }

  // 监听器按开关装卸：__lagfixOff / 暂停 / 自禁用时真正移除，重新开启时再挂。
  // addEventListener 对同一函数+capture 是幂等的，重复调用不会叠加。
  function setScrollListener(on) {
    try {
      if (on) document.addEventListener("scroll", onTimelineScroll, true);
      else document.removeEventListener("scroll", onTimelineScroll, true);
    } catch (e) {}
  }

  // v0.3.2：只要滚动诊断、遮罩抑制或多会话归因任一需要，就保留 scroll 监听。
  function scrollWatchNeeded() {
    return !state.dead && (settings.scrollDiagOn || settings.maskOffOnScroll
      || (settings.sessionDiagOn && settings.observe)
      || settings.loadOlderPaceOn
      // v0.3.5 P0：长帧上下文需要滚动时间戳，即使滚动诊断关着。
      || (settings.lafDiagOn && settings.lafCtxOn && settings.observe));
  }

  // ---- v0.3.1 输入延迟：只采输入框内的按键，一次 closest，不拦截事件 ----
  function onComposerKeydown(ev) {
    try {
      if (state.dead || !settings.inputLagOn || !settings.observe) return;
      // 采样循环还没启动（尚未 attach 到会话）时不记按键：
      // 否则第一帧会把「启动等待时间」记成一次输入延迟，污染 30s 窗口的 max。
      if (!rafRunning) return;
      if (inputPendingAt) return;   // 连按时只记第一个待处理按键（最坏等待）
      var t = ev && ev.target;
      if (!t || typeof t.closest !== "function") return;
      if (!t.closest(".chat-composer-input-surface")) return;
      inputPendingAt = performance.now();
    } catch (e) {}
  }

  function setInputListener(on) {
    try {
      if (on) document.addEventListener("keydown", onComposerKeydown, true);
      else document.removeEventListener("keydown", onComposerKeydown, true);
    } catch (e) {}
  }

  setScrollListener(scrollWatchNeeded());
  setInputListener(settings.inputLagOn && settings.observe);
  syncCvAttr();   // v0.3.4：启动即对齐一次（幂等，属性只在开关开时出现）

  // 页面卸载时别把属性留在 DOM 上（多窗口/热重载会保留 documentElement）
  function onPageUnload() {
    try {
      if (scrollMaskTimer) { clearTimeout(scrollMaskTimer); scrollMaskTimer = null; }
      scrollMaskDeadline = 0;
      var root = document.documentElement;
      if (root) {
        root.removeAttribute("data-lagfix-scroll");
        root.removeAttribute("data-lagfix-pane-switch");
        root.removeAttribute("data-lagfix-pane-open");
        root.removeAttribute(CV_ATTR);
      }
    } catch (e) {}
  }
  function setPageUnloadListener(on) {
    try {
      if (on) {
        window.addEventListener("pagehide", onPageUnload);
        window.addEventListener("beforeunload", onPageUnload);
      } else {
        window.removeEventListener("pagehide", onPageUnload);
        window.removeEventListener("beforeunload", onPageUnload);
      }
    } catch (e) {}
  }
  setPageUnloadListener(!state.dead && settings.observe);

  // ---- v0.3.1 loadOlder 观测包装（只观测，不拦截） ----
  // generation：释放/关闭后递增；在途 promise 的回调据此丢弃，
  // 避免「关掉又打开」后 calls=0 但 p95/max 有值。
  var loadOlderGen = 0;

  // v0.3.4：滚动诊断关闭会清空观测环，但降频开着时包装不卸载。在途 promise
  // 的回调只认 loadOlderGen（包装代际），会把关闭前的调用写回已清空的环；
  // 若用户在 resolve 前又打开诊断，这条数据会被当成重开后的新明细。
  // 独立的诊断代际：关闭时递增，回调要求代际一致。
  var loadOlderDiagGen = 0;

  function recordLoadOlder(t0) {
    var now = performance.now();
    var ms = Math.round(now - t0);
    loadOlderRing.push({ t: now, ms: ms });
    if (loadOlderRing.length > RING_MAX) loadOlderRing.shift();
  }

  // 包装函数 → 它的 pace 计数对象。安装成功/复用 marker 时用它绑定 paceStats。
  function paceOf(wrapped) {
    try { return wrapped.__lagfixPace || null; } catch (e) { return null; }
  }

  function makeProbedLoadOlder(orig) {
    var gen = loadOlderGen;
    var diagGen = loadOlderDiagGen;   // v0.3.4：关闭滚动诊断后，在途回调不得写回
    // 本次包装后的调用数：换 store 会重建 wrapper，trigger 的 initial 随之重置。
    // 不能用全局 loadOlderCalls——它跨 store 累计，会让新 store 的首次补页误判 unknown。
    var callsInWrap = 0;
    // v0.3.4 O3 降频状态随包装实例存亡：换主 store 归零；paceStats 让样本能读到。
    // lastAllowedAt 只在 >PACE_MIN_ROWS 的放行时刷新：小窗口补页本就不贵，不计时。
    // 初值给一个极小值：performance.now() 在页面启动后可能小于 600，
    // 用 0 会让开机后第一次大窗口补页被误判成"距上次不足 600ms"。
    var pace = { allowed: 0, skipped: 0, lastAllowedAt: -1e9 };
    // 不在这里写 paceStats：安装可能失败（冻结/不可扩展 store），那时样本会
    // 显示 0/0，把「没装上」误报成「还没有触发」。由 applyLoadOlderProbe 在
    // marker 写入成功后绑定；任何失败/回滚分支置 null。
    // 显式严格模式：宿主的类方法是严格函数，解构调用（无 this）时应拿到 undefined
    // 而不是被 sloppy 规则换成 globalThis。保持与原方法完全一致的 this 语义。
    var wrapped = function () {
      "use strict";
      // v0.3.4 O3 触发降频：与观测开关独立（节流/大会话保护同样不依赖 observe）。
      // 只对**滚动触发**的调用降频：宿主还有非滚动补拉——SessionPane 检测到首 turn
      // 缺 header 时 `void lease.store.loadOlder()`，并用 cursor 去重（跳过就不会
      // 重试），跳掉它会让首 turn header 一直缺失。滚动的触发来自 handleScroll，
      // 同步发生在 scroll 事件里，用 200ms 窗口足以识别。
      if (settings.loadOlderPaceOn && !state.dead && paceInScrollDispatch) {
        var rowsNow = readLoadedRows(this);
        if (rowsNow !== null && rowsNow > PACE_MIN_ROWS) {
          var tNow = performance.now();
          if (tNow - pace.lastAllowedAt < PACE_INTERVAL_MS) {
            pace.skipped++;
            // 跳过的调用不碰原方法、不进任何观测环/明细、不计数——没发生的调用
            // 不能被记成成功或失败；返回已结算 promise，宿主 fire-and-forget
            // 触发链无感，下一次滚动事件会带更新的锚点自然重试。
            return Promise.resolve();
          }
          pace.lastAllowedAt = tNow;
        }
        pace.allowed++;
      }
      // 暂停观测或关闭滚动诊断时原样放行：不计数、不写明细、不消耗 initial 判定。
      if (!settings.observe || !settings.scrollDiagOn || state.dead) return orig.apply(this, arguments);
      var t0 = performance.now();
      var startedAt = Date.now();
      var isFirst = callsInWrap === 0;
      var rowsBefore = readLoadedRows(this);
      var trigger = classifyLoadOlderTrigger(isFirst);
      var self = this;
      callsInWrap++;
      loadOlderCalls++;
      var ret;
      try {
        ret = orig.apply(this, arguments);
      } catch (e) {
        loadOlderErrors++;
        if (gen === loadOlderGen) {
          recordLoadOlderDetail({
            t: startedAt, ms: Math.round(performance.now() - t0), ok: false,
            rowsBefore: rowsBefore, rowsAfter: readLoadedRows(self), trigger: trigger,
          });
        }
        throw e;   // 同步异常必须原样抛给调用方
      }
      if (ret && typeof ret.then === "function") {
        // 返回**原 promise**：调用方拿到的必须和未包装时同一个引用，
        // 否则 await/链式 .then 的时序与身份判断都会变。
        ret.then(function () {
          if (gen === loadOlderGen && diagGen === loadOlderDiagGen && settings.observe) {
            recordLoadOlder(t0);
            recordLoadOlderDetail({
              t: startedAt, ms: Math.round(performance.now() - t0), ok: true,
              rowsBefore: rowsBefore, rowsAfter: readLoadedRows(self), trigger: trigger,
            });
          }
        }, function () {
          if (gen === loadOlderGen && diagGen === loadOlderDiagGen && settings.observe) {
            loadOlderErrors++;
            recordLoadOlder(t0);
            recordLoadOlderDetail({
              t: startedAt, ms: Math.round(performance.now() - t0), ok: false,
              rowsBefore: rowsBefore, rowsAfter: readLoadedRows(self), trigger: trigger,
            });
          }
        });
        return ret;
      }
      if (gen === loadOlderGen && diagGen === loadOlderDiagGen && settings.observe) {
        recordLoadOlder(t0);
        recordLoadOlderDetail({
          t: startedAt, ms: Math.round(performance.now() - t0), ok: true,
          rowsBefore: rowsBefore, rowsAfter: readLoadedRows(self), trigger: trigger,
        });
      }
      return ret;
    };
    try { wrapped.__lagfixPace = pace; } catch (e) {}
    return wrapped;
  }

  function applyLoadOlderProbe(store) {
    // v0.3.4：观测（scrollDiagOn）或降频（loadOlderPaceOn）任一需要都要装；
    // 两者同时关时才不装/卸载，行为回到 v0.3.3。
    if ((!settings.scrollDiagOn && !settings.loadOlderPaceOn) || state.dead || !store) return false;
    // 宿主的 loadOlder 定义在 ConversationProjectionStore 原型上，但调用点是
    // lease.store.loadOlder()（实例查找）。只包当前主 store 实例：既不把隐藏会话
    // 的补页记进同一份明细，也不在共享原型上留下全局副作用。
    if (loadOlderTarget && loadOlderTarget !== store) {
      releaseLoadOlderProbe();
      // 明细环是“当前主 store”口径：切到新会话后不把上一个会话的补页记录混进来。
      loadOlderDetail.length = 0;
      lastDetailKey = "";
    }
    var marker = store.__lagfixLoadOlder;
    if (marker && marker.wrapped && store.loadOlder === marker.wrapped) {
      loadOlderTarget = store;
      paceStats = marker.pace || null;   // v0.3.4：复用已包装时恢复计数归属
      return true;   // 已包装：复用，不套两层
    }
    if (marker) {
      // 宿主换过方法：旧 wrapper 已失效。只清理仍指向旧 wrapper 的自有属性，
      // 不覆盖宿主的新实现。
      try {
        if (!marker.wrapped || store.loadOlder === marker.wrapped) {
          if (marker.hadOwn) store.loadOlder = marker.orig;
          else delete store.loadOlder;
        }
        delete store.__lagfixLoadOlder;
      } catch (e) {}
    }
    var orig = store.loadOlder;
    if (typeof orig !== "function") return false;
    var hadOwn = Object.prototype.hasOwnProperty.call(store, "loadOlder");
    var wrapped;
    try {
      wrapped = makeProbedLoadOlder(orig);
      store.loadOlder = wrapped;
    } catch (e) {
      return false;   // 冻结/只读 store：降级为不观测，不能影响宿主
    }
    try {
      // v0.3.4：pace 随 marker 存亡——marker 命中分支据此恢复 paceStats。
      store.__lagfixLoadOlder = { orig: orig, hadOwn: hadOwn, wrapped: wrapped, pace: paceOf(wrapped) };
    } catch (e2) {
      // 方法已替换但 marker 写不进去（不可扩展 store）：回滚方法，避免下次
      // 再包一层后既无法识别也无法还原。
      try {
        if (store.loadOlder === wrapped) {
          if (hadOwn) store.loadOlder = orig;
          else delete store.loadOlder;
        }
      } catch (e3) {}
      paceStats = null;
      return false;
    }
    loadOlderTarget = store;
    paceStats = paceOf(wrapped);   // 安装成功才绑定计数
    return true;
  }

  function releaseLoadOlderProbe() {
    var target = loadOlderTarget;
    loadOlderTarget = null;
    loadOlderGen++;   // 在途回调作废：不向已清空的环形窗口写回
    paceStats = null; // v0.3.4：降频计数随包装一起消失，样本回落到 pace=null
    if (!target) return;
    try {
      var rec = target.__lagfixLoadOlder;
      if (rec) {
        // 只还原我们装上去的那一层；若宿主已经换过方法，不要覆盖它的新实现。
        if (!rec.wrapped || target.loadOlder === rec.wrapped) {
          // 原来没有自有方法时删除自有属性，恢复原型查找（不留同引用影子属性）。
          if (rec.hadOwn) target.loadOlder = rec.orig;
          else delete target.loadOlder;
        }
      }
      delete target.__lagfixLoadOlder;
    } catch (e) {}
  }

  // ---- v0.3.2：多会话归因（只读，最多 5 个桶） ----
  // 只读 data-session-id / data-projection-seq / turn 单元；不碰 store 与会话数据。
  function findSessionBucket(sid) {
    for (var i = 0; i < sessionBuckets.length; i++) {
      if (sessionBuckets[i].sid === sid) return sessionBuckets[i];
    }
    return null;
  }

  function findBucketByPane(pane) {
    for (var i = 0; i < sessionPanes.length; i++) {
      if (sessionPanes[i].pane === pane) return sessionPanes[i].bucket;
    }
    return null;
  }

  function mapPane(pane, bucket) {
    for (var i = sessionPanes.length - 1; i >= 0; i--) {
      if (sessionPanes[i].pane === pane) sessionPanes.splice(i, 1);
    }
    sessionPanes.push({ pane: pane, bucket: bucket });
  }

  function removePaneMapping(pane) {
    for (var i = sessionPanes.length - 1; i >= 0; i--) {
      if (sessionPanes[i].pane === pane) sessionPanes.splice(i, 1);
    }
  }

  function bucketHasPane(bucket) {
    for (var i = 0; i < sessionPanes.length; i++) {
      if (sessionPanes[i].bucket === bucket) return true;
    }
    return false;
  }

  function readPaneSeq(pane) {
    try { return pane ? pane.getAttribute(ATTR) : null; } catch (e) { return null; }
  }

  function readPaneSid(pane) {
    try { return pane ? (pane.getAttribute(SID_ATTR) || "") : ""; } catch (e) { return ""; }
  }

  // 宿主对未分配会话 id 的 pane 写 "draft"（SessionPane：sessionId ?? "draft"），
  // 旧测试/过渡态也可能是空字符串。两者都视为占位 sid，不参与长期归因。
  function isPlaceholderSid(sid) {
    return sid === "" || sid === "draft";
  }

  function makeSessionBucket(sid, pane) {
    var now = Date.now();
    var b = {
      sid: sid, pane: pane || null, visible: false,
      // lastActive 只由真实提交/滚动更新；新发现的空闲 pane 不能伪装成“刚活跃”，
      // 否则超过 5 个 pane 时会反复淘汰真正有数据的桶。
      lastActive: 0, firstSeenAt: now,
      frames: 0, sampleAt: now,
      mountedTurns: 0, dom: 0, needsSample: true, domAt: 0,
      lastSeq: readPaneSeq(pane),
      lastScrollAt: 0, scrollRing: [],
    };
    sessionBuckets.push(b);
    return b;
  }

  function bucketRank(b) {
    // 从未活跃过就是 0：新发现的空闲 pane 不能因为“刚被看到”就压过真正有提交的桶。
    return b.lastActive || 0;
  }

  function removeSessionBucketAt(idx) {
    var dead = sessionBuckets.splice(idx, 1)[0];
    if (!dead) return null;
    // 清掉所有指向该桶的 pane 映射，避免留下“幽灵桶”：被淘汰后仍被子树引用。
    for (var i = sessionPanes.length - 1; i >= 0; i--) {
      if (sessionPanes[i].bucket === dead) sessionPanes.splice(i, 1);
    }
    return dead;
  }

  function evictLeastActiveBucket() {
    if (!sessionBuckets.length) return null;
    var idx = 0;
    var best = null;
    for (var i = 0; i < sessionBuckets.length; i++) {
      var b = sessionBuckets[i];
      if (!best) { best = b; idx = i; continue; }
      var r = bucketRank(b), br = bucketRank(best);
      if (r < br || (r === br && b.firstSeenAt < best.firstSeenAt)
        || (r === br && b.firstSeenAt === best.firstSeenAt && b.sid < best.sid)) {
        best = b;
        idx = i;
      }
    }
    return removeSessionBucketAt(idx);
  }

  // admit=false：发现阶段（sync）。已满 5 个时不再为额外 pane 建桶，
  // 避免“建桶→淘汰→下轮再建”的周期抖动；这些 pane 仍被观察，等真实
  // 提交/滚动走 admit=true 的路径，才有资格淘汰最久未活跃的旧桶。
  function ensureSessionBucket(sid, pane, admit) {
    var b = findSessionBucket(sid);
    if (!b) {
      if (sessionBuckets.length >= SESSION_BUCKET_MAX) {
        if (!admit) return null;
        evictLeastActiveBucket();
      }
      b = makeSessionBucket(sid, pane);
    }
    if (pane) {
      // pane 从卸载状态重新挂回/换到新元素：立即补采 DOM/turn，并从新 pane
      // 当前 seq 重新起算，避免拿旧 pane 的 seq 误判同值而少计一次提交。
      if (b.pane !== pane) {
        b.needsSample = true;
        b.lastSeq = readPaneSeq(pane);
      }
      b.pane = pane;
      mapPane(pane, b);
    }
    return b;
  }

  function trimSessionBuckets() {
    while (sessionBuckets.length > SESSION_BUCKET_MAX) evictLeastActiveBucket();
  }

  function paneVisible(pane) {
    try {
      if (!pane || !pane.isConnected) return false;
      if (typeof pane.checkVisibility === "function") {
        if (!pane.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
      }
      var r = pane.getBoundingClientRect();
      return !!(r && r.width > 0 && r.height > 0);
    } catch (e) { return false; }
  }

  // 每个桶各自按 60s 采样 DOM/turn；新桶/重挂回桶立即采一次。
  // 不跟随 5s 采集周期遍历 pane 子树：9k DOM 下那会把观测器变成新的卡顿源。
  function sampleSessionDom(now) {
    for (var i = 0; i < sessionBuckets.length; i++) {
      var b = sessionBuckets[i];
      var due = b.needsSample || !b.domAt || now - b.domAt > 60000;
      if (!due) continue;
      b.needsSample = false;
      b.domAt = now;
      if (!b.pane || !b.pane.isConnected) {
        b.mountedTurns = 0;
        b.dom = 0;
        continue;
      }
      var all = null;
      try { all = b.pane.getElementsByTagName("*"); } catch (e) {}
      if (!all) continue;
      var turns = 0;
      for (var k = 0; k < all.length; k++) {
        try {
          if (all[k].getAttribute && all[k].getAttribute("data-v4-turn-unit") === "true") turns++;
        } catch (e) {}
      }
      b.dom = all.length + 1;   // 含 pane 根
      b.mountedTurns = turns;
    }
  }

  function onSessionMutation(muts) {
    if (state.dead || !settings.sessionDiagOn || !settings.observe) return;
    for (var i = 0; i < muts.length; i++) {
      // 每条独立 try：一条坏记录不能跳过同批其它会话的提交。
      try {
        var m = muts[i];
        if (!m || m.type !== "attributes") continue;
        var pane = m.target;
        if (!pane || pane.isConnected === false) continue;
        var b = findBucketByPane(pane);
        if (m.attributeName === SID_ATTR) {
          var sid = readPaneSid(pane);
          // 同值重写既不是切换，也不是活跃：不能更新 lastActive，更不能借此
          // 给满 5 桶时的额外 pane 抢名额（宿主正常不会这么做，纯防御）。
          var prevSid = m.oldValue;
          if (prevSid !== null && prevSid !== undefined && String(prevSid) === sid) continue;
          if (!b || b.sid !== sid) {
            var old = b;
            removePaneMapping(pane);
            if (old) {
              old.pane = null;
              old.visible = false;
              old.lastScrollAt = 0;   // 旧会话立即停止接收该 pane 的滚动帧
              // draft/空 sid 只是过渡占位；切成真实会话后删掉，别占 5 个名额。
              if (isPlaceholderSid(old.sid) && !bucketHasPane(old)) {
                var oi = sessionBuckets.indexOf(old);
                if (oi >= 0) removeSessionBucketAt(oi);
              }
            }
            // 切会话本身不是提交/滚动；只有“已跟踪的真实会话 → 另一个真实会话”
            // 才按换桶处理（当前主 pane 切走后要能看到新会话）。额外 pane 或
            // draft/空 sid 不满足准入，等真实提交/滚动再接管名额。
            var wasTracked = !!old && !isPlaceholderSid(old.sid);
            var canAdmit = wasTracked && !isPlaceholderSid(sid);
            b = ensureSessionBucket(sid, pane, canAdmit);
            if (!b) continue;
            b.lastSeq = readPaneSeq(pane);   // 新会话从当前 seq 起算
          }
          // 只换桶，不把“切到一个会话”当成活跃；lastActive 由真实提交/滚动更新。
          continue;
        }
        if (m.attributeName !== ATTR) continue;
        var seq = readPaneSeq(pane);
        // 同值 seq 重写不是提交；未入桶的额外 pane 也不能借此抢名额/伪造帧。
        var prevSeq = m.oldValue;
        if (prevSeq !== null && prevSeq !== undefined
          && String(prevSeq) === String(seq)) continue;
        if (!b) {
          // 首次看到这个 pane 的提交：建桶（必要时淘汰最久未活跃的旧桶）并记 1 次。
          b = ensureSessionBucket(readPaneSid(pane), pane, true);
          if (!b) continue;
          b.lastSeq = seq;
          b.frames++;
          b.lastActive = Date.now();
          continue;
        }
        if (seq === b.lastSeq) continue;   // 同值重写不算提交（与全局 frames 口径一致）
        b.lastSeq = seq;
        b.frames++;
        b.lastActive = Date.now();
      } catch (e) { /* 单条坏记录不影响其它会话 */ }
    }
    try { trimSessionBuckets(); } catch (e) {}
  }

  function ensureSessionMO() {
    if (sessionMO || typeof MutationObserver !== "function") return;
    try { sessionMO = new MutationObserver(onSessionMutation); } catch (e) { sessionMO = null; }
  }

  function samePaneList(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // 只在观察目标集合变化时 disconnect/reobserve。每次 collect 都重挂会丢掉
  // 同一拍已排队的 mutation，也白白增加同步开销。
  function syncSessionObserver(panes) {
    ensureSessionMO();
    if (!sessionMO) return;
    if (samePaneList(panes, sessionObservedPanes)) return;
    // disconnect() 会丢掉已排队的 mutation；先取出来补处理，避免切换/重建
    // pane 的同批提交被静默漏计。
    var pending = [];
    try { pending = sessionMO.takeRecords(); } catch (e) {}
    try { sessionMO.disconnect(); } catch (e) {}
    if (pending.length) {
      try { onSessionMutation(pending); } catch (e2) {}
    }
    sessionObservedPanes = panes.slice();
    for (var i = 0; i < panes.length; i++) {
      try {
        sessionMO.observe(panes[i], {
          attributes: true, attributeFilter: [ATTR, SID_ATTR], attributeOldValue: true,
        });
      } catch (e) {}
    }
  }

  // 每次 collect / attach / 看门狗同步一次：发现新 pane、停用消失的 pane、
  // 复核观察目标。额外 pane 在满 5 个后只观察不建桶，等真实活动再接管名额。
  function syncSessionPanes() {
    if (!settings.sessionDiagOn || state.dead) {
      releaseSessionProbe();
      return;
    }
    if (!settings.observe) return;   // 暂停时保留桶，但不发现/不观察
    var panes = [];
    try { panes = document.querySelectorAll("[data-session-id]"); } catch (e) { panes = []; }
    var seen = [];
    var observeTargets = [];
    for (var i = 0; i < panes.length; i++) {
      var pane = panes[i];
      if (!pane || pane.isConnected === false) continue;
      observeTargets.push(pane);
      var b = ensureSessionBucket(readPaneSid(pane), pane, false);
      if (b) seen.push(b);
    }
    // 解绑消失的桶；占位 sid 失去 pane 后直接删掉，避免幽灵桶占名额。
    for (var j = sessionBuckets.length - 1; j >= 0; j--) {
      var bucket = sessionBuckets[j];
      if (seen.indexOf(bucket) >= 0) continue;
      bucket.pane = null;
      bucket.visible = false;
      bucket.mountedTurns = 0;
      bucket.dom = 0;
      bucket.lastScrollAt = 0;
      if (isPlaceholderSid(bucket.sid) && !bucketHasPane(bucket)) {
        removeSessionBucketAt(j);
      }
    }
    trimSessionBuckets();
    syncSessionObserver(observeTargets);
    for (var n = sessionPanes.length - 1; n >= 0; n--) {
      var rec = sessionPanes[n];
      if (!rec || !rec.pane || rec.pane.isConnected === false
        || seen.indexOf(rec.bucket) < 0) {
        sessionPanes.splice(n, 1);
      }
    }
  }

  function releaseSessionProbe() {
    try { if (sessionMO) sessionMO.disconnect(); } catch (e) {}
    sessionMO = null;
    sessionBuckets.length = 0;
    sessionPanes.length = 0;
    sessionObservedPanes.length = 0;
  }

  // 暂停：清周期计数与 DOM 引用，但不改 lastActive（暂停不是活跃），
  // 也不丢桶本身。sampleAt 归零，恢复时由 restartSessionSampling 重新起算，
  // 避免把整段暂停时长算进第一个 commitRate 的分母。
  function resetSessionCounts() {
    for (var i = 0; i < sessionBuckets.length; i++) {
      var b = sessionBuckets[i];
      b.frames = 0;
      b.sampleAt = 0;
      b.lastScrollAt = 0;
      b.scrollRing.length = 0;
      b.pane = null;
      b.visible = false;
      b.mountedTurns = 0;
      b.dom = 0;
      b.needsSample = true;
      b.domAt = 0;
    }
    sessionPanes.length = 0;
    sessionObservedPanes.length = 0;
  }

  function restartSessionSampling() {
    var now = Date.now();
    for (var i = 0; i < sessionBuckets.length; i++) {
      sessionBuckets[i].frames = 0;
      sessionBuckets[i].sampleAt = now;
    }
  }

  function applySessionSettings() {
    if (!settings.sessionDiagOn || state.dead) releaseSessionProbe();
    else syncSessionPanes();
    setScrollListener(scrollWatchNeeded());
  }

  function sessionSnapshot(now) {
    if (!settings.sessionDiagOn || !settings.observe || state.dead) return null;
    syncSessionPanes();
    sampleSessionDom(now);
    var out = [];
    var nowEpoch = Date.now();
    for (var i = 0; i < sessionBuckets.length; i++) {
      var b = sessionBuckets[i];
      b.visible = paneVisible(b.pane);
      var dt = (nowEpoch - b.sampleAt) / 1000;
      var rate = null;
      if (dt >= 1) rate = Math.round((b.frames / dt) * 10) / 10;
      out.push({
        sid: b.sid,
        visible: b.visible,
        lastActive: b.lastActive,
        frames: b.frames,
        commitRate: rate,
        mountedTurns: b.mountedTurns,
        dom: b.dom,
        scrollP95: pctOf(windowValues(b.scrollRing, now), 0.95),
      });
      // 采样间隔太短时先不重置：rate 为 null，累计量留到下一轮用更长窗口算。
      if (dt >= 1) {
        b.frames = 0;
        b.sampleAt = nowEpoch;
      }
    }
    out.sort(function (x, y) {
      return (y.lastActive - x.lastActive) || (x.sid < y.sid ? -1 : x.sid > y.sid ? 1 : 0);
    });
    return out.slice(0, SESSION_BUCKET_MAX);
  }

  // v0.3.2：loadOlder 明细只记元数据，不记分页内容/消息 id。
  function readLoadedRows(store) {
    try {
      var st = store && store.state;
      var rows = st && st.snapshot && st.snapshot.rows;
      var win = rows && rows.window;
      // 宿主 rows.window 是数组；非数组一律按未知处理，避免把 array-like 当行数。
      if (Array.isArray(win)) return win.length;
    } catch (e) {}
    return null;
  }

  function classifyLoadOlderTrigger(isFirst) {
    var now = performance.now();
    if (lastScrollAt && now - lastScrollAt <= LOAD_OLDER_SCROLL_WINDOW_MS) return "scroll";
    var attached = state.attachedPerfAt || 0;
    if (isFirst || (attached && now - attached <= LOAD_OLDER_INITIAL_WINDOW_MS)) return "initial";
    return "unknown";
  }

  function recordLoadOlderDetail(entry) {
    detailVersion++;
    loadOlderDetail.push(entry);
    if (loadOlderDetail.length > LOAD_OLDER_DETAIL_MAX) loadOlderDetail.shift();
  }

  function loadOlderDetailKey() {
    var s = detailVersion + "|";
    for (var i = 0; i < loadOlderDetail.length; i++) {
      var d = loadOlderDetail[i];
      s += d.t + ":" + d.ms + ":" + (d.ok ? 1 : 0) + ";";
    }
    return s;
  }

  // ---- 锚点选择：primary pane 优先，其次可见面积最大 ----
  function findAnchor() {
    try {
      var nodes = document.querySelectorAll("[" + ATTR + "]");
      if (!nodes.length) return null;

      // 1) 宿主标记的主 pane
      for (var i = 0; i < nodes.length; i++) {
        var tid = nodes[i].getAttribute("data-testid") || "";
        if (tid.indexOf("workspace-main") >= 0 || tid.indexOf("primary") >= 0) {
          return { el: nodes[i], sid: nodes[i].getAttribute(SID_ATTR) || "" };
        }
      }

      // 2) 可见面积最大的 pane（分屏时正确命中用户正在看的那个）
      var best = null;
      var bestArea = -1;
      for (var j = 0; j < nodes.length; j++) {
        var r = nodes[j].getBoundingClientRect();
        var area = r.width * r.height;
        if (r.width > 0 && r.height > 0 && area > bestArea) {
          best = nodes[j];
          bestArea = area;
        }
      }
      if (best) return { el: best, sid: best.getAttribute(SID_ATTR) || "" };

      // 3) 兜底：最后一个有 session id 的
      for (var k = nodes.length - 1; k >= 0; k--) {
        if (nodes[k].getAttribute(SID_ATTR)) {
          return { el: nodes[k], sid: nodes[k].getAttribute(SID_ATTR) };
        }
      }
    } catch (e) { err(); }
    return null;
  }

  function attach(anchor) {
    // 恢复默认 / 重新挂载会再次走 attach：先断开旧 observer，
    // 否则两个 observer 同时计数，提交率直接翻倍。
    try { if (mo) { mo.disconnect(); mo = null; } } catch (e) {}
    state.el = anchor.el;
    state.sid = anchor.sid;
    state.switchedAt = Date.now();
    state.attachedPerfAt = performance.now();
    state.lastSeq = state.el.getAttribute(ATTR);
    state.lastT = performance.now();
    resetWindow();
    try {
      mo = new MutationObserver(function (mutations) {
        try {
          // sid 检查必须在前：宿主切会话只改 data-session-id，
          // seq 可能恰好相同，被 seq 门控就永远发现不了（终审 P1-3）。
          var sidNow = state.el.getAttribute(SID_ATTR) || "";
          if (sidNow !== state.sid) {
            state.sid = sidNow;
            state.switchedAt = Date.now();
            state.attachedPerfAt = performance.now();
            state.lastSeq = state.el.getAttribute(ATTR);
            state.lastT = performance.now();
            resetWindow();
            try { syncSessionPanes(); } catch (e3) {}
            // 切会话可能重建 projection store；立即尝试重装一次，别等 5s 看门狗
            // （冷静期只有 10s，前 5s 的首屏水合最需要保护）。
            if (settings.throttleOn || settings.bigSessionOn || settings.scrollDiagOn
              || settings.loadOlderPaceOn) {
              try { applyThrottle(); } catch (e2) {}
            }
            return;
          }
          var cur = state.el.getAttribute(ATTR);
          if (cur === state.lastSeq) return;
          var now = performance.now();
          // 暂停观测时只推进基线，不累计（否则恢复后第一批样本会混入暂停期的计数）
          if (!settings.observe) {
            state.lastSeq = cur;
            state.lastT = now;
            return;
          }
          // v0.3.5 P0：seq 变化就是一次投影提交；首次基线变化也算（它同样会触发渲染）。
          if (settings.lafDiagOn && settings.lafCtxOn && !state.dead) {
            lastCommitAt = now;
          }
          // 挂载/切会话后的第一次变化是「加载耗时」，不是帧间隔（终审 P1-4）
          if (!state.primed) {
            state.primed = true;
            state.lastSeq = cur;
            state.lastT = now;
            return;
          }
          var iv = Math.round(now - state.lastT);
          if (iv > 0 && iv < 60000) {
            state.ring.push({ t: now, ms: iv });
            if (state.ring.length > RING_MAX) state.ring.shift();
            if (iv > state.allTimeMax) state.allTimeMax = iv;
          }
          state.lastSeq = cur;
          state.lastT = now;
          state.frames++;
          state.tickFrames++;
        } catch (e) { err(); }
      });
      // sid 变化不一定伴随 seq 变化，两个属性都要听
      mo.observe(state.el, { attributes: true, attributeFilter: [ATTR, SID_ATTR] });
    } catch (e) { err(); }
    try { syncSessionPanes(); } catch (e) {}
    // v0.3.3：锚点挂上后立即确认侧栏标记，不必等第一轮 collect（5s）。
    try { syncPaneProbe(); } catch (e) {}
    armWatchdog();    // 锚点一挂上就尝试装节流（store 只能从真实 fiber 上取，必须等挂载完成）
    if ((settings.throttleOn && !fixState.applied) || settings.bigSessionOn
      || settings.scrollDiagOn || settings.loadOlderPaceOn) applyThrottle();
  }

  function armWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    watchdogTimer = setInterval(function () {
      if (state.dead) return;
      try {
        if (!state.el || !state.el.isConnected || state.el.getAttribute(ATTR) === null) {
          if (mo) { mo.disconnect(); mo = null; }
          state.el = null;
          state.lastSeq = null;
          state.lostSince = Date.now();
          // 丢锚点后旧 store 已不代表当前会话；立即释放，避免旧实例继续记账。
          try { releaseLoadOlderProbe(); } catch (e3) {}
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          startReacquire();
          return;
        }
        // 宿主可能重建 store（切会话/换 pane）：定期核对当前目标还是不是被包的那个。
        // 大会话保护也走同一条复核：只判 !loadTarget 的话，宿主中途换原型会让
        // 保护静默失效，而面板仍按旧目标显示"已装"。
        if ((settings.throttleOn && (fixState.applied || fixState.tries < 20))
          || settings.bigSessionOn || settings.scrollDiagOn || settings.loadOlderPaceOn) {
          applyThrottle();
        }
        // v0.3.2：新开的会话 pane 不一定伴随锚点变化，看门狗顺带补发现。
        try { syncSessionPanes(); } catch (e2) {}
      } catch (e) { err(); }
    }, 5000);
  }

  function startReacquire() {
    if (acquireTimer) return;
    acquireTimer = setInterval(function () {
      if (state.dead) return;
      var a = findAnchor();
      if (a) {
        state.lostSince = 0;
        clearInterval(acquireTimer);
        acquireTimer = null;
        attach(a);
      } else if (state.lostSince && Date.now() - state.lostSince > ACQUIRE_TIMEOUT_MS) {
        // 不永久禁用：降频重试，用户打开会话后自动恢复（终审 P1-8）
        clearInterval(acquireTimer);
        acquireTimer = null;
        state.missed = true;
        state.missedReason = "anchor-lost-slow-retry";
        slowRetryTimer = setTimeout(function retry() {
          slowRetryTimer = null;
          if (state.dead || !settings.observe) return;
          var a2 = findAnchor();
          if (a2) { state.missed = false; state.missedReason = ""; attach(a2); return; }
          slowRetryTimer = setTimeout(retry, ACQUIRE_RETRY_MS);
        }, ACQUIRE_RETRY_MS);
      }
    }, ACQUIRE_POLL_MS);
  }

  // 初始锚点获取
  acquireTimer = setInterval(function () {
    if (state.dead) return;
    var a = findAnchor();
    if (a) {
      clearInterval(acquireTimer);
      acquireTimer = null;
      attach(a);
      startRaf();
    } else if (Date.now() - state.since > ACQUIRE_TIMEOUT_MS) {
      clearInterval(acquireTimer);
      acquireTimer = null;
      state.missed = true;
      state.missedReason = "anchor-not-found";
      // 不能永久放弃：用户可能启动后 10 分钟才打开会话。按慢速轮询继续等锚点，
      // 找到后照常 attach 并补启 rAF（否则角标一直"空闲"、四项增强全部静默失效）。
      setTimeout(function retry() {
        slowRetryTimer = null;
        if (state.dead || !settings.observe) return;
        var a2 = findAnchor();
        if (a2) {
          state.missed = false;
          state.missedReason = "";
          attach(a2);
          startRaf();
          return;
        }
        slowRetryTimer = setTimeout(retry, ACQUIRE_RETRY_MS);
      }, ACQUIRE_RETRY_MS);
    }
  }, ACQUIRE_POLL_MS);

  // ---- 状态条角标 + 悬停统计 + 居中设置弹窗（v0.2.3，v0.3 加可见性判定）----
  // 交互参考 zusage 的状态条：角标浮在输入框上方，悬停看统计，齿轮进分类设置。
  var STATS_ID = "lagfix-stats";
  var MASK_ID = "lagfix-modal-mask";
  var STYLE_ID = "lagfix-style";
  var GEAR_ID = "lagfix-gear";
  var HIST_MAX = 60;          // 最近 60 个采集周期（默认 5s ≈ 5 分钟）
  var hist = [];              // [{t, p95, fmax, rate, lt, heap}]
  var statsPinned = false;
  var statsHideTimer = null;
  var statsShowTimer = null;
  var panelNav = "status";
  var uiBound = false;
  var observedSurface = null;
  var surfaceRO = null;
  var lastTickAt = 0;         // 上次角标刷新的时间（算提交速率/停顿）

  // 自禁用/卸载时把注入的元素全部撤掉，包括样式表与悬停统计。
  function removeOverlay() {
    [OVERLAY_ID, STATS_ID, MASK_ID, STYLE_ID].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  // 帧间隔档位：颜色越暖越卡。档位只用于"说明卡到什么程度"，
  // 角标主色由面板里的黄/红阈值决定（两套阈值互不干扰）。
  var FRAME_TIERS = [
    { max: 20,       label: "极流畅", color: "#2ea043" },
    { max: 35,       label: "流畅",   color: "#3fb950" },
    { max: 50,       label: "正常",   color: "#58a6ff" },
    { max: 80,       label: "轻微",   color: "#d29922" },
    { max: 120,      label: "卡",     color: "#f0883e" },
    { max: Infinity, label: "很卡",   color: "#f85149" },
  ];

  function tierOf(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return null;
    for (var i = 0; i < FRAME_TIERS.length; i++) {
      if (ms < FRAME_TIERS[i].max) return FRAME_TIERS[i];
    }
    return FRAME_TIERS[FRAME_TIERS.length - 1];
  }

  // 最近 30 秒真实帧的最差值。配色只看近期：不能因为历史上一次 788ms
  // 就一直红（用户实测截图里帧 14ms 却是红点，就是这个原因）。
  function recentFrameMax() {
    var vals = windowValues(frameRing, performance.now());
    var m = 0;
    for (var i = 0; i < vals.length; i++) if (vals[i] > m) m = vals[i];
    return m || null;
  }

  // 所有配色都走这里：面板里的黄/红阈值是唯一口径。
  // 档位/状态只决定文案（"卡死""刚卡过"），不再各自硬编码红黄——
  // 否则用户把阈值调高后，角标仍会被 300/500ms 的硬编码分支强制染红，
  // 看起来又像"设置是死的"（三审 P1）。
  function thresholdColor(ms) {
    if (ms >= settings.badMs) return "#f85149";
    if (ms >= settings.warnMs) return "#d29922";
    return "#3fb950";
  }

  function verdictOf(frameP95, stallMs, recentMax, commitRate) {
    if (state.dead) return { label: "已停", color: "#8b949e" };
    if (!settings.observe) return { label: "已暂停", color: "#8b949e" };
    // 当前主线程被占死（定时器迟到 >500ms）和"最近刚卡过一次"要分开说：
    // 前者是正在进行，后者是 30s 内的历史峰值，用"刚卡过"避免误读成一直卡死。
    if (stallMs > 500) return { label: "卡死", color: thresholdColor(stallMs) };
    if (recentMax !== null && recentMax >= 300) {
      return { label: "刚卡过", color: thresholdColor(recentMax) };
    }
    if (frameP95 === null || frameP95 === undefined) {
      return commitRate === 0
        ? { label: "空闲", color: "#8b949e" }
        : { label: "流畅", color: "#3fb950" };
    }
    // 文案仍按固定档位描述"卡到什么程度"，主色由阈值决定：
    // 两套阈值互不干扰，用户调 30/60 后角标必须跟着变色。
    var t = tierOf(frameP95);
    return { label: t.label, color: thresholdColor(frameP95) };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = [
      // 状态条
      "#" + OVERLAY_ID + "{position:fixed;z-index:2147482000;display:flex;align-items:center;gap:6px;",
      "font:12px/1.4 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
      "color:var(--color-popover-foreground,#e6edf3);",
      "background:var(--color-popover,rgba(22,27,34,.92));",
      "border:1px solid var(--color-border,rgba(240,246,252,.16));",
      "border-radius:999px;padding:3px 5px 3px 10px;box-sizing:border-box;",
      "box-shadow:0 2px 10px rgba(0,0,0,.28);cursor:pointer;user-select:none;",
      "white-space:nowrap;overflow:hidden;max-width:calc(100vw - 24px)}",
      "#" + OVERLAY_ID + ":hover{background:var(--color-popover,#1c2129)}",
      "#" + OVERLAY_ID + " .lg-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}",
      "#" + OVERLAY_ID + " .lg-verdict{font-weight:600}",
      "#" + OVERLAY_ID + " .lg-met{color:var(--color-foreground-subtle,#9aa4b2);overflow:hidden;",
      "min-width:0;",
      "text-overflow:ellipsis}",
      "#" + OVERLAY_ID + " .lg-gear{border:0;background:transparent;color:inherit;",
      "padding:2px;margin-left:1px;border-radius:6px;cursor:pointer;display:inline-flex;",
      "align-items:center;justify-content:center;opacity:.7}",
      "#" + OVERLAY_ID + " .lg-gear:hover{background:rgba(255,255,255,.1);opacity:1}",
      // 悬停统计
      "#" + STATS_ID + "{position:fixed;z-index:2147482100;width:348px;box-sizing:border-box;",
      "padding:12px 14px 10px;border-radius:10px;",
      "font:12px/1.55 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
      "color:var(--color-popover-foreground,#e6edf3);",
      "background:var(--color-popover,#161b22);",
      "border:1px solid var(--color-border,rgba(255,255,255,.14));",
      "box-shadow:0 12px 32px rgba(0,0,0,.48)}",
      "#" + STATS_ID + " .st-hd{display:flex;justify-content:space-between;align-items:center;",
      "font-size:12px;color:var(--color-foreground-subtle,#8791a3)}",
      "#" + STATS_ID + " .st-tier{font-size:11px;padding:1px 7px;border-radius:999px;",
      "background:rgba(255,255,255,.06)}",
      "#" + STATS_ID + " .st-big{display:flex;align-items:baseline;gap:6px;margin:6px 0 2px}",
      "#" + STATS_ID + " .st-big b{font-size:26px;line-height:1.1;font-weight:650}",
      "#" + STATS_ID + " .st-big span{font-size:11px;color:var(--color-foreground-subtle,#8791a3)}",
      "#" + STATS_ID + " .st-chart{display:flex;align-items:flex-end;gap:3px;height:52px;",
      "margin:8px 0 6px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.1));",
      "padding-bottom:2px}",
      "#" + STATS_ID + " .st-chart i{flex:1 1 0;min-width:0;border-radius:2px 2px 0 0;",
      "background:#3fb950;transition:height .2s}",
      "#" + STATS_ID + " .st-peaks{display:flex;gap:12px;font-size:11px;",
      "color:var(--color-foreground-subtle,#8791a3)}",
      "#" + STATS_ID + " .st-peaks b{color:var(--color-popover-foreground,#e6edf3);font-weight:600}",
      "#" + STATS_ID + " .st-legend{display:flex;flex-wrap:wrap;gap:4px 10px;",
      "margin-top:8px;padding-top:8px;font-size:11px;",
      "border-top:1px dashed var(--color-border,rgba(255,255,255,.1));",
      "color:var(--color-foreground-subtle,#8791a3)}",
      "#" + STATS_ID + " .st-legend em{font-style:normal;display:inline-flex;align-items:center;gap:4px}",
      "#" + STATS_ID + " .st-legend i{width:7px;height:7px;border-radius:2px;display:inline-block}",
      "#" + STATS_ID + " .st-help{margin-top:7px;font-size:11px;line-height:1.5;",
      "color:var(--color-foreground-subtle,#8791a3);opacity:.9}",
      "#" + STATS_ID + " .st-foot{margin-top:8px;font-size:11px;",
      "color:var(--color-foreground-subtle,#8791a3)}",
      // 设置弹窗
      "#" + MASK_ID + "{position:fixed;inset:0;z-index:2147482200;background:rgba(0,0,0,.48);",
      "display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}",
      "#" + PANEL_ID + "{width:min(780px,100%);max-height:min(620px,84vh);display:flex;",
      "flex-direction:column;overflow:hidden;border-radius:12px;",
      "font:14px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
      "color:var(--color-popover-foreground,#e6edf3);",
      "background:var(--color-popover,#161b22);",
      "border:1px solid var(--color-border,rgba(255,255,255,.14));",
      "box-shadow:0 24px 60px rgba(0,0,0,.55)}",
      "#" + PANEL_ID + " .dlg-hd{display:flex;align-items:center;justify-content:space-between;",
      "padding:14px 18px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.1));",
      "font-size:15px;font-weight:600}",
      "#" + PANEL_ID + " .dlg-hd small{font-size:11px;font-weight:400;margin-left:8px;",
      "color:var(--color-foreground-subtle,#8791a3)}",
      "#" + PANEL_ID + " .dlg-close{border:0;background:transparent;color:inherit;",
      "font-size:20px;line-height:1;padding:0 4px;cursor:pointer;opacity:.6}",
      "#" + PANEL_ID + " .dlg-close:hover{opacity:1}",
      "#" + PANEL_ID + " .dlg-body{display:flex;min-height:0;flex:1}",
      "#" + PANEL_ID + " .dlg-nav{width:150px;flex:0 0 150px;padding:10px 8px;",
      "border-right:1px solid var(--color-border,rgba(255,255,255,.1));",
      "display:flex;flex-direction:column;gap:2px}",
      "#" + PANEL_ID + " .dlg-nav button{border:0;background:transparent;color:inherit;",
      "text-align:left;font:inherit;font-size:13px;padding:7px 10px;border-radius:7px;cursor:pointer;",
      "display:flex;align-items:center;gap:8px;opacity:.8}",
      "#" + PANEL_ID + " .dlg-nav button:hover{background:rgba(255,255,255,.06);opacity:1}",
      "#" + PANEL_ID + " .dlg-nav button.on{background:rgba(88,166,255,.16);color:#79c0ff;opacity:1}",
      "#" + PANEL_ID + " .dlg-nav span{font-size:13px}",
      "#" + PANEL_ID + " .dlg-content{flex:1;min-width:0;overflow-y:auto;padding:14px 18px 18px}",
      "#" + PANEL_ID + " h3{margin:0 0 2px;font-size:14px;font-weight:600}",
      "#" + PANEL_ID + " .sec-desc{margin:0 0 10px;font-size:12px;line-height:1.5;",
      "color:var(--color-foreground-subtle,#8791a3)}",
      "#" + PANEL_ID + " .cap{margin:12px 0 6px;font-size:12px;font-weight:600;",
      "letter-spacing:.02em;color:var(--color-foreground-subtle,#9aa4b6)}",
      "#" + PANEL_ID + " .cap:first-of-type{margin-top:2px}",
      "#" + PANEL_ID + " .card{border:1px solid var(--color-border,rgba(255,255,255,.1));",
      "border-radius:9px;padding:10px 12px;margin-bottom:10px}",
      "#" + PANEL_ID + " .row{display:flex;justify-content:space-between;align-items:center;",
      "gap:12px;padding:7px 0;border-top:1px dashed var(--color-border,rgba(255,255,255,.08))}",
      "#" + PANEL_ID + " .row:first-child{border-top:0;padding-top:0}",
      "#" + PANEL_ID + " .row.off .lab,#" + PANEL_ID + " .row.off .sub{opacity:.5}",
      "#" + PANEL_ID + " .row .lab{font-size:13px;display:flex;align-items:center;gap:6px}",
      "#" + PANEL_ID + " .row .sub{font-size:11.5px;line-height:1.45;margin-top:2px;",
      "color:var(--color-foreground-subtle,#8791a3)}",
      "#" + PANEL_ID + " .row .note{font-size:11.5px;line-height:1.55;margin-top:6px;",
      "padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.05);white-space:pre-line;",
      "color:var(--color-foreground-subtle,#9aa4b6)}",
      "#" + PANEL_ID + " button.info{flex:0 0 auto;width:15px;height:15px;padding:0;",
      "border-radius:50%;border:1px solid var(--color-border,rgba(255,255,255,.28));",
      "background:transparent;color:var(--color-foreground-subtle,#8791a3);",
      "font:inherit;font-size:10px;line-height:1;cursor:pointer;display:inline-flex;",
      "align-items:center;justify-content:center}",
      "#" + PANEL_ID + " button.info:hover{border-color:var(--color-foreground,#d6dbe4);",
      "color:var(--color-foreground,#d6dbe4)}",
      "#" + PANEL_ID + " .row .ctl{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
      "#" + PANEL_ID + " input[type=number]{width:64px;background:transparent;color:inherit;",
      "border:1px solid var(--color-border,rgba(255,255,255,.16));border-radius:6px;",
      "padding:3px 6px;font:inherit;font-size:12px;text-align:right}",
      "#" + PANEL_ID + " select{background:transparent;color:inherit;font:inherit;font-size:12px;",
      "border:1px solid var(--color-border,rgba(255,255,255,.16));border-radius:6px;padding:3px 6px}",
      "#" + PANEL_ID + " button.act{background:transparent;color:inherit;font:inherit;font-size:12px;",
      "border:1px solid var(--color-border,rgba(255,255,255,.16));border-radius:6px;",
      "padding:3px 10px;cursor:pointer}",
      "#" + PANEL_ID + " button.act:hover{background:rgba(255,255,255,.07)}",
      "#" + PANEL_ID + " button.act:disabled{opacity:.4;cursor:not-allowed}",
      "#" + PANEL_ID + " .seg{display:inline-flex;border:1px solid var(--color-border,rgba(255,255,255,.16));",
      "border-radius:6px;overflow:hidden}",
      "#" + PANEL_ID + " .seg button{border:0;background:transparent;color:inherit;",
      "font:inherit;font-size:12px;padding:3px 9px;cursor:pointer;opacity:.7}",
      "#" + PANEL_ID + " .seg button.on{background:rgba(88,166,255,.2);color:#79c0ff;opacity:1}",
      "#" + PANEL_ID + " .status{font-size:12px;line-height:1.5;",
      "color:var(--color-foreground-subtle,#8791a3);word-break:break-all}",
      "#" + PANEL_ID + " .ver{font-size:12px;color:var(--color-foreground-subtle,#8791a3);",
      "font-variant-numeric:tabular-nums;white-space:nowrap}",
      "#" + PANEL_ID + " .dlg-ft{display:flex;justify-content:space-between;align-items:center;",
      "padding:10px 18px;border-top:1px solid var(--color-border,rgba(255,255,255,.1));",
      "font-size:11.5px;color:var(--color-foreground-subtle,#8791a3)}",
      // v0.3.1 O2：滚动期临时去掉消息层上下渐隐。
      // 只覆盖 mask-image，不覆盖 mask 简写——后者会把宿主的 mask-position/size 一起重置。
      // 前提：宿主目前用**内联** style.maskImage 写遮罩（无 !important），
      // 作者的 !important 样式表规则优先于普通内联声明；若宿主改成带 important 的内联，本项会失效。
      '[data-lagfix-scroll="1"] [data-v4-timeline-message-layer="true"]{',
      "-webkit-mask-image:none !important;mask-image:none !important}",
      // v0.3.3 P1：开合 420ms 内停掉宿主的 flex-grow 过渡，把 12 帧连续重排
      // 变成一次跳变；同时临时去掉消息层遮罩。只覆盖 mask-image，不覆盖 mask 简写。
      '[data-lagfix-pane-switch="1"] [data-panel]:has([data-workspace-side-frame="true"]){transition-duration:0s !important}',
      '[data-lagfix-pane-switch="1"] [data-v4-timeline-message-layer="true"]{',
      "-webkit-mask-image:none !important;mask-image:none !important}",
      // v0.3.3 P2：面板常开期只关消息层遮罩，不隐藏内容、不改布局。
      '[data-lagfix-pane-open="1"] [data-v4-timeline-message-layer="true"]{',
      "-webkit-mask-image:none !important;mask-image:none !important}",
      // v0.3.4 O4：turn 内部行级块离屏时跳过绘制。三重防线：
      // 1) 只选 [data-v4-turn-unit] 内部的 [data-row-id]——不碰被 virtualizer
      //    测高的 turn wrapper（wrapper 高度变了整条时间线会跳）；
      // 2) :not([data-v4-running-live-tail])——正在生成的回合绝不能被跳过绘制；
      // 3) contain-intrinsic-size 的 auto 关键字——浏览器记住每块上次真实高度，
      //    屏外跳过时占位不变，已渲染过的块对测高完全无扰动（宿主只读时间线的
      //    先例没有 virtualizer，用的是固定 0 420px，两者不通用）。
      '[data-lagfix-cv="1"] [data-v4-turn-unit="true"]:not([data-v4-running-live-tail]) [data-row-id]{',
      "content-visibility:auto;contain-intrinsic-size:auto 160px}",
      // 开关
      "#" + PANEL_ID + " .sw{position:relative;display:inline-block;width:34px;height:18px;flex:0 0 auto}",
      "#" + PANEL_ID + " .sw input{position:absolute;opacity:0;width:0;height:0}",
      // 关闭态必须用中性灰：早先用 rgba(255,255,255,.2) 在浅色主题下是白底白轨，
      // 用户关掉节流后看不到开关，以为没法再打开（实测截图反馈）。
      "#" + PANEL_ID + " .sw i{position:absolute;inset:0;border-radius:999px;cursor:pointer;",
      "background:rgba(110,118,129,.55);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);",
      "transition:background .15s}",
      "#" + PANEL_ID + " .sw i:before{content:'';position:absolute;left:2px;top:2px;width:14px;",
      "height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);",
      "transition:transform .15s}",
      "#" + PANEL_ID + " .sw input:checked+i{background:#3fb950}",
      "#" + PANEL_ID + " .sw input:checked+i:before{transform:translateX(16px)}",
      "#" + PANEL_ID + " .sw input:disabled+i{opacity:.5;cursor:not-allowed}",
    ].join("");
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- 角标 ----
  function ensureBadge() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("data-lagfix-overlay", "1");
    el.title = "点开看统计：每帧=两次画面更新隔多久（越小越顺），刷新=对话区每秒重画几次，"
      + "卡顿=画面卡住超过 50ms 的次数。点齿轮进设置。";

    var dot = document.createElement("span");
    dot.className = "lg-dot";
    dot.id = OVERLAY_ID + "-dot";
    dot.style.background = "#8b949e";

    var verdict = document.createElement("span");
    verdict.className = "lg-verdict";
    verdict.id = OVERLAY_ID + "-verdict";
    verdict.textContent = "…";

    var met = document.createElement("span");
    met.className = "lg-met";
    met.id = OVERLAY_ID + "-met";
    met.textContent = "帧 -";

    var gear = document.createElement("button");
    gear.type = "button";
    gear.id = GEAR_ID;
    gear.className = "lg-gear";
    gear.title = "打开设置";
    // Lucide settings 图标（静态常量，无用户输入）
    gear.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<circle cx="12" cy="12" r="3"></circle>'
      + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06'
      + 'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4'
      + 'a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15'
      + 'a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82'
      + 'l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3'
      + 'a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83'
      + 'l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09'
      + 'a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
    gear.addEventListener("click", function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      hideStats(true);
      setPanelOpen(true);
    });

    el.appendChild(dot);
    el.appendChild(verdict);
    el.appendChild(met);
    el.appendChild(gear);
    el.addEventListener("click", function (ev) {
      if (ev.target === gear || (gear.contains && gear.contains(ev.target))) return;
      toggleStatsPinned();
    });
    el.addEventListener("mouseenter", function () {
      if (statsHideTimer) { clearTimeout(statsHideTimer); statsHideTimer = null; }
      if (statsShowTimer) clearTimeout(statsShowTimer);
      statsShowTimer = setTimeout(function () { statsShowTimer = null; showStats(); }, 120);
    });
    el.addEventListener("mouseleave", function () {
      if (statsShowTimer) { clearTimeout(statsShowTimer); statsShowTimer = null; }
      scheduleHideStats();
    });

    document.body.appendChild(el);
    return el;
  }

  // 输入框卡片。宿主会把草稿页/分屏/当前会话的 composer 同时挂在 DOM 里，
  // 只能取"真正在最上层、位于视口内"的那个：
  //   1. 设置页/弹窗里的输入框一律排除（zusage 的同款判据：settings-page 等三个根标记）；
  //   2. 有 rect 但被别的视图盖住的（elementFromPoint 命中不在自己内部）排除；
  //   3. 多个都可见时取最靠下的（聊天输入框总在视口下半部）。
  // 找不到就不显示角标——设置页/欢迎页不该出现（用户实测反馈）。
  function composerUsable(cand) {
    try {
      if (!cand || !cand.isConnected) return false;
      if (cand.closest && cand.closest(
        '[data-testid="settings-page"],[data-settings-content-frame],'
        + '[data-settings-panel-frame],[role="dialog"]')) return false;
      // 宿主的设置页是把 workspace 壳层标 inert 后盖上去，聊天 composer 仍在原坐标；
      // 只靠 settings-page 祖先判不到它，必须显式排除 inert 壳层（否则角标会浮在设置页上）。
      if (cand.closest && cand.closest('[data-root-workspace-surface="inert"],[inert]')) return false;
      if (cand.getClientRects && cand.getClientRects().length === 0) return false;
      var r = cand.getBoundingClientRect();
      if (!r || r.width < 60 || r.height < 20) return false;
      var vh = window.innerHeight || 768;
      if (r.bottom <= 0 || r.top >= vh) return false;
      if (document.elementFromPoint) {
        var vw = window.innerWidth || 1024;
        var x = Math.min(Math.max(1, r.right - 24), vw - 2);
        var y = Math.min(Math.max(1, r.top + 12), vh - 2);
        // 关键：探测点可能先命中自家浮层（角标/统计卡/设置遮罩）。
        // 若把"命中自己"当成可用，设置页/宿主弹窗盖住 composer 时永远不会隐藏。
        // 所以按层叠顺序取第一个**不属于自家浮层**的节点，再判断它在不在 composer 里。
        var ownSel = "#" + OVERLAY_ID + ",#" + STATS_ID + ",#" + PANEL_ID + ",#" + MASK_ID;
        var isOwn = function (n) {
          try { return !!(n && n.closest && n.closest(ownSel)); } catch (e) { return false; }
        };
        var hit = null;
        if (document.elementsFromPoint) {
          var stack = document.elementsFromPoint(x, y) || [];
          for (var k = 0; k < stack.length; k++) {
            if (!stack[k] || isOwn(stack[k])) continue;
            hit = stack[k];
            break;
          }
        } else {
          hit = document.elementFromPoint(x, y);
          if (isOwn(hit)) hit = null;
        }
        if (hit && !(cand.contains(hit))) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  function composerSurface() {
    try {
      var best = null, bestTop = -1;
      var list = document.querySelectorAll(".chat-composer-input-surface");
      for (var i = 0; i < list.length; i++) {
        var cand = list[i];
        if (!composerUsable(cand)) continue;
        var r = cand.getBoundingClientRect();
        if (r.top > bestTop) { bestTop = r.top; best = cand; }
      }
      if (best) return best;
      // 旧宿主没有 .chat-composer-input-surface：同样要遍历所有候选并取最靠下的
      // 可用者，只看第一个会在分屏/草稿页同时挂载时误判"没有输入框"（三审 P2）。
      var fbBest = null, fbTop = -1;
      try {
        var fbList = document.querySelectorAll('[data-testid="v4-composer"]');
        for (var j = 0; j < fbList.length; j++) {
          if (!composerUsable(fbList[j])) continue;
          var fr = fbList[j].getBoundingClientRect();
          if (fr.top > fbTop) { fbTop = fr.top; fbBest = fbList[j]; }
        }
      } catch (e2) {}
      if (fbBest) return fbBest;
      var fallback = document.querySelector('[data-testid="v4-composer"]');
      return composerUsable(fallback) ? fallback : null;
    } catch (e) { return null; }
  }

  // 角标浮在输入框**上方**（不是内侧）：内侧会压住模型选择/发送按钮等工具行，
  // 用户实测反馈遮挡视线。位置取 composer 顶边再往上让出角标高度 + 6px；
  // 上方若还有排队面板、额度横幅、恢复提示或回到最新按钮，就继续让到它们上沿。
  // 宿主重渲染可能清掉 React 子节点，所以不往里插，用 fixed + 每秒同步坐标。
  // 返回 false 表示当前没有可用输入框（设置页/被遮住）或上方没有空间，调用方应隐藏角标。
  function positionBadge() {
    var el = document.getElementById(OVERLAY_ID);
    if (!el) return false;
    // 自家设置弹窗打开时直接让位：遮罩 z-index 高于角标，继续定位只会
    // 让用户在黑色遮罩后看到一层变暗的角标（与 A8「弹窗内自动隐藏」不符）。
    if (state.panelOpen) return false;
    // v0.3.3：保护窗口内不再做 composerSurface/elementsFromPoint/多次 rect
    // 读取，避免 surfaceRO 在面板动画每一帧触发强制布局。返回当前可见性，
    // 让 renderOverlay 保持原显示状态，而不是把角标闪隐 420ms。
    var now = performance.now();
    var keepVisible = el.style.display !== "none";
    if (settings.paneSwitchGuardOn && paneGuardUntil && now < paneGuardUntil) return keepVisible;
    if (settings.refocusGuardOn && refocusBadgeUntil && now < refocusBadgeUntil) return keepVisible;
    if (settings.panelQuietOn && settings.observe && paneOpen && keepVisible) {
      // v0.3.5 O5：面板期角标最多每 3s 定位一次（比 P2 的 1.8s 更省）。
      if (paneLastBadgeAt && now - paneLastBadgeAt < PANEL_QUIET_BADGE_MS) return true;
      paneLastBadgeAt = now;
    } else if (settings.paneHoldOn && paneOpen && keepVisible) {
      if (paneLastBadgeAt && now - paneLastBadgeAt < PANE_BADGE_MIN_MS) return true;
      paneLastBadgeAt = now;
    }
    var surface = composerSurface();
    if (surface !== observedSurface) {
      observedSurface = surface;
      try { if (surfaceRO) surfaceRO.disconnect(); } catch (e) {}
      surfaceRO = null;
      if (surface && typeof ResizeObserver === "function") {
        try {
          surfaceRO = new ResizeObserver(function () { positionBadge(); });
          surfaceRO.observe(surface);
        } catch (e) {}
      }
    }
    if (!surface) return false;
    var r = surface.getBoundingClientRect();
    if (!r || r.width < 60) return false;
    // 隐藏一拍的 offsetWidth 是 0；用上一次实测宽度兜底，避免刚恢复显示时
    // 按 190 估算导致角标右侧溢出到视口外（三审 P2）。
    var w = el.offsetWidth || el.__lagfixWidth || 190;
    if (el.offsetWidth > 0) el.__lagfixWidth = el.offsetWidth;
    var vw = window.innerWidth || 1024;
    var left = Math.min(Math.max(8, r.right - w - 8), vw - w - 8);
    // 角标高度约 25px（12px 字号 + 6px 内边距 + 边框），留 26px 上限。
    // 不用 offsetHeight：隐藏时它是 0，会让"隐藏/显示"的判定自相矛盾。
    var BADGE_H = 26;
    var GAP = 6;
    var top = r.top - BADGE_H - GAP;
    // 输入框上方这条带上还可能叠着排队面板、额度横幅、待恢复提示、回到最新按钮。
    // 不写死具体 class：沿 composer 往上走到 dock 锚点，逐个检查前面的兄弟节点，
    // 任何可见、与角标水平相交、且压到角标纵向区间的块都要让开——否则角标会盖住
    // 横幅按钮并截走点击（终审 P1-1）。从近到远检查，多层横幅会逐层抬高。
    var badgeRight = left + w;
    function liftOver(node2) {
      if (!node2 || node2 === el || (node2.contains && node2.contains(el))) return null;
      // 退场中的浮层 opacity:0 仍有非零 rect；给它让位会造成位置跳动。
      try {
        var cs = window.getComputedStyle ? window.getComputedStyle(node2) : null;
        if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")) {
          return null;
        }
      } catch (e2) {}
      var nr = node2.getBoundingClientRect();
      if (!nr || nr.height <= 0 || nr.width <= 0) return null;
      if (!(nr.left < badgeRight && nr.right > left)) return null;
      if (!(nr.bottom > top && nr.top < top + BADGE_H)) return null;
      return nr.top - BADGE_H - GAP;
    }
    try {
      var dock = surface.closest && surface.closest('[data-v4-back-to-bottom-anchor="composer-dock"]');
      if (dock) {
        var dockNode = surface;
        // 只处理 dock 内部、composer 之前的兄弟节点，最多上溯 6 层；
        // 锚点自身的兄弟是整块时间线，把它算进来会把角标顶出视口。
        for (var depth = 0; dockNode && dockNode !== dock && depth < 6; depth++) {
          var sib = dockNode.previousElementSibling;
          while (sib) {
            var lifted = liftOver(sib);
            if (lifted !== null && lifted < top) top = lifted;
            sib = sib.previousElementSibling;
          }
          dockNode = dockNode.parentElement;
        }
      } else {
        // 旧版宿主没有 dock 锚点：退回只认排队面板的保守逻辑。
        // 分屏时每个 pane 各有一个队列；优先取输入框所在会话子树里的，
        // 并要求水平方向有交集，避免拿另一个 pane 的队列把角标顶走。
        var scope = (surface.closest && surface.closest('[data-session-id]')) || document;
        // 旧宿主同一会话子树可能挂着多个队列（草稿/退场层），第一个不一定可见；
        // querySelector 只看第一个会漏掉真正压住角标的那个（三审 P2）。
        var qList = [];
        try {
          if (scope.querySelectorAll) {
            qList = Array.prototype.slice.call(scope.querySelectorAll('[data-testid="v4-queue"]'));
          }
        } catch (e2) {}
        if (!qList.length && scope.querySelector) {
          var qOne = scope.querySelector('[data-testid="v4-queue"]');
          if (qOne) qList = [qOne];
        }
        for (var qi = 0; qi < qList.length; qi++) {
          var qLift = liftOver(qList[qi]);
          if (qLift !== null && qLift < top) { top = qLift; break; }
        }
      }
    } catch (e) {}
    // 上下文容量/模型菜单等宿主浮层是 body 级 portal，不在 composer 兄弟链里。
    // 与角标带相交时同样让到浮层上沿；上方没有余量就由下面的 top<8 分支隐藏。
    try {
      var pops = document.querySelectorAll(HOST_FLOATING_SEL);
      for (var pi = 0; pi < pops.length; pi++) {
        var pop = pops[pi];
        if (!pop || (pop.closest && pop.closest("#" + PANEL_ID + ",#" + STATS_ID + ",#" + MASK_ID))) continue;
        var popLift = liftOver(pop);
        if (popLift !== null && popLift < top) top = popLift;
      }
    } catch (e3) {}
    // 上方连 8px 余量都没有（队列顶到视口顶端）：宁可不显示，也不压任何控件。
    if (top < 8) return false;
    el.style.right = "auto";
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.maxWidth = Math.max(140, Math.round(r.width - 16)) + "px";
    return true;
  }

  function renderOverlay() {
    try {
      if (state.dead || !document.body) return;
      ensureStyle();
      var el = ensureBadge();

      var now = performance.now();
      var dt = lastTickAt ? (now - lastTickAt) / 1000 : 1;
      lastTickAt = now;
      var commitRate = dt > 0 ? Math.round(state.tickFrames / dt) : 0;
      state.tickFrames = 0;
      state.lastCommitRate = commitRate;
      // 后台窗口的定时器会被 Chromium 降频到 1/min，dt 巨大；此时不能把
      // "浏览器节流"误判成"主线程卡死"（切回前台会闪一下红）。
      var stallMs = document.hidden ? 0 : Math.round(dt * 1000) - OVERLAY_TICK_MS;

      var fs = frameStats();
      var rmax = recentFrameMax();
      var v = verdictOf(fs.p95, stallMs, rmax, commitRate);

      var dotEl = document.getElementById(OVERLAY_ID + "-dot");
      var vEl = document.getElementById(OVERLAY_ID + "-verdict");
      var mEl = document.getElementById(OVERLAY_ID + "-met");
      if (vEl) vEl.style.display = settings.badgeText ? "" : "none";
      if (mEl) mEl.style.display = settings.badgeText ? "" : "none";
      if (dotEl) dotEl.style.background = v.color;
      if (vEl) vEl.textContent = v.label;
      if (mEl) {
        var parts = [];
        if (!settings.observe) {
          parts.push("观测已暂停");
        } else if (settings.badgeMode === "detail") {
          // 四项都用大白话：用户看不懂"提交/长任务"这种内部指标名。
          parts.push("刷新 " + commitRate + "次/秒");
          parts.push("每帧 " + (fs.p95 === null ? "-" : fs.p95 + "ms"));
          parts.push("卡顿 " + longTaskCount + "次");
          var hp = heapMB();
          if (hp !== null) parts.push("内存 " + hp + "MB");
        } else {
          parts.push("每帧 " + (fs.p95 === null ? "-" : fs.p95 + "ms"));
          if (longTaskCount > 0) parts.push("卡顿 " + longTaskCount + "次");
          if (stallMs > 500) parts.push("画面卡住 " + stallMs + "ms");
        }
        mEl.textContent = parts.join(" · ");
      }

      // 只有主对话页且输入框可见时才显示角标；设置页/被覆盖时整条隐藏。
      // A8：角标常驻（用户不可关闭），这里只做布局性让位——
      // 不再有 badgeVisible 分支，也就没有"隐藏后找不到设置入口"的死角。
      var placed = positionBadge();
      if (el) el.style.display = placed ? "" : "none";
      if (!placed) hideStats(true);
      if (isStatsVisible()) updateStats(fs, rmax, commitRate);
      if (state.panelOpen) renderPanelStatus();
    } catch (e) { err(); }
  }

  function heapMB() {
    try {
      if (performance.memory && performance.memory.usedJSHeapSize) {
        return Math.round(performance.memory.usedJSHeapSize / 1048576);
      }
    } catch (e) {}
    return null;
  }

  // ---- 悬停统计 ----
  function isStatsVisible() {
    var el = document.getElementById(STATS_ID);
    return !!el && el.style.display !== "none";
  }

  function ensureStats() {
    var el = document.getElementById(STATS_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = STATS_ID;
    el.setAttribute("data-lagfix-stats", "1");
    el.addEventListener("mouseenter", function () {
      if (statsHideTimer) { clearTimeout(statsHideTimer); statsHideTimer = null; }
    });
    el.addEventListener("mouseleave", scheduleHideStats);
    document.body.appendChild(el);
    return el;
  }

  function scheduleHideStats() {
    if (statsPinned) return;
    if (statsHideTimer) clearTimeout(statsHideTimer);
    statsHideTimer = setTimeout(function () {
      statsHideTimer = null;
      hideStats(false);
    }, 260);
  }

  function showStats() {
    if (state.dead) return;   // 自禁用后悬停定时器可能仍在路上，别把浮层又建回来
    var el = ensureStats();
    el.style.display = "block";
    updateStats(frameStats(), recentFrameMax(), state.lastCommitRate || 0);
    positionStats();
  }

  function hideStats(force) {
    var el = document.getElementById(STATS_ID);
    if (el) el.style.display = "none";
    if (force) statsPinned = false;
    if (!statsPinned) document.removeEventListener("mousedown", statsOutside, true);
  }

  // 固定（点击打开）的统计浮层：点页面别处就收起，不需要再点一次角标。
  function statsOutside(ev) {
    var s = document.getElementById(STATS_ID);
    var b = document.getElementById(OVERLAY_ID);
    var t = ev && ev.target;
    if (s && t && s.contains(t)) return;
    if (b && t && b.contains(t)) return;
    statsPinned = false;
    hideStats(false);
  }

  function toggleStatsPinned() {
    if (statsPinned) { statsPinned = false; hideStats(true); return; }
    statsPinned = true;
    document.addEventListener("mousedown", statsOutside, true);
    showStats();
  }

  function positionStats() {
    var s = document.getElementById(STATS_ID);
    var b = document.getElementById(OVERLAY_ID);
    if (!s || !b || s.style.display === "none") return;
    var br = b.getBoundingClientRect();
    var sw = s.offsetWidth || 348;
    var sh = s.offsetHeight || 260;
    var vw = window.innerWidth || 1024;
    var vh = window.innerHeight || 768;
    var left = Math.min(Math.max(8, br.right - sw), vw - sw - 8);
    var top = br.top - sh - 8;          // 输入框在上方，默认向上展开
    if (top < 8) top = Math.min(vh - sh - 8, br.bottom + 8);
    s.style.left = Math.round(left) + "px";
    s.style.top = Math.round(Math.max(8, top)) + "px";
  }

  function updateStats(fs, rmax, commitRate) {
    var el = document.getElementById(STATS_ID);
    if (!el) return;
    var p95 = fs.p95;
    var tier = tierOf(p95);
    var color = tier ? tier.color : "#8b949e";
    var p95txt = p95 === null ? "—" : String(p95);
    var rate = commitRate || 0;

    var html = '<div class="st-hd"><span>lagfix 性能</span>'
      + '<span class="st-tier" style="color:' + color + '">' + (tier ? tier.label : "无数据") + '</span></div>'
      + '<div class="st-big"><b style="color:' + color + '">' + p95txt + '</b>'
      + '<span>ms · 每帧耗时：95% 的帧不超过这个数（越小越流畅，最近 30 秒）</span></div>'
      + '<div class="st-chart" id="' + STATS_ID + '-chart"></div>'
      + '<div class="st-peaks"><span>最差 <b id="' + STATS_ID + '-pk">—</b></span>'
      + '<span>最好 <b id="' + STATS_ID + '-lo">—</b></span>'
      + '<span>最新 <b id="' + STATS_ID + '-nw">—</b></span></div>'
      + '<div class="st-legend">';
    for (var i = 0; i < FRAME_TIERS.length; i++) {
      var t = FRAME_TIERS[i];
      var range = i === 0 ? "<" + t.max : (t.max === Infinity ? "≥" + FRAME_TIERS[i - 1].max : FRAME_TIERS[i - 1].max + "-" + t.max);
      html += '<em><i style="background:' + t.color + '"></i>' + range + " " + t.label + "</em>";
    }
    html += '</div>'
      + '<div class="st-help">每帧 = 连续两次画面更新的间隔，越大越卡；刷新 = 对话区每秒重新画几次；'
      + '卡顿 = 画面更新被卡住超过 50ms 的次数；内存 = ZCode 界面占用的内存。</div>'
      + '<div class="st-foot" id="' + STATS_ID + '-foot"></div>';
    el.innerHTML = html;

    // 柱状图：最近 18 个采集周期
    var chart = document.getElementById(STATS_ID + "-chart");
    var last = hist.slice(-18);
    var peakVal = 0;
    for (var k = 0; k < last.length; k++) if (last[k].p95 > peakVal) peakVal = last[k].p95;
    var scale = Math.max(60, peakVal || 0);
    for (var j = 0; j < 18; j++) {
      var bar = document.createElement("i");
      var item = last[j - (18 - last.length)];
      if (item) {
        var h = Math.max(3, Math.round(((item.p95 || 0) / scale) * 48));
        bar.style.height = h + "px";
        var bt = tierOf(item.p95);
        bar.style.background = bt ? bt.color : "#8b949e";
        bar.title = (item.p95 === null ? "—" : item.p95 + "ms");
      } else {
        bar.style.height = "2px";
        bar.style.background = "rgba(255,255,255,.12)";
      }
      if (chart) chart.appendChild(bar);
    }

    var pks = hist.map(function (x) { return x.p95; }).filter(function (x) { return x !== null && x !== undefined; });
    var pkEl = document.getElementById(STATS_ID + "-pk");
    var loEl = document.getElementById(STATS_ID + "-lo");
    var nwEl = document.getElementById(STATS_ID + "-nw");
    if (pkEl) pkEl.textContent = pks.length ? Math.max.apply(null, pks) + "ms" : "—";
    if (loEl) loEl.textContent = pks.length ? Math.min.apply(null, pks) + "ms" : "—";
    if (nwEl) nwEl.textContent = pks.length ? pks[pks.length - 1] + "ms" : "—";

    var foot = document.getElementById(STATS_ID + "-foot");
    if (foot) {
      var hp = heapMB();
      foot.textContent = "对话区每秒重画 " + rate + " 次 · 画面卡住超过 50ms 共 " + longTaskCount + " 次"
        + (rmax !== null ? " · 最近最差一帧 " + rmax + "ms" : "")
        + (hp !== null ? " · 内存 " + hp + "MB" : "");
    }
    positionStats();
  }

  // ---- 设置弹窗（分类式，交互参照 zusage）----
  function section(id, title, desc) {
    var s = document.createElement("section");
    s.setAttribute("data-section", id);
    var h = document.createElement("h3");
    h.textContent = title;
    var d = document.createElement("p");
    d.className = "sec-desc";
    d.textContent = desc;
    s.appendChild(h);
    s.appendChild(d);
    return s;
  }

  function card() {
    var c = document.createElement("div");
    c.className = "card";
    return c;
  }

  // info 传入时在标题后加一个"圆圈感叹号"，点开是本项的详细影响说明。
  // 用行内展开而不是浮层：面板是弹窗，浮层要自己算定位、还要处理被裁切。
  // disabled：依赖项关闭时整行变灰并禁掉控件（用户反馈：关掉节流后窗口还能改，容易误解）。
  function rowEl(label, sub, control, info, disabled) {
    var r = document.createElement("div");
    r.className = disabled ? "row off" : "row";
    var l = document.createElement("div");
    l.className = "row-main";
    var a = document.createElement("div");
    a.className = "lab";
    a.textContent = label;
    var note = null;
    if (info) {
      var q = document.createElement("button");
      q.type = "button";
      q.className = "info";
      q.textContent = "!";
      q.title = "这项会影响什么";
      q.setAttribute("aria-label", "说明：" + label);
      q.addEventListener("click", function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (note) note.style.display = note.style.display === "block" ? "none" : "block";
      });
      a.appendChild(q);
    }
    l.appendChild(a);
    if (sub) {
      var b = document.createElement("div");
      b.className = "sub";
      b.textContent = disabled ? sub + "（需要先打开「合并刷新」）" : sub;
      l.appendChild(b);
    }
    if (info) {
      note = document.createElement("div");
      note.className = "note";
      note.textContent = info;
      note.style.display = "none";
      l.appendChild(note);
    }
    var c = document.createElement("div");
    c.className = "ctl";
    c.appendChild(control);
    if (disabled && control) {
      // 控件整体禁用：标签里的 checkbox 也要真的 disabled，避免键盘/辅助技术绕过。
      try {
        control.style.opacity = "0.4";
        control.style.pointerEvents = "none";
        var ins = control.querySelectorAll ? control.querySelectorAll("input") : [];
        for (var i = 0; i < ins.length; i++) ins[i].disabled = true;
        if (control.tagName === "INPUT") control.disabled = true;
      } catch (e) {}
    }
    r.appendChild(l);
    r.appendChild(c);
    return r;
  }

  function switchEl(checked, onChange) {
    var l = document.createElement("label");
    l.className = "sw";
    var c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!checked;
    c.addEventListener("change", function () { onChange(!!c.checked); });
    var i = document.createElement("i");
    l.appendChild(c);
    l.appendChild(i);
    return l;
  }

  function numberInput(value, min, max, onChange) {
    var i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    i.addEventListener("change", function () {
      var v = clampNum(i.value, min, max, value);
      i.value = String(v);
      onChange(v);
    });
    return i;
  }

  function unit(text) {
    var s = document.createElement("span");
    s.className = "status";
    s.textContent = text;
    return s;
  }

  // 主进程把当前日志量随每个采集周期注入 window.__lagfixLogStats：
  // {bytes, files}，白名单与 sweepByBudget 一致。这里只做展示，不读文件系统。
  function fmtLogBytes(bytes) {
    var n = Math.max(0, Number(bytes) || 0);
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return "0 KB";
  }

  function refreshLogStats() {
    if (!logStatsRow) return;
    var st = null;
    try { st = window.__lagfixLogStats || null; } catch (e) {}
    if (!st || typeof st.bytes !== "number") {
      logStatsRow.textContent = "当前日志量：读取中…（主进程下次采集后显示）";
      return;
    }
    logStatsRow.textContent = "当前日志量：" + fmtLogBytes(st.bytes)
      + " / 上限 " + settings.logMaxMB + " MB"
      + " · " + (Number(st.files) || 0) + " 个文件";
  }

  function buildPanel() {
    ensureStyle();
    var mask = document.getElementById(MASK_ID);
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = document.createElement("div");
    mask.id = MASK_ID;
    mask.addEventListener("mousedown", function (ev) {
      if (ev.target === mask) setPanelOpen(false);
    });

    var p = document.createElement("div");
    p.id = PANEL_ID;
    p.setAttribute("data-lagfix-panel", "1");

    var hd = document.createElement("div");
    hd.className = "dlg-hd";
    var title = document.createElement("div");
    title.textContent = "zcode-lagfix 设置";
    var sm = document.createElement("small");
    sm.textContent = "v" + VERSION;
    title.appendChild(sm);
    var close = document.createElement("button");
    close.className = "dlg-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("click", function () { setPanelOpen(false); });
    hd.appendChild(title);
    hd.appendChild(close);

    var body = document.createElement("div");
    body.className = "dlg-body";
    var nav = document.createElement("div");
    nav.className = "dlg-nav";
    var content = document.createElement("div");
    content.className = "dlg-content";

    var NAV = [
      { id: "status", label: "状态条" },
      { id: "observe", label: "观测" },
      { id: "fix", label: "性能" },
      { id: "maint", label: "维护" },
    ];
    var sections = {};

    // --- 状态条 ---
    var sStatus = section("status", "状态条",
      "状态条常驻显示，没有关闭入口；在设置页、弹窗或被遮挡时会自动隐藏。"
      + "鼠标悬停看统计，点齿轮回到这里。");
    var c1 = card();
    c1.appendChild(rowEl("显示文字", "关掉只留一个颜色圆点，几乎不占位置。",
      switchEl(settings.badgeText, function (v) {
        settings.badgeText = v; saveSettings(); renderOverlay();
      })));
    c1.appendChild(rowEl("信息量", "简洁只显示结论、每帧耗时和卡顿次数；详细会多显示刷新次数和内存占用。",
      (function () {
        var g = document.createElement("div");
        g.className = "seg";
        var modes = [["simple", "简洁"], ["detail", "详细"]];
        modes.forEach(function (m) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = m[1];
          if (settings.badgeMode === m[0]) b.className = "on";
          b.addEventListener("click", function () {
            settings.badgeMode = m[0]; saveSettings(); rebuildPanel(); renderOverlay();
          });
          g.appendChild(b);
        });
        return g;
      })()));
    c1.appendChild(rowEl("警告阈值", "把最近 30 秒的帧按快慢排队，最慢的 5% 超过这个数时标黄。50ms 起就能看出不流畅。",
      (function () {
        var w = document.createElement("div");
        w.className = "ctl";
        w.appendChild(numberInput(settings.warnMs, 1, 5000, function (v) {
          settings.warnMs = v;
          if (settings.badMs <= settings.warnMs) settings.badMs = settings.warnMs + 1;
          saveSettings(); rebuildPanel(); renderOverlay();
        }));
        w.appendChild(unit("ms"));
        return w;
      })()));
    c1.appendChild(rowEl("严重阈值", "最慢的 5% 超过这个数时标红。100ms 以上是明显卡顿。",
      (function () {
        var w = document.createElement("div");
        w.className = "ctl";
        w.appendChild(numberInput(settings.badMs, 2, 10000, function (v) {
          settings.badMs = Math.max(v, settings.warnMs + 1);
          saveSettings(); renderOverlay();
        }));
        w.appendChild(unit("ms"));
        return w;
      })()));
    sStatus.appendChild(c1);
    sections.status = sStatus;

    // --- 观测 ---
    var sObs = section("observe", "观测",
      "只记录数据，不会改变 ZCode 的行为。记录保存在插件自己的数据文件夹里（路径见「维护」页）。");
    var c2 = card();
    c2.appendChild(rowEl("开启观测", "关闭后不再记录每帧耗时和卡顿，角标会变灰。",
      switchEl(settings.observe, function (v) { setObserving(v); rebuildPanel(); })));
    var sel = document.createElement("select");
    var secs = [1, 3, 5, 10, 30];
    if (secs.indexOf(settings.collectSec) < 0) secs.push(settings.collectSec);
    secs.sort(function (a, b) { return a - b; });
    secs.forEach(function (sec) {
      var o = document.createElement("option");
      o.value = String(sec);
      o.textContent = sec + " 秒";
      if (settings.collectSec === sec) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      settings.collectSec = clampNum(sel.value, 1, 120, DEFAULTS.collectSec);
      saveSettings();
    });
    c2.appendChild(rowEl("采集间隔", "多久保存一次数据。越短越详细，日志也越大。", sel));
    sObs.appendChild(c2);

    var capDiag = document.createElement("div");
    capDiag.className = "cap";
    capDiag.textContent = "诊断";
    sObs.appendChild(capDiag);
    var c2b = card();
    c2b.appendChild(rowEl("滚动诊断", "记录滚动是否流畅、加载更早消息的次数和耗时、已显示的消息轮数与页面元素数量。",
      switchEl(settings.scrollDiagOn, function (v) {
        settings.scrollDiagOn = v; saveSettings(); applyScrollSettings();
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：只记录——滚动聊天区时画面是否流畅、上翻加载更早消息用了几次和多久、"
      + "当前显示了多少轮消息、页面元素有多少。\n"
      + "不会做什么：不改变滚动、加载时机、每页消息数或任何消息内容。关掉后不再记录这些数据，"
      + "也不会额外检查页面元素。"));
    c2b.appendChild(rowEl("输入延迟", "按下按键到画面更新的时间，用来看输入框跟不跟手。",
      switchEl(settings.inputLagOn, function (v) {
        settings.inputLagOn = v; saveSettings(); applyScrollSettings(); rebuildPanel();
      }),
      "会做什么：只记录在输入框里按下按键到画面更新用了多久，用来判断输入卡不卡。\n"
      + "不会做什么：不改输入内容、快捷键、菜单选择，也不会让输入变快；它只负责测量。关掉后不再记录。"));
    c2b.appendChild(rowEl("多会话分别统计", "按会话分别记录刷新次数、页面元素数量、已显示的消息轮数和滚动流畅度。",
      switchEl(settings.sessionDiagOn, function (v) {
        settings.sessionDiagOn = v; saveSettings(); applySessionSettings();
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：只记录每个会话的画面刷新次数、页面元素数量、已显示的消息轮数和滚动是否流畅；"
      + "后台会话也会记录，并标注为不可见。最多同时保留 5 个会话，更多会话要有新动静才会替换最久没动静的那个。\n"
      + "不会做什么：不读消息内容，不改会话数据，也不改变加载和显示方式。关掉后不再分别统计，"
      + "也不再逐个检查会话窗口。"));
    c2b.appendChild(rowEl("卡顿来源定位", "画面卡住超过 100 毫秒时，记下当时最耗时的几段界面工作来自哪里。",
      switchEl(settings.lafDiagOn, function (v) {
        settings.lafDiagOn = v; saveSettings(); applyScrollSettings(); rebuildPanel();
      }),
      "会做什么：画面一次卡住超过 100 毫秒时，记录这次卡了多久、其中排版占了多少，"
      + "以及当时最耗时的几段界面工作出自哪个脚本文件，最多保留最近 10 次。用来回答「卡的时候到底在忙什么」。\n"
      + "不会做什么：不读对话内容，不改任何数据，也不让画面变快。记录里只有脚本文件名和时间，没有路径和内容。\n"
      + "代价：极低，只在卡顿发生的那一下多记几条统计。"));
    c2b.appendChild(rowEl("卡顿来源细分", "在卡顿记录里补上距上次刷新、滚动、消息更新的时间，用来判断卡顿由哪类操作引起。",
      switchEl(settings.lafCtxOn, function (v) {
        settings.lafCtxOn = v; saveSettings(); applyScrollSettings(); rebuildPanel();
      }),
      "会做什么：每次画面卡住超过 100 毫秒时，额外记下它距离上一次画面刷新、聊天区滚动、消息更新各有多久，"
      + "并把这次卡顿归到「刷新合并」「滚动」「通知」或「其它」四类之一，方便判断下一步该优化哪里。\n"
      + "不会做什么：不读对话内容，不改数据，也不让画面变快；只在上面的「卡顿来源定位」已开启时生效。\n"
      + "代价：极低，只多记几个时间差。"));
    sObs.appendChild(c2b);
    sections.observe = sObs;

    // --- 性能 ---
    var sFix = section("fix", "性能",
      "减少回答输出、加载长历史、滚动和打开右侧面板时的卡顿。每项只改变刷新或加载的时机，"
      + "不改消息内容，也不影响工具执行。点标题后的「!」可以看它会做什么、不会做什么。");
    var capThrottle = document.createElement("div");
    capThrottle.className = "cap";
    capThrottle.textContent = "刷新";
    sFix.appendChild(capThrottle);
    var c3 = card();
    c3.appendChild(rowEl("合并刷新", "把 ZCode 短时间内连续发来的刷新通知合并成一次。",
      switchEl(settings.throttleOn, function (v) {
        settings.throttleOn = v;
        saveSettings();
        if (v) applyThrottle(); else releaseThrottle();
        rebuildPanel(); renderOverlay();
      }),
      "会做什么：ZCode 在很短时间内连续要求刷新时，只真正刷新一次，其余合并到下一次。"
      + "回答逐字输出、工具状态变化时，画面最多晚一个刷新间隔。\n"
      + "不会做什么：不改消息内容、会话数据、工具执行或任务队列。关掉后立刻恢复 ZCode 原本的刷新频率。"));
    var tw = document.createElement("div");
    tw.className = "ctl";
    tw.appendChild(numberInput(settings.throttleMs, 30, 1000, function (v) {
      settings.throttleMs = v;
      saveSettings();
      renderPanelStatus();
    }));
    tw.appendChild(unit("ms"));
    c3.appendChild(rowEl("最短刷新间隔", "两次刷新至少隔多久。调大更省 CPU，但文字更新会慢一点；面板常开时实际至少 300ms。", tw,
      "会做什么：控制两次刷新之间至少隔多久。调大：刷新更少、更省 CPU，但文字更新会一顿一顿；"
      + "调小：更跟手，但回答输出时刷新更频繁。\n"
      + "不会做什么：不影响回复接收、消息保存和工具执行，只决定画面什么时候更新。",
      !settings.throttleOn));
    var fixStatus = document.createElement("div");
    fixStatus.className = "status";
    fixStatus.id = PANEL_ID + "-fixstatus";
    c3.appendChild(fixStatus);
    sFix.appendChild(c3);

    var c3b = card();
    c3b.appendChild(rowEl("卡顿时自动放慢", "画面变卡时自动把刷新间隔加到 200–300ms，恢复后再降回来。",
      switchEl(settings.adaptiveOn, function (v) {
        settings.adaptiveOn = v; saveSettings(); rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：最近画面明显变卡时，自动把刷新间隔临时拉长到 200–300ms；画面恢复后自动回到"
      + "「最短刷新间隔」里的值。卡的时候少画几帧，把资源让给输入和画面排版。\n"
      + "不会做什么：不改数据或会话状态，也不会改掉你自己设的「最短刷新间隔」。画面流畅时它完全不介入。",
      !settings.throttleOn));
    c3b.appendChild(rowEl("切换会话时放慢", "刚切换会话的 10 秒内，刷新间隔至少 250ms，不和首屏加载抢资源。",
      switchEl(settings.switchGuardOn, function (v) {
        settings.switchGuardOn = v; saveSettings(); rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：切换或新建会话后的 10 秒内，刷新间隔不低于 250ms。这段时间 ZCode 正在加载历史消息和排版，"
      + "少刷新几次能缩短白屏和输入卡顿。10 秒后自动恢复。\n"
      + "不会做什么：不改变会话切换本身，也不影响消息加载。\n"
      + "代价：切到小会话时，前 10 秒画面更新会稍慢。",
      !settings.throttleOn));
    c3b.appendChild(rowEl("后台时减少刷新", "ZCode 在后台时最多每秒刷新一次，切回来会立刻补上。",
      switchEl(settings.hiddenSkipOn, function (v) {
        settings.hiddenSkipOn = v; saveSettings(); rebuildPanel();
      }),
      "会做什么：ZCode 窗口不在前台（最小化、被别的应用盖住）时，最多每秒刷新一次，省下看不见的刷新和 CPU。\n"
      + "不会做什么：不影响回复接收、工具执行和日志记录；切回前台会马上刷新到最新状态，不会漏消息。",
      !settings.throttleOn));
    sFix.appendChild(c3b);

    var capHistory = document.createElement("div");
    capHistory.className = "cap";
    capHistory.textContent = "历史";
    sFix.appendChild(capHistory);
    var c3c = card();
    c3c.appendChild(rowEl("大历史会话保护", "超过 800 行的会话不再一次性加载全部历史；分享时会自动放行。",
      switchEl(settings.bigSessionOn, function (v) {
        settings.bigSessionOn = v; saveSettings();
        if (v) {
          bigBlockedMark = bigBlocked;   // 新一轮保护：只统计本轮是否真的拦过
          applyThrottle();
        } else {
          releaseLoadAllGuard();
          // 只有本轮真的拦过才补拉：否则用户只是关个开关，低行数会话或被拦前
          // 就没请求过的会话会被平白全量补拉一次（正是这个开关想避免的长任务）。
          if (bigBlocked !== bigBlockedMark) resumeFullHistory();
        }
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：会话超过 800 行且只加载了一部分时，阻止 ZCode 一次性把全部历史拉进来"
      + "（例如打开问题导航、分享前补目录）。大会话打开时不会再突然显示几千行。\n"
      + "不会做什么：正常上翻加载更早消息不受影响，当前看到的和正在运行的回复也不受影响。"
      + "打开分享面板、选中或复制时会自动放行，分享照常。\n"
      + "代价：大会话的问题导航只包含已经加载的部分。和「合并刷新」互不影响："
      + "即使合并刷新关掉，这一项仍然生效。"));
    sFix.appendChild(c3c);

    var capScroll = document.createElement("div");
    capScroll.className = "cap";
    capScroll.textContent = "滚动";
    sFix.appendChild(capScroll);
    var c3d = card();
    c3d.appendChild(rowEl("滚动时去掉渐隐", "滚动聊天区时暂时去掉上下边缘的渐隐，停止 180ms 后恢复。",
      switchEl(settings.maskOffOnScroll, function (v) {
        settings.maskOffOnScroll = v; saveSettings(); applyScrollSettings(); rebuildPanel();
      }),
      "会做什么：滚动聊天区时，暂时去掉消息上下边缘的渐隐；停止滚动 180ms 后自动恢复。"
      + "只改变画面效果，不改变消息位置和高度。\n"
      + "不会做什么：不影响消息内容、滚动位置和滚动条，也不改任何会话数据。\n"
      + "注意：这项依赖 ZCode 当前使用的渐隐实现；如果以后 ZCode 改了写法，这一项会失效，"
      + "届时滚动流畅度不会改善。"));
    sFix.appendChild(c3d);

    var capPane = document.createElement("div");
    capPane.className = "cap";
    capPane.textContent = "侧栏与回前台";
    sFix.appendChild(capPane);
    var c3e = card();
    c3e.appendChild(rowEl("侧栏与回前台统计", "记录侧栏开合次数、开合时的流畅度、面板宽度，以及切回 ZCode 后的卡顿。",
      switchEl(settings.paneDiagOn, function (v) {
        settings.paneDiagOn = v; saveSettings(); applyPaneSettings();
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：只记录侧栏打开/收起过几次、开合后画面是否流畅、面板有多宽；"
      + "从别的应用切回 ZCode 前在后台待了多久、切回后画面是否流畅、积压的刷新合并了几次。\n"
      + "不会做什么：不改变面板内容、开合方式、消息或会话数据。关掉后不再记录这两组数据；"
      + "如果下面的保护还开着，只会保留判断开合所需的最小信息。"));
    c3e.appendChild(rowEl("侧栏开合保护", "开合后的 420ms 内取消面板滑动动画和聊天区上下边缘的渐隐，并暂停移动角标。",
      switchEl(settings.paneSwitchGuardOn, function (v) {
        settings.paneSwitchGuardOn = v; saveSettings(); applyPaneSettings();
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：你点开或点关右侧面板后的 420ms 内（拖动边框只改宽度，不算开合），"
      + "面板直接出现或消失，不再做 200ms 滑动；聊天区上下边缘的渐隐暂时去掉；"
      + "角标停在原地不动。420ms 后自动恢复。\n"
      + "不会做什么：不改变面板宽度、内容、滚动位置或会话数据。\n"
      + "代价：开合少了滑动感；不想要就关掉这一项，其它三项仍可用。"));
    c3e.appendChild(rowEl("面板常开保护", "面板开着时取消聊天区渐隐，刷新间隔至少 300ms，角标最多每 1.8 秒移动一次。",
      switchEl(settings.paneHoldOn, function (v) {
        settings.paneHoldOn = v; saveSettings(); applyPaneSettings();
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：右侧面板保持打开时，聊天区去掉上下渐隐，刷新间隔不低于 300ms，"
      + "角标最多每 1.8 秒移动一次。面板一关就恢复原样。\n"
      + "不会做什么：不影响回复接收、工具执行、消息保存和面板内容。\n"
      + "代价：聊天文字最多晚 300ms 更新。"));
    c3e.appendChild(rowEl("回前台保护", "切回 ZCode 时把积压的刷新合并成一次，前 700ms 放慢刷新。",
      switchEl(settings.refocusGuardOn, function (v) {
        settings.refocusGuardOn = v; saveSettings(); applyPaneSettings();
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：从别的应用切回 ZCode（或标签页重新可见）时，把后台期间积压的刷新合并成一次，"
      + "700ms 内刷新间隔不低于 400ms，前 300ms 不移动角标。\n"
      + "不会做什么：不拦截 ZCode 自己的回前台刷新，也不影响回复接收和消息状态。\n"
      + "代价：画面最多晚 120ms 追上最新状态。"));
    sFix.appendChild(c3e);

    // v0.3.4：两个实验缓解默认关闭，A/B 达标后才考虑进默认路径（见 docs/specs）。
    var capExp = document.createElement("div");
    capExp.className = "cap";
    capExp.textContent = "实验（默认关闭）";
    sFix.appendChild(capExp);
    var c3f = card();
    c3f.appendChild(rowEl("大会话翻页降频 · 实验", "在很长的会话里快速上翻时，放慢自动加载更早消息的频率。",
      switchEl(settings.loadOlderPaceOn, function (v) {
        settings.loadOlderPaceOn = v; saveSettings(); applyScrollSettings();
        if (v) { try { applyThrottle(); } catch (e) {} }
        rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：会话已显示的消息超过约 3000 行时，上翻触发的自动加载至少间隔 600ms 一次，"
      + "避免一次卡 1–2 秒的长加载扎堆。\n"
      + "不会做什么：只影响滚动引起的加载，ZCode 自己为保证消息完整而发起的补齐不受影响；不丢消息、不改消息内容，也不改变每页条数；被放过的加载会在你继续滚动时自动补上。\n"
      + "代价：快速上翻时更早的历史可能晚一点出现；如果停在半路不再滚动，需要再滚一下才会继续加载。\n"
      + "说明：ZCode 每次加载本身的耗时（随会话总长度增长）这项降不了，它只减少加载的次数。"));
    c3f.appendChild(rowEl("长回合渲染减负 · 实验", "让画面外的长消息块暂时不参与绘制，滚回附近再恢复绘制。",
      switchEl(settings.turnContentVisOn, function (v) {
        settings.turnContentVisOn = v; saveSettings(); syncCvAttr(); rebuildPanel();
      }),
      "会做什么：一段消息超出画面很远时，浏览器暂时跳过它的绘制；滚回附近自动恢复。"
      + "正在生成的回复不受影响。\n"
      + "不会做什么：不折叠、不隐藏、不删任何内容；滚到哪里内容都在，搜索和选中也不受影响。\n"
      + "代价：一段很长的历史第一次滚到时，没绘制过的消息块可能有一次较明显的跳动（之后不再出现）。"));
    c3f.appendChild(rowEl("面板常开时进一步合并 · 实验", "面板打开时把刷新间隔至少放到 400ms、角标最多每 3 秒移动一次。",
      switchEl(settings.panelQuietOn, function (v) {
        settings.panelQuietOn = v; saveSettings(); applyPaneSettings(); rebuildPanel(); renderPanelStatus();
      }),
      "会做什么：右侧面板保持打开时，聊天区的刷新间隔取「你设置的最短刷新间隔」与 400ms 的较大者，"
      + "角标最多每 3 秒同步一次位置。面板关闭后，之后的通知立即回到基础刷新间隔（默认 120ms，可在上方调整）。\n"
      + "不会做什么：不改变面板内容、滚动位置、消息数据或工具执行；不新增任何页面上的标记。\n"
      + "代价：面板常开时聊天文字可能更晚更新（至少 400ms 一次），角标位置更新更慢。\n"
      + "说明：这是一项实验，需要实际对比开/关的卡顿数据；没有明显改善就保持关闭。"));
    sFix.appendChild(c3f);
    sections.fix = sFix;

    // --- 维护 ---
    var sM = section("maint", "维护", "重启、更新与版本信息。");
    var c4 = card();
    var rz = document.createElement("button");
    rz.type = "button";
    rz.className = "act";
    rz.textContent = "重启 ZCode";
    rz.title = "完全退出并重新打开 ZCode（让新补丁/新版本生效）";
    var armedAt = 0;
    var disarmTimer = null;
    rz.addEventListener("click", function () {
      var now = Date.now();
      if (!armedAt || now - armedAt > 5000) {
        armedAt = now;
        rz.textContent = "确认重启？（5 秒内再点一次）";
        if (disarmTimer) clearTimeout(disarmTimer);
        disarmTimer = setTimeout(function () {
          disarmTimer = null;
          armedAt = 0;
          rz.textContent = "重启 ZCode";
        }, 5200);
        return;
      }
      if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; }
      armedAt = 0;
      // 只置内存标记：随下一次采集回传给主进程，由 app.relaunch() 执行。
      // 不写 localStorage —— 进程重启后标记自然消失，不会无限重启。
      state.restartRequested = true;
      rz.disabled = true;
      rz.textContent = "已请求重启，正在等待 ZCode 响应…";
      renderPanelStatus();
      setTimeout(function () {
        if (!rz.parentNode || !state.restartRequested) return;
        rz.disabled = false;
        rz.textContent = "重启 ZCode（上次未生效，可再试）";
        rz.title = "重启请求可能没送达（到日志文件夹看 main.log），可以再点一次";
      }, 60000);
    });
    c4.appendChild(rowEl("重启 ZCode", "ZCode 清理超过 15 秒才会强制结束；这次请求不会被保存。", rz));
    var up = document.createElement("button");
    up.type = "button";
    up.className = "act";
    up.textContent = "检查更新";
    up.title = "只在点击后请求一次 GitHub Releases，不发送任何本机数据";
    up.addEventListener("click", function () {
      var now = Date.now();
      if (now - lastUpdateAskAt < 5000) return;   // 防误连点
      lastUpdateAskAt = now;
      state.updateCheckRequested = true;
      up.disabled = true;
      up.textContent = "检查中…";
      renderUpdateStatus();
      // 主进程下一个采集周期（默认 ≤5s）发出请求；15s 仍无结果就恢复按钮，
      // 避免永久卡在「检查中」（结果到了仍会显示）。
      setTimeout(function () {
        if (!up.parentNode) return;
        up.disabled = false;
        up.textContent = "检查更新";
      }, 15000);
    });
    c4.appendChild(rowEl("检查更新", "只在点击后检查一次；不自动联网，不上报任何本机数据。", up));

    var upLine = document.createElement("div");
    upLine.className = "status";
    upLine.id = PANEL_ID + "-updatestatus";
    c4.appendChild(upLine);

    var upCopy = document.createElement("button");
    upCopy.type = "button";
    upCopy.className = "act";
    upCopy.textContent = "复制安装口令";
    upCopy.title = "复制升级用的安装口令，发给 ZCode 执行";
    upCopy.addEventListener("click", function () {
      var text = "请安装或更新并启用 ZCode 插件：https://github.com/ck-ys/zcode-lagfix#plugin-releases\n"
        + "完成后在新会话里执行 /lagfix install，确认补丁已注入；成功后提醒我完全退出并重新打开 ZCode"
        + "（仅关闭窗口不算），不要自动重启。";
      var restore = function (label) {
        upCopy.textContent = label;
        setTimeout(function () { upCopy.textContent = "复制安装口令"; }, 1500);
      };
      try {
        var p = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text) : null;
        if (p && typeof p.then === "function") {
          // writeText 是异步的：失败时不能还显示「已复制」。
          p.then(function () { restore("已复制"); })
            .catch(function () { restore("复制失败"); });
        } else {
          restore("复制失败");
        }
      } catch (e) {
        restore("复制失败");
      }
    });
    var upCtl = document.createElement("div");
    upCtl.className = "ctl";
    upCtl.appendChild(upCopy);
    c4.appendChild(rowEl("升级方式", "复制口令发给 ZCode 即可；不会自动下载或安装。", upCtl));
    // 日志位置与预算：路径由主进程注入（window.__lagfixDataDir），
    // 上限随采集 payload 回传，由主进程执行删除/滚动。
    var dataDir = "~/.zcode/zcode-lagfix";
    try { dataDir = window.__lagfixDataDir || dataDir; } catch (e) {}
    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "act";
    copyBtn.textContent = "复制路径";
    copyBtn.addEventListener("click", function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(dataDir);
        }
        copyBtn.textContent = "已复制";
        setTimeout(function () { copyBtn.textContent = "复制路径"; }, 1500);
      } catch (e) {}
    });
    var logCtl = document.createElement("div");
    logCtl.className = "ctl";
    logCtl.appendChild(copyBtn);
    c4.appendChild(rowEl("日志存储路径", "观测记录和运行日志都在这个文件夹。", logCtl));
    var logPathRow = document.createElement("div");
    logPathRow.className = "status";
    logPathRow.style.marginTop = "2px";
    logPathRow.textContent = dataDir;
    c4.appendChild(logPathRow);

    logStatsRow = document.createElement("div");
    logStatsRow.className = "status";
    logStatsRow.style.marginTop = "2px";
    c4.appendChild(logStatsRow);
    refreshLogStats();

    var logSel = document.createElement("select");
    var sizes = [20, 50, 100, 200];
    if (sizes.indexOf(settings.logMaxMB) < 0) sizes.push(settings.logMaxMB);
    sizes.sort(function (a, b) { return a - b; });
    sizes.forEach(function (mb) {
      var o = document.createElement("option");
      o.value = String(mb);
      o.textContent = mb + " MB";
      if (settings.logMaxMB === mb) o.selected = true;
      logSel.appendChild(o);
    });
    logSel.addEventListener("change", function () {
      settings.logMaxMB = clampNum(logSel.value, 5, 1000, DEFAULTS.logMaxMB);
      saveSettings();
      refreshLogStats();   // 上限文案立即跟上，不用关面板重开
    });
    c4.appendChild(rowEl("日志上限", "超过上限后自动删最旧的日志；今天正在写的文件会先分段保存再删旧段。", logSel));

    var verEl = document.createElement("span");
    verEl.className = "ver";
    verEl.textContent = "v" + VERSION;
    c4.appendChild(rowEl("版本",
      "只在本机记录和缓解卡顿；不修改会话内容，不联网上报。", verEl));
    sM.appendChild(c4);

    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "act";
    reset.textContent = "恢复默认";
    reset.addEventListener("click", function () {
      for (var k in DEFAULTS) settings[k] = DEFAULTS[k];
      saveSettings();
      releaseThrottle();
      applyThrottle();
      applyScrollSettings();   // 三个新开关也要回到默认并重新应用
      applyPaneSettings();     // v0.3.3 侧栏/回前台四项
      rebuildPanel();
      setObserving(settings.observe);
      renderOverlay();
    });
    sM.appendChild(reset);
    sections.maint = sM;

    NAV.forEach(function (n) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = n.label;
      b.setAttribute("data-nav", n.id);
      if (panelNav === n.id) b.className = "on";
      b.addEventListener("click", function () { switchNav(n.id); });
      nav.appendChild(b);
      content.appendChild(sections[n.id]);
    });

    var ft = document.createElement("div");
    ft.className = "dlg-ft";
    var ftL = document.createElement("span");
    ftL.textContent = "设置修改后自动保存";
    ft.appendChild(ftL);
    var ftR = document.createElement("span");
    ftR.textContent = "zcode-lagfix";
    ft.appendChild(ftR);

    p.appendChild(hd);
    p.appendChild(body);
    body.appendChild(nav);
    body.appendChild(content);
    p.appendChild(ft);
    mask.appendChild(p);
    document.body.appendChild(mask);
    switchNav(panelNav);
    return p;
  }

  function switchNav(id) {
    panelNav = id;
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    try {
      var navs = p.querySelectorAll("[data-nav]");
      for (var i = 0; i < navs.length; i++) {
        var on = navs[i].getAttribute("data-nav") === id;
        navs[i].className = on ? "on" : "";
      }
      var secs = p.querySelectorAll("[data-section]");
      for (var j = 0; j < secs.length; j++) {
        secs[j].style.display = secs[j].getAttribute("data-section") === id ? "block" : "none";
      }
    } catch (e) {}
  }

  function rebuildPanel() {
    if (!state.panelOpen) return;
    // setPanelOpen(true) 内部已按当前设置 buildPanel 并 renderPanelStatus；
    // 这里不要再单独 build 一次（v0.3.0 初版每次改开关都构建两遍、白丢一次 DOM）。
    setPanelOpen(true);
  }

  // 「检查更新」结果由主进程注入 window.__lagfixUpdate（本机不读网络）。
  // 主进程只在收到 updateCheck=1 的样本后写一次；这里只负责展示。
  function markUpdateRequestSent() {
    state.updateCheckWaiting = true;
    state.updateCheckSentAt = Date.now();
  }

  function renderUpdateStatus() {
    var el = document.getElementById(PANEL_ID + "-updatestatus");
    if (!el) return;
    var u = null;
    try { u = window.__lagfixUpdate || null; } catch (e) {}
    // 请求已随样本发出、主进程结果还没注入时，继续显示「正在检查」。
    // 结果以 __lagfixUpdate.at 为准；15s 兜底避免主进程异常时永远停在检查中。
    if (state.updateCheckWaiting) {
      var gotResult = u && typeof u === "object"
        && typeof u.at === "number" && u.at >= state.updateCheckSentAt;
      if (gotResult || Date.now() - state.updateCheckSentAt > 15000) {
        state.updateCheckWaiting = false;
      }
    }
    // 「正在检查」优先：第二次点击时不能还显示上一次的结论。
    if (state.updateCheckRequested || state.updateCheckWaiting) {
      el.textContent = "正在检查…（主进程下一个采集周期发出请求）";
      return;
    }
    if (!u || typeof u !== "object") {
      el.textContent = "尚未检查。点击「检查更新」会请求一次 GitHub Releases。";
      return;
    }
    if (u.status === "ok") {
      el.textContent = u.newer
        ? "发现新版本 v" + u.latest + "（当前 v" + u.current + "）。用下方「复制安装口令」升级。"
        : "已是最新（v" + u.current + "）。";
      return;
    }
    el.textContent = "检查失败：" + (u.message || "未知原因");
  }

  function renderPanelStatus() {
    renderUpdateStatus();
    var s = document.getElementById(PANEL_ID + "-fixstatus");
    if (!s) return;
    try {
      var fs = frameStats();
      var f = fixState;
      var line = f.applied
        ? "合并刷新：已生效（你设 " + settings.throttleMs + "ms / 实际 "
          + (state.lastEffMs || settings.throttleMs) + "ms，已合并 " + throttleHits + " 次）"
        : (settings.throttleOn
            ? "合并刷新：还没生效（" + (f.reason || "等 ZCode 的会话加载好") + "）"
            : "合并刷新：已关闭");
      var bigLine = settings.bigSessionOn
        ? "大历史会话保护：" + (f.loadTarget ? "已生效" : "等待生效")
          + "（拦下 " + bigBlocked + " 次一次性加载全部历史）"
        : "大历史会话保护：已关闭";
      s.textContent = "会话 " + (state.sid ? state.sid.slice(0, 12) : "未挂载")
        + " · 已记录 " + fs.n + " 次画面更新 · 画面卡住超过 50ms " + longTaskCount + " 次 · "
        + line + " · " + bigLine
        + (state.restartRequested ? " · 重启已请求，最多 " + settings.collectSec + "s 后执行" : "")
        + (saveFailed ? " · ⚠ 设置未能写入本地存储（仅本次生效）" : "");
    } catch (e) {}
  }

  function setPanelOpen(open) {
    state.panelOpen = !!open;
    var mask = document.getElementById(MASK_ID);
    if (open) {
      // 每次打开都按当前设置重建：面板关着时可能被 storage 事件 / 控制台 __lagfixOff
      // 改过设置，复用旧 DOM 会显示过期的开关状态（用户实测：关掉节流后窗口没变灰）。
      buildPanel();
      var mask2 = document.getElementById(MASK_ID);
      if (mask2) mask2.style.display = "flex";
      hideStats(true);
      if (!uiBound) {
        uiBound = true;
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("mousedown", onDocDown, true);
      }
      renderPanelStatus();
    } else {
      if (mask) mask.style.display = "none";
      // 弹窗期间 positionBadge 早退、角标被隐藏；关窗后立即允许下一次定位，
      // 不被面板常开期的 1.8s 配额多压最多 2 秒。
      paneLastBadgeAt = 0;
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKeydown, true);
      uiBound = false;
    }
  }

  function onKeydown(ev) {
    if (ev && ev.key === "Escape") {
      if (state.panelOpen) {
        // 只有焦点确实在弹窗里才吞掉 Esc，宿主输入框/弹窗的 Esc 必须照常传下去
        try {
          var p = document.getElementById(PANEL_ID);
          if (p && ev.target && p.contains(ev.target)) ev.stopPropagation();
        } catch (e) {}
        setPanelOpen(false);
        return;
      }
      if (isStatsVisible()) {
        ev.stopPropagation();
        hideStats(true);
      }
    }
  }

  function onDocDown(ev) {
    try {
      var p = document.getElementById(PANEL_ID);
      var m = document.getElementById(MASK_ID);
      var t = ev && ev.target;
      if (!state.panelOpen) return;
      if (p && t && p.contains(t)) return;
      if (m && t && m.contains(t)) return;
      setPanelOpen(false);
    } catch (e) {}
  }

  // ---- v0.2 修复：投影订阅通知节流 ----
  // 为什么有效：宿主每 ~30ms 提交一次投影并通知所有订阅者，React 在
  // useSyncExternalStore 的回调里整树重渲染 → 主线程被切碎（实测 34 次长任务/5s）。
  // 这里只把「通知」合并成最多 1/120ms 一次，状态本身照常写入 store；
  // 采用 trailing 必达（不是 debounce）：持续流式时也不会一直不刷新。
  function looksLikeStore(o) {
    // 注意 typeof === "function"：zustand 的 create() 返回的是**函数**（带
    // getState/subscribe 属性），只认 object 会把主 store 直接漏掉。
    return !!o && (typeof o === "object" || typeof o === "function")
      && typeof o.subscribe === "function"
      && (typeof o.getSnapshot === "function" || typeof o.getState === "function");
  }

  // 真实宿主并不把 store 放在 memoizedProps 顶层，而是挂在 hook 状态里
  // （实测链路 binding.lease.store）。所以按已知字段名做有限深度搜索，
  // 而不是只看一层。
  var STORE_HINTS = ["store", "lease", "binding", "projectionStore", "conversationStore", "bundle", "value"];

  // depth<=3 + 全局预算：既够走 binding.lease.store，又不会沿对象图跑飞。
  function searchStore(root, depth, box) {
    if (!root || (typeof root !== "object" && typeof root !== "function")) return null;
    if (depth > 3 || box.budget <= 0) return null;
    box.budget--;
    if (looksLikeStore(root)) return root;
    for (var i = 0; i < STORE_HINTS.length; i++) {
      var v;
      try { v = root[STORE_HINTS[i]]; } catch (e) { continue; }
      if (!v || (typeof v !== "object" && typeof v !== "function")) continue;
      var hit = searchStore(v, depth + 1, box);
      if (hit) return hit;
    }
    return null;
  }

  // 从锚点元素的 React fiber 向上找 store 实例（Zustand 风格：{subscribe,getSnapshot}）。
  // 只读遍历，不修改任何对象；找不到就返回 null，功能降级为"不可用"。
  function findStoreFrom(el) {
    try {
      if (!el) return null;
      var key = null;
      for (var k in el) {
        if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
          key = k;
          break;
        }
      }
      if (!key) return null;
      var fiber = el[key];
      var box = { budget: 6000 };
      for (var depth = 0; fiber && depth < 50 && box.budget > 0; depth++) {
        var hit = null;
        var props = null, ms = null;
        try { props = fiber.memoizedProps; } catch (e) {}
        try { ms = fiber.memoizedState; } catch (e) {}
        hit = searchStore(props, 0, box);
        if (hit) return hit;
        // memoizedState 是 hook 链表：{memoizedState, next}，必须逐节点走。
        // React 19 的 useSyncExternalStore 订阅就在这条链上。
        var hook = ms, guard = 0;
        while (hook && typeof hook === "object" && guard < 60 && box.budget > 0) {
          var hv = null;
          try { hv = hook.memoizedState; } catch (e) {}
          hit = searchStore(hv, 0, box);
          if (hit) return hit;
          try { hook = hook.next; } catch (e) { break; }
          guard++;
        }
        try { fiber = fiber.return; } catch (e) { break; }
      }
    } catch (e) {}
    return null;
  }

  // 每个 store 实例一份窗口时间戳：React 19 每次 commit 都会用新的内联箭头函数
  // 重新 subscribe（effect deps 含 subscribe），若把 last 放在订阅闭包里，
  // 每次重订阅都会归零 → 第一次通知永远立即放行 → 稳态下完全不合并。
  // 放到实例级后，跨订阅、跨重订阅共享同一个窗口。
  //
  // 关键：真实宿主的 subscribe 是**原型方法**（ConversationProjectionStore），
  // 所有会话实例共享同一个被包装的方法。因此必须：
  //   ① 用调用者的 this 登记监听者，绝不能捕获某个实例——
  //      否则切会话后 B 的监听者会注册进 A，B 的对话区永远不刷新（P0）；
  //   ② 窗口按实例分（WeakMap），分屏时两个 pane 不会互相推迟。
  // v0.3：实际生效窗口。基础值来自面板，两个自动项只会把它调大：
  //   自适应：最近 30s 帧 P95 变差时加档（80ms→200ms / 150ms→300ms）；
  //   冷静期：刚挂载/切会话的 10s 内至少 250ms，给首屏水合让出主线程。
  // 1s 缓存：wrapper 每秒会被调用几十次，每次重算 30s 环形窗口太浪费。
  // at 用很小的值初始化：performance.now() 在页面启动后可能 <1000，
  // 若从 0 开始会被"1 秒缓存"误判成命中，前 1 秒窗口变成 0（不节流）。
  var effCache = { at: -1e9, ms: 0 };
  function effectiveThrottleMs(now) {
    var ms;
    if (now - effCache.at < 1000) {
      ms = effCache.ms;
    } else {
      ms = settings.throttleMs;
      if (settings.adaptiveOn && !state.dead) {
        var p = frameStats().p95;
        if (p !== null && p >= 150) ms = Math.max(ms, 300);
        else if (p !== null && p >= 80) ms = Math.max(ms, 200);
      }
      if (settings.switchGuardOn && Date.now() - state.switchedAt < 10000) {
        ms = Math.max(ms, 250);
      }
      // v0.3.3：面板常开期把窗口抬到 300ms。
      if (settings.paneHoldOn && paneOpen && !state.dead) {
        ms = Math.max(ms, PANE_HOLD_FLOOR_MS);
      }
      effCache = { at: now, ms: ms };
    }
    // v0.3.5 O5：面板期进一步合并的 400ms 下限不进入 1s 缓存——面板一关
    // 必须当拍恢复，不能因为缓存再拖最多 1s。
    if (settings.panelQuietOn && settings.observe && paneOpen && !state.dead) {
      ms = Math.max(ms, PANEL_QUIET_FLOOR_MS);
    }
    // 回前台 700ms 的下限不进入 1s 缓存，否则窗口结束后还会多拖最多 1s。
    if (settings.refocusGuardOn && refocusGuardUntil && now < refocusGuardUntil) {
      ms = Math.max(ms, 400);
    }
    state.lastEffMs = ms;
    return ms;
  }

  function makeThrottledSubscribe(origSubscribe) {
    var wins = new WeakMap();
    var sharedWin = { last: 0 };

    function winOf(self) {
      if (!self || (typeof self !== "object" && typeof self !== "function")) return sharedWin;
      var w = wins.get(self);
      if (!w) { w = { last: 0 }; wins.set(self, w); }
      return w;
    }

    return function (cb) {
      // 只接管标准的一参订阅（React useSyncExternalStore / zustand subscribe(listener)）。
      // 带 selector 的 subscribeWithSelector(selector, listener, opts) 必须原样放行——
      // 把 selector 当 listener 包会让真正的 listener 永不触发，等于冻结 UI。
      if (arguments.length !== 1 || typeof cb !== "function") {
        return origSubscribe.apply(this, arguments);
      }
      var self = this;
      var win = winOf(self);
      var timer = null, pending = false, lastArgs = null;
      function fire() {
        var now = performance.now();
        win.last = now;
        // v0.3.5 P0：真正交付通知的时刻（含立即放行、延迟补发、回前台补发）。
        // 只在合并刷新仍生效时记录：关闭后旧 wrapper 可能还会被调用一次，
        // 但那不再代表插件在合并通知，不能把随后的长帧归到 flush。
        if (settings.throttleOn && settings.lafDiagOn && settings.lafCtxOn
          && settings.observe && !state.dead) {
          lastFlushAt = now;
        }
        var args = lastArgs;
        lastArgs = null;
        try { cb.apply(null, args || []); } catch (e) {}
      }
      function wrapped() {
        lastArgs = arguments;
        // v0.3.5 P0：宿主通知进入包装的时刻。与 fire() 分开记录，才能区分
        // 「通知到了但被合并」（notify 近、flush 远）和「补发才真正渲染」（flush 近）。
        if (settings.throttleOn && settings.lafDiagOn && settings.lafCtxOn
          && settings.observe && !state.dead) {
          lastNotifyAt = performance.now();
        }
        throttleHits++;
        // 关掉开关后，已经订阅过的组件也要立刻恢复即时通知
        if (!settings.throttleOn) {
          if (timer) { clearTimeout(timer); timer = null; pending = false; }
          fire();
          return;
        }
        // 后台窗口的定时器本来就被 Chromium 降到 1/min；这里主动把通知压到
        // 最多 1s 一次，避免"看不见的窗口"还在跑整树渲染。
        if (settings.hiddenSkipOn && document.hidden) {
          if (!pending) {
            pending = true;
            timer = setTimeout(function () { timer = null; pending = false; fire(); }, 1000);
          }
          return;
        }
        // 用 performance.now()：Date.now() 遇到系统时钟回拨会让 wait 变成
        // 几分钟且 pending 已置位，通知会一直冻到旧定时器到期。
        var winMs = effectiveThrottleMs(performance.now());
        var wait = win.last + winMs - performance.now();
        if (wait <= 0) {
          if (timer) { clearTimeout(timer); timer = null; pending = false; }
          fire();
        } else if (!pending) {
          pending = true;
          timer = setTimeout(function () { timer = null; pending = false; fire(); }, wait);
        }
      }
      // 回前台合并补发：只处理本订阅自己的 pending，不影响其它订阅。
      // 返回 true 表示这次真的补发了一个挂起通知，P3 的 flushes 以此计数。
      var flushOnVisible = function () {
        if (!pending || !timer) return false;
        clearTimeout(timer);
        timer = null;
        pending = false;
        fire();
        return true;
      };
      bgFlushers.push(flushOnVisible);
      var un = origSubscribe.call(self, wrapped);
      return function () {
        var i = bgFlushers.indexOf(flushOnVisible);
        if (i >= 0) bgFlushers.splice(i, 1);
        if (timer) { clearTimeout(timer); timer = null; pending = false; }
        try { if (typeof un === "function") un(); } catch (e) {}
      };
    };
  }

  function scheduleThrottleRetry() {
    if (fixState.retryTimer || state.dead || !settings.throttleOn || fixState.applied) return;
    if (fixState.tries >= 20) {
      fixState.reason = "ZCode 的会话还没加载好（已停止重试）";
      return;
    }
    fixState.retryTimer = setTimeout(function () {
      fixState.retryTimer = null;
      if (state.dead || !settings.throttleOn || fixState.applied) return;
      applyThrottle();
    }, 3000);
  }

  // 只还原指定目标上"我们自己装的那一层"
  function restoreTarget(target) {
    if (!target) return;
    try {
      var rec = target.__lagfixThrottle;
      if (rec && typeof rec.orig === "function") target.subscribe = rec.orig;
      delete target.__lagfixThrottle;
    } catch (e) {}
  }

  // ---- v0.3 大会话保护 ----
  // 实测：进入超大历史会话时，问题导航会调 loadAllOlder 把所有历史分页拉一遍；
  // 期间 projection 通知为 0，但主线程持续长任务（50 次/5s、最长 700ms），
  // 因为每页的解析/合并都在 renderer 主线程。这里在非分享场景直接返回
  // not-enough-queries：会话只用尾部窗口，问题导航覆盖已加载部分。
  // 分享必须完整（分享产物由主进程全量拉取），所以分享 UI 在场时一律放行。
  var BIG_ROWS_GUARD = 800;   // rows.totalCount 超过它才算"大会话"
  var shareIntentUntil = 0;

  function shareActiveNow() {
    if (Date.now() < shareIntentUntil) return true;
    try {
      return !!document.querySelector(
        '[data-testid="conversation-share-popover"],'
        + '[data-testid="conversation-share-selection-dock"],'
        + '[data-testid="conversation-share-confirmation-dock"],'
        + '[data-testid="conversation-share-permission-picker"]');
    } catch (e) { return false; }
  }

  function makeGuardedLoadAll(orig) {
    return function () {
      try {
        if (settings.bigSessionOn && !shareActiveNow()) {
          var st = this.state || {};
          var snap = st.snapshot;
          var rows = snap && snap.rows;
          var total = rows && rows.totalCount;
          var winRows = rows && rows.window;
          // window 正常是数组；宿主升级换成别的形状时不能因为 undefined<total 为 false
          // 就静默失效（fail-open）。拿不到长度按"一行都没载"处理，宁可多拦一次。
          var loaded = Array.isArray(winRows)
            ? winRows.length
            : (winRows && typeof winRows.length === "number" ? winRows.length : 0);
          if (isFinite(total) && total >= BIG_ROWS_GUARD && loaded < total) {
            bigBlocked++;
            // 记下"被拦的是哪个 store"：关保护时只补它。切会话后
            // findStoreFrom 拿到的是新会话，拿它顶替会在错误会话里
            // 触发一次全量补拉（三审 P1）。
            fixState.blockedStore = this;
            return Promise.resolve({
              status: "not-enough-queries",
              logEpoch: (snap && snap.logEpoch) || "unknown",
              directoryRevision: st.turnNavigatorDirectoryRevision || 0,
            });
          }
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  function applyLoadAllGuard(store) {
    if (!settings.bigSessionOn || state.dead) return false;
    var target = Object.prototype.hasOwnProperty.call(store, "loadAllOlder")
      ? store
      : Object.getPrototypeOf(store);
    if (!target || typeof target.loadAllOlder !== "function") return false;
    if (target.__lagfixLoadAll) {
      fixState.loadTarget = target;
      fixState.loadOrig = target.__lagfixLoadAll.orig;
      return true;
    }
    if (fixState.loadTarget && fixState.loadTarget !== target) releaseLoadAllGuard();
    var orig = target.loadAllOlder;
    target.loadAllOlder = makeGuardedLoadAll(orig);
    target.__lagfixLoadAll = { orig: orig };
    fixState.loadTarget = target;
    fixState.loadOrig = orig;
    return true;
  }

  function releaseLoadAllGuard() {
    var target = fixState.loadTarget;
    fixState.loadTarget = null;
    fixState.loadOrig = null;
    if (!target) return;
    try {
      var rec = target.__lagfixLoadAll;
      if (rec && typeof rec.orig === "function") target.loadAllOlder = rec.orig;
      delete target.__lagfixLoadAll;
    } catch (e) {}
  }

  // 用户明确关掉大会话保护后调用：宿主已把上次被拦的目录请求记成终态
  // （not-enough-queries），不主动补一次的话，问题导航要等重开才完整。
  // 只补"真的被我们拦过"的 store，不用当前会话顶替——切会话后顶替会在
  // 错误的会话里触发一次全量补拉（三审 P1）。
  function resumeStore(st, attempt) {
    if (!st || st.closed || settings.bigSessionOn || state.dead) return;
    if (typeof st.loadAllOlder !== "function") return;
    loadAllInFlightAt = Date.now() + 2000;
    try {
      var pr = st.loadAllOlder();
      if (pr && typeof pr.then === "function") {
        pr.then(function (r) {
          if (settings.bigSessionOn || state.dead || attempt >= 6) return;
          // stale：宿主正在分页加载；retryable-failure：传输失败可重试。
          // 两者都退避后再试，最多 6 次（约 12s），避免无限循环。
          if (r && (r.status === "stale" || r.status === "retryable-failure")) {
            setTimeout(function () { resumeStore(st, attempt + 1); }, 600 * (attempt + 1));
          }
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function resumeFullHistory() {
    var st = fixState.blockedStore;
    fixState.blockedStore = null;
    if (!st || st.closed || settings.bigSessionOn || state.dead) return;
    if (Date.now() < loadAllInFlightAt) {
      // 2 秒防抖不能直接丢弃：快速关→开→关时，最后一次关闭也必须有补偿。
      // 把 store 留在 pending 槽里，等窗口结束后再补一次。
      fixState.blockedStore = st;
      if (!fixState.resumeTimer) {
        fixState.resumeTimer = setTimeout(function () {
          fixState.resumeTimer = null;
          var pending = fixState.blockedStore;
          fixState.blockedStore = null;
          if (pending && !pending.closed) resumeStore(pending, 0);
        }, Math.max(50, loadAllInFlightAt - Date.now()));
      }
      return;
    }
    resumeStore(st, 0);
  }

  // 分享入口点击意图位：分享弹窗挂载前 hydrate 就可能被触发，
  // 只靠 DOM 标记会漏判，所以点击分享按钮后再给 15s 保险。
  try {
    document.addEventListener("click", function (ev) {
      try {
        var t = ev && ev.target;
        if (t && t.closest && t.closest('[data-testid="conversation-share-trigger"]')) {
          shareIntentUntil = Date.now() + 15000;
        }
      } catch (e) {}
    }, true);
  } catch (e) {}

  function applyThrottle() {
    // 自禁用后绝不允许任何路径（含 storage 事件/面板）把节流或补拉守卫装回去：
    // 那时角标已被移除，用户看不见也关不掉，只能靠控制台。
    if (state.dead) return false;
    var store = findStoreFrom(state.el);
    if (store) {
      if (settings.bigSessionOn) applyLoadAllGuard(store);
      else releaseLoadAllGuard();
      // v0.3.1：滚动诊断只观测 loadOlder，与「节流」开关无关——
      // 只要诊断开着就装，关掉诊断由 applyScrollSettings 释放。
      applyLoadOlderProbe(store);
    } else {
      if (!settings.bigSessionOn) releaseLoadAllGuard();
      // store 暂时取不到（宿主重建 pane/切换会话）时，先把观测包装还回去：
      // 否则旧实例会继续把补页记进当前会话的明细环。
      releaseLoadOlderProbe();
    }
    if (!settings.throttleOn) return false;
    if (!store) {
      // 已经装好一个目标时不要把它降级成"未生效"：宿主可能只是临时卸了锚点
      if (!fixState.applied) {
        fixState.reason = "ZCode 的会话还没加载好";
        fixState.tries++;
        scheduleThrottleRetry();
      }
      renderPanelStatus();
      return fixState.applied;
    }
    // 优先包装 store **实例自己**的 subscribe（zustand create() 返回自有属性）。
    // 只包原型会影响所有同原型的 store 实例，而且真实宿主可能随时换实例。
    var target = Object.prototype.hasOwnProperty.call(store, "subscribe")
      ? store
      : Object.getPrototypeOf(store);
    if (!target || typeof target.subscribe !== "function") {
      fixState.reason = "store 无 subscribe";
      fixState.tries++;
      scheduleThrottleRetry();
      return false;
    }
    // 宿主换了 store 实例（切会话/重建 pane）：旧目标还原，改包新的。
    // 不做这一步的话，applied 会一直是 true，新 store 从头到尾没被节流。
    if (fixState.target && fixState.target !== target) {
      restoreTarget(fixState.target);
      fixState.target = null;
      fixState.applied = false;
    }
    if (target.__lagfixThrottle) {   // 已装过（例如上一次重试/另一窗口先装）
      fixState.target = target;
      fixState.orig = target.__lagfixThrottle.orig;
      fixState.applied = true;
      fixState.reason = "";
      return true;
    }
    var orig = target.subscribe;
    target.subscribe = makeThrottledSubscribe(orig);
    target.__lagfixThrottle = { orig: orig };
    fixState.target = target;
    fixState.orig = orig;
    fixState.applied = true;
    fixState.reason = "";
    fixState.tries = 0;
    renderPanelStatus();
    return true;
  }

  function releaseThrottle() {
    if (fixState.retryTimer) { clearTimeout(fixState.retryTimer); fixState.retryTimer = null; }
    var target = fixState.target;
    fixState.applied = false;
    restoreTarget(target);
    fixState.target = null;
    fixState.orig = null;
    // v0.3.5：合并刷新关闭后，旧 wrapper 可能还会被调用一次；清掉通知时间戳，
    // 避免 P0 把关闭后的长帧继续归到 flush/notify（与文档边界一致）。
    lastNotifyAt = 0;
    lastFlushAt = 0;
  }

  // v0.3.1：两个观测开关与遮罩开关的唯一应用点。
  // 面板、跨窗口 storage、恢复默认、一键还原都走这里，避免四条路径各写一份清理。
  function applyScrollSettings() {
    // v0.3.4：滚动诊断关闭只清观测数据；loadOlder 包装是否卸载还要看降频开关
    // （O3 与观测独立生效）。两者同时关才释放包装，行为回到 v0.3.3。
    if ((!settings.scrollDiagOn && !settings.loadOlderPaceOn) || state.dead) {
      releaseLoadOlderProbe();
    }
    if (!settings.scrollDiagOn || state.dead) {
      loadOlderDiagGen++;   // 作废在途回调：不能把关闭前的那次补页写回空环
      scrollRing.length = 0;
      loadOlderRing.length = 0;
      loadOlderDetail.length = 0;
      lastDetailKey = "";
      scrollEvents = 0;
      anyScrollEvents = 0;
      loadOlderCalls = 0;
      loadOlderErrors = 0;
      lafCount = 0;
      lafMax = 0;
      lastScrollAt = 0;
      domPeak = 0;
      domPeakAt = 0;
      domProbeAt = 0;
      domCostMs = 0;
    } else {
      // 诊断刚打开：立即尝试装到当前 store（不必等 5s 看门狗）
      try { applyThrottle(); } catch (e) {}
    }
    if (!settings.inputLagOn || state.dead) {
      inputRing.length = 0;
      inputPendingAt = 0;
    }
    if (!settings.maskOffOnScroll || state.dead) setScrollMaskActive(false);
    // v0.3.4：降频关闭时丢掉滚动时间戳，避免下次开启时拿陈旧信号误判触发来源。
    if (!settings.loadOlderPaceOn || state.dead) paceInScrollDispatch = false;
    // v0.3.4：LoAF 计数随滚动诊断，归因环随 lafDiagOn；两者任一需要才保留观察器。
    if (!settings.lafDiagOn || state.dead) {
      lafDetail.length = 0;
      lafDetailKey = "";
      paceInScrollDispatch = false;
    }
    // v0.3.5：P0 关闭（或父开关关）时清掉上下文时间戳与周期计数；重新开启从 0 起算。
    if (!settings.lafCtxOn || !settings.lafDiagOn || state.dead) {
      resetLafCtx();
      if (!settings.lafCtxOn) stripLafCtxFromDetail();
    }
    setLafObserving(lafWatchNeeded());
    // 监听器按当前开关装卸；关闭后不再空转，重新开启时这里会挂回来。
    setScrollListener(scrollWatchNeeded());
    setPageUnloadListener(!state.dead && settings.observe);
    setInputListener(settings.inputLagOn && settings.observe && !state.dead);
    // 多会话归因有自己的开关；这一处统一处理 panel/storage/恢复默认三条路径。
    try { applySessionSettings(); } catch (e) {}
  }

  // 一键还原（控制台 / 出问题时）
  window.__lagfixOff = function () {
    try {
      // 与面板/跨窗口关掉大会话保护保持一致：只有本轮真的拦过全量补拉才补一次，
      // 否则一键还原会把低行数会话也平白拉一遍（终审 P1-7）。
      var wasBig = settings.bigSessionOn;
      settings.throttleOn = false;
      settings.bigSessionOn = false;
      // v0.3.1：一键还原必须把两项观测和遮罩也一起关掉，不能留下"看不见的采样"。
      settings.scrollDiagOn = false;
      settings.sessionDiagOn = false;
      settings.inputLagOn = false;
      settings.maskOffOnScroll = false;
      // v0.3.3：四项一起关；属性/监听/定时器由 applyPaneSettings 统一清理。
      settings.paneDiagOn = false;
      settings.paneSwitchGuardOn = false;
      settings.paneHoldOn = false;
      settings.refocusGuardOn = false;
      // v0.3.4：归因与两个实验缓解一并关；CV 属性由 syncCvAttr 移除，
      // 降频包装随 releaseLoadOlderProbe 消失，归因环清空。
      settings.lafDiagOn = false;
      settings.loadOlderPaceOn = false;
      settings.turnContentVisOn = false;
      // v0.3.5：上下文归因与面板期合并一并关；时间戳/计数清空。
      settings.lafCtxOn = false;
      settings.panelQuietOn = false;
      saveSettings();
      releaseThrottle();
      releaseLoadAllGuard();
      releaseLoadOlderProbe();
      releaseSessionProbe();
      try { applyPaneSettings(); } catch (e) {}
      setScrollMaskActive(false);
      try { if (lafObserver) lafObserver.disconnect(); } catch (e) {}
      setScrollListener(false);
      setPageUnloadListener(false);
      setInputListener(false);
      syncCvAttr();
      scrollRing.length = 0;
      loadOlderRing.length = 0;
      loadOlderDetail.length = 0;
      lastDetailKey = "";
      lafDetail.length = 0;
      lafDetailKey = "";
      paceInScrollDispatch = false;
      inputRing.length = 0;
      inputPendingAt = 0;
      scrollEvents = 0;
      anyScrollEvents = 0;
      loadOlderCalls = 0;
      loadOlderErrors = 0;
      lafCount = 0;
      lafMax = 0;
      lastScrollAt = 0;
      resetLafCtx();
      domPeak = 0;
      domPeakAt = 0;
      domProbeAt = 0;
      domCostMs = 0;
      if (wasBig && bigBlocked !== bigBlockedMark) resumeFullHistory();
      fixState.reason = "已手动关闭";
      renderPanelStatus();
      return "fix off";
    } catch (e) { return "error"; }
  };

  // 角标可以被完全隐藏；必须留一个重新进设置的入口，否则用户关掉角标后就被锁在外面。
  // Ctrl+Alt+L（mac 为 Cmd+Alt+L）打开设置；控制台 __lagfixSettings() 等价。
  try {
    window.addEventListener("keydown", function (ev) {
      try {
        if (state.dead || !ev) return;
        if (!(ev.ctrlKey || ev.metaKey) || !ev.altKey) return;
        if (ev.shiftKey) return;   // 只认精确组合，避免抢宿主 Ctrl+Alt+Shift+L 之类快捷键
        // macOS 上 Option+L 的 key 是 "¬"，只看 key 会漏；优先用 code。
        var isL = ev.code === "KeyL" || String(ev.key || "").toLowerCase() === "l";
        if (!isL) return;
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        setPanelOpen(true);
      } catch (e) {}
    }, true);
  } catch (e) {}
  window.__lagfixSettings = function () {
    try {
      if (state.dead) return "dead";
      setPanelOpen(true);
      return "open";
    } catch (e) { return "error"; }
  };

  function setObserving(on, skipSave) {
    settings.observe = !!on;
    if (!skipSave) saveSettings();
    if (settings.observe) {
      state.missed = false;
      state.missedReason = "";
      try {
        var a = findAnchor();
        if (a) attach(a);
        else startReacquire();
      } catch (e) { err(); }
      try { if (ltObserver) ltObserver.observe({ entryTypes: ["longtask"] }); } catch (e) {}
      frameRing.length = 0;
      rafLast = 0;
      lastTickAt = 0;   // 暂停期间可能最小化过，恢复后第一 tick 不能算成卡死
      startRaf();
      try { syncSessionPanes(); } catch (e) {}
      // 恢复后从当前时刻起算全局 commitRate，分母不包含整段暂停时长。
      state.lastCollectAt = performance.now();
      state.frames = 0;
      // per-session 的 commitRate 同理，从恢复时刻重新起算。
      try { restartSessionSampling(); } catch (e) {}
    } else {
      try { if (mo) { mo.disconnect(); mo = null; } } catch (e) {}
      try { if (ltObserver) ltObserver.disconnect(); } catch (e) {}
      stopRaf();
      // 暂停后不再采样：清掉待处理按键，避免恢复后把整段暂停时长记成一次延迟。
      inputPendingAt = 0;
      scrollEvents = 0;
      anyScrollEvents = 0;
      lafCount = 0;
      resetLafCtx();   // v0.3.5：暂停期间不保留上一段的长帧上下文
      // v0.3.2：暂停期间不观察提交，但保留桶；恢复后重新同步。
      resetSessionCounts();
      try { if (sessionMO) sessionMO.disconnect(); } catch (e) {}
      // 暂停后不再需要锚点轮询/看门狗：它们每 2s/5s 还在跑，
      // 既白耗 CPU，又会在恢复时和 attach 抢着挂载。
      try { if (acquireTimer) { clearInterval(acquireTimer); acquireTimer = null; } } catch (e) {}
      try { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } } catch (e) {}
      try { if (slowRetryTimer) { clearTimeout(slowRetryTimer); slowRetryTimer = null; } } catch (e) {}
    }
    setLafObserving(lafWatchNeeded());
    setInputListener(settings.inputLagOn && settings.observe && !state.dead);
    setScrollListener(scrollWatchNeeded());
    // v0.3.3：暂停时移除侧栏属性/监听，恢复时重新发现侧栏并挂回。
    try { applyPaneSettings(); } catch (e) { err(); }
    // v0.3.4：暂停时同样移除 CV 属性（syncCvAttr 看 observe），恢复时补回。
    syncCvAttr();
    // v0.3.4：__lagfixOff 会把 pagehide/beforeunload 摘掉，而它不置 state.dead；
    // 之后只重新打开「观测」时不经过 applyScrollSettings，卸载清理就再也不会挂回。
    setPageUnloadListener(!state.dead && settings.observe);
    renderOverlay();
    renderPanelStatus();
  }

  // 多窗口共享同一份 localStorage：另一个窗口改了设置（尤其 collectSec / 节流），
  // 本窗口必须跟着收敛。否则两个窗口各报一个 collectSec，主进程每轮来回重建
  // 采集泵，形成永久抖动。
  function reloadSettings() {
    // 观测器已自禁用：角标/面板都没了，合并设置没有意义；
    // 更要紧的是不能让另一窗口的 storage 事件把节流偷偷装回来。
    if (state.dead) return;
    var o = null;
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      o = raw ? JSON.parse(raw) : null;
    } catch (e) { return; }
    if (!o || typeof o !== "object") return;
    var wasObserve = settings.observe;
    var wasBig = settings.bigSessionOn;
    var wasScrollDiag = settings.scrollDiagOn;
    var wasSessionDiag = settings.sessionDiagOn;
    var wasInputLag = settings.inputLagOn;
    var wasMask = settings.maskOffOnScroll;
    var wasPaneDiag = settings.paneDiagOn;
    var wasPaneGuard = settings.paneSwitchGuardOn;
    var wasPaneHold = settings.paneHoldOn;
    var wasRefocusGuard = settings.refocusGuardOn;
    // v0.3.4：三项新开关的变化也各有收敛动作（都在 applyScrollSettings / syncCvAttr 内）。
    var wasLafDiag = settings.lafDiagOn;
    var wasPace = settings.loadOlderPaceOn;
    var wasCv = settings.turnContentVisOn;
    // v0.3.5：P0 上下文与 O5 面板期合并。
    var wasLafCtx = settings.lafCtxOn;
    var wasPanelQuiet = settings.panelQuietOn;
    mergeStored(o, settings);
    if (settings.badMs <= settings.warnMs) settings.badMs = settings.warnMs + 1;
    if (settings.observe !== wasObserve) setObserving(settings.observe, true);
    if (settings.scrollDiagOn !== wasScrollDiag || settings.inputLagOn !== wasInputLag
      || settings.maskOffOnScroll !== wasMask
      || settings.lafDiagOn !== wasLafDiag || settings.loadOlderPaceOn !== wasPace
      || settings.lafCtxOn !== wasLafCtx) {
      applyScrollSettings();
      // 降频开关打开时立即尝试装包装（scrollDiagOn 可能是关的，不会走上面的 applyThrottle）。
      if (settings.loadOlderPaceOn) { try { applyThrottle(); } catch (e) {} }
    }
    // CV 属性幂等同步：另一窗口开关实验项时本窗口立即生效/失效。
    if (settings.turnContentVisOn !== wasCv) syncCvAttr();
    if (settings.sessionDiagOn !== wasSessionDiag) applySessionSettings();
    if (settings.paneDiagOn !== wasPaneDiag
      || settings.paneSwitchGuardOn !== wasPaneGuard
      || settings.paneHoldOn !== wasPaneHold
      || settings.refocusGuardOn !== wasRefocusGuard
      || settings.panelQuietOn !== wasPanelQuiet) {
      applyPaneSettings();
    }
    if (settings.throttleOn) {
      if (!fixState.applied) applyThrottle();
    } else {
      releaseThrottle();
    }
    // 大会话保护与节流是两套开关：另一窗口关掉它时必须同步释放本窗口的包装，
    // 否则面板会一直显示"已装"、原型上残留 guard（行为虽放行，状态却是假的）。
    // 从开到关时也补一次真实补拉，和本窗口面板里的行为保持一致。
    if (!settings.bigSessionOn) {
      releaseLoadAllGuard();
      if (wasBig && bigBlocked !== bigBlockedMark) resumeFullHistory();
    } else {
      if (!wasBig) bigBlockedMark = bigBlocked;   // 另一窗口刚开启：重置本轮拦截基线
      if (!fixState.loadTarget) applyThrottle();
    }
    rebuildPanel();
    renderOverlay();
  }

  try {
    window.addEventListener("storage", function (ev) {
      if (ev && ev.key && ev.key !== SETTINGS_KEY) return;
      reloadSettings();
    });
  } catch (e) {}

  // 窗口尺寸变化：角标/统计跟着输入框重新定位
  try {
    window.addEventListener("resize", function () {
      positionBadge();
      positionStats();
    });
  } catch (e) {}

  overlayTimer = setInterval(renderOverlay, OVERLAY_TICK_MS);
  renderOverlay();   // 立刻画一次，别让角标最多晚 1s 才出现

  // ---- 采集入口（主进程每 N 秒调用）----
  function settingsSnapshot() {
    return {
      observe: settings.observe,
      badgeText: settings.badgeText, badgeMode: settings.badgeMode,
      adaptiveOn: settings.adaptiveOn, switchGuardOn: settings.switchGuardOn,
      hiddenSkipOn: settings.hiddenSkipOn, bigSessionOn: settings.bigSessionOn,
      scrollDiagOn: settings.scrollDiagOn, inputLagOn: settings.inputLagOn,
      sessionDiagOn: settings.sessionDiagOn,
      maskOffOnScroll: settings.maskOffOnScroll,
      paneDiagOn: settings.paneDiagOn,
      paneSwitchGuardOn: settings.paneSwitchGuardOn,
      paneHoldOn: settings.paneHoldOn,
      refocusGuardOn: settings.refocusGuardOn,
      lafDiagOn: settings.lafDiagOn,
      loadOlderPaceOn: settings.loadOlderPaceOn,
      turnContentVisOn: settings.turnContentVisOn,
      lafCtxOn: settings.lafCtxOn,
      panelQuietOn: settings.panelQuietOn,
      logMaxMB: settings.logMaxMB,
      warnMs: settings.warnMs, badMs: settings.badMs, collectSec: settings.collectSec,
    };
  }

  // ---- v0.3.1 观测快照 ----
  function ringMax(ring, now) {
    var vals = windowValues(ring, now);
    var m = null;
    for (var i = 0; i < vals.length; i++) if (m === null || vals[i] > m) m = vals[i];
    return m;
  }

  function scrollSnapshot(now) {
    if (!settings.scrollDiagOn) return null;
    var vals = windowValues(scrollRing, now);
    var loVals = windowValues(loadOlderRing, now);
    // DOM 每周期采样一次；单次全量计数 >5ms 就退回 60s 降频 ——
    // 观测器不能成为新的长任务源（9k 节点下全量计数本身就是可观测成本）。
    // 用独立的 domProbeAt 计时：旧 DOM 块（60s 一次）也会写 domAt，
    // 共用时间戳会让这里的降频分支永远进不去，峰值被永久冻结。
    var gap = domCostMs > 5 ? 60000 : 0;
    if (!domProbeAt || now - domProbeAt > gap) {
      var n = null;
      if (domAt && now - domAt <= 1 && domCount !== null) {
        n = domCount;   // 本周期旧块刚数过：复用，避免同一周期遍历两遍
      } else {
        var t0 = performance.now();
        try { n = document.getElementsByTagName("*").length; } catch (e) {}
        domCostMs = performance.now() - t0;
        domAt = now;
      }
      domProbeAt = now;
      if (n !== null) {
        if (!domPeakAt || now - domPeakAt > WINDOW_MS) { domPeak = n; domPeakAt = now; }
        else if (n > domPeak) domPeak = n;
        domCount = n;
      }
    }
    var turns = 0;
    try { turns = document.querySelectorAll('[data-v4-turn-unit="true"]').length; } catch (e) {}
    return {
      p95: pctOf(vals, 0.95),
      max: ringMax(scrollRing, now),
      events: scrollEvents,
      anyEvents: anyScrollEvents,
      frames: vals.length,
      mismatch: anyScrollEvents > 0 && scrollEvents === 0,
      loadOlderCalls: loadOlderCalls,
      loadOlderP95: pctOf(loVals, 0.95),
      loadOlderMax: ringMax(loadOlderRing, now),
      loadOlderErrors: loadOlderErrors,
      mountedTurns: turns,
      domPeak: domPeak || null,
      lafCount: lafCount,
      lafMax: lafMax || null,
    };
  }

  function inputSnapshot(now) {
    if (!settings.inputLagOn) return null;
    var vals = windowValues(inputRing, now);
    return { p95: pctOf(vals, 0.95), max: ringMax(inputRing, now), samples: vals.length };
  }

  // ---- v0.3.4 观测快照：LoAF 归因 + 降频计数 ----
  // 归因明细与 loadOlderDetail 同一套「未变化发 []」约定：消费端向前找最近非空。
  // count/max 是本周期 ≥50ms 长帧口径。supported 由创建时的一次性探测得出，
  // 开关打开后即为准确值；lafDiagOn 关闭时整段返回 null（不报 supported）。
  function lafDetailKeyOf() {
    var parts = [];
    for (var i = 0; i < lafDetail.length; i++) {
      var d = lafDetail[i];
      // v0.3.5：上下文变化也要触发一次完整明细，否则来源/差值变化会被
      // 「未变化发 []」吞掉。
      parts.push(d.t + ":" + d.ms + ":" + d.styleMs + ":" + d.scripts.length
        + ":" + (d.src || "") + ":" + (d.sinceNotify == null ? "" : d.sinceNotify)
        + ":" + (d.sinceFlush == null ? "" : d.sinceFlush)
        + ":" + (d.sinceScroll == null ? "" : d.sinceScroll)
        + ":" + (d.sinceCommit == null ? "" : d.sinceCommit));
    }
    return parts.join("|");
  }

  function lafSnapshot() {
    if (!settings.lafDiagOn || !settings.observe) return null;
    var key = lafDetailKeyOf();
    var snap = key === lafDetailKey ? [] : lafDetail.slice();
    lafDetailKey = key;
    return {
      supported: lafSupported ? 1 : 0,
      count: lafCount,
      max: lafMax || null,
      // v0.3.5 P0：本周期来源分布；开关关闭时为 null（不假装有数据）。
      ctx: settings.lafCtxOn ? {
        flush: lafCtxCounts.flush,
        notify: lafCtxCounts.notify,
        scroll: lafCtxCounts.scroll,
        other: lafCtxCounts.other,
      } : null,
      detail: snap,
    };
  }

  // v0.3.5 O5：面板期进一步合并当前是否生效（样本 panelQuiet 与报告共用一口径）。
  function panelQuietActive() {
    return !!(settings.panelQuietOn && settings.observe && !state.dead
      && paneDetected && paneOpen);
  }

  function paceSnapshot() {
    if (!settings.loadOlderPaceOn) return null;
    return {
      minRows: PACE_MIN_ROWS,
      intervalMs: PACE_INTERVAL_MS,
      allowed: paceStats ? paceStats.allowed : 0,
      skipped: paceStats ? paceStats.skipped : 0,
    };
  }

  function fixSnapshot() {
    return {
      on: !!settings.throttleOn, ms: settings.throttleMs,
      eff: state.lastEffMs || settings.throttleMs,
      applied: !!fixState.applied, why: fixState.reason || "",
      hits: throttleHits,
      big: !!settings.bigSessionOn, bigApplied: !!fixState.loadTarget,
      blocked: bigBlocked,
    };
  }

  window.__lagfixCollect = function () {
    if (state.panelOpen) refreshLogStats();   // 主进程刚注入了最新字节数
    var cfg = settingsSnapshot();
    // 已禁用：返回廉价 payload，绝不再做 O(DOM) 扫描（终审 P1-9）
    if (state.dead) {
      return JSON.stringify({
        sid: state.sid, frames: 0, dt: 0,
        commitP50: null, commitP95: null, frameP50: null, frameP95: null,
        frameMax: null, samples: 0, heapMB: null, dom: null,
        hidden: document.hidden, dead: true,
        miss: state.missedReason || true, errs: state.errCount,
        settings: cfg, fix: fixSnapshot(),
        // schema 稳定：dead 样本也带这些字段，消费端不必判 undefined
        scroll: null, input: null, sessions: null, loadOlderDetail: null,
        pane: null, refocus: null,
        laf: null, pace: null,
        paneOpen: null, panelQuiet: 0,
        ver: VERSION, updateCheck: 0,
        restart: state.restartRequested ? 1 : 0,
      });
    }
    // 用户暂停观测：同样返回廉价 payload，但保留 settings 以便主进程对齐间隔
    if (!settings.observe) {
      state.frames = 0;
      longTaskCount = 0;
      // 暂停期间不累计周期计数；恢复后的首个样本从 0 开始。
      scrollEvents = 0;
      anyScrollEvents = 0;
      lafCount = 0;
      lafMax = 0;   // v0.3.4：与 lafCount 同口径，暂停不留陈旧最大值
      // v0.3.5：暂停期间的上下文计数不带到恢复后的第一段。
      resetLafCtx();
      inputPendingAt = 0;
      // 暂停不影响手动「检查更新」：标记随本样本回传一次后立即清掉，
      // 否则暂停期间每个周期都会重复请求。
      var pausedAsk = state.updateCheckRequested ? 1 : 0;
      state.updateCheckRequested = false;
      if (pausedAsk) markUpdateRequestSent();
      return JSON.stringify({
        sid: state.sid, frames: 0, dt: 0,
        commitP50: null, commitP95: null, frameP50: null, frameP95: null,
        frameMax: null, samples: 0, heapMB: null, dom: null,
        hidden: document.hidden, dead: false, paused: true,
        miss: false, errs: state.errCount,
        settings: cfg, fix: fixSnapshot(),
        scroll: null, input: null, sessions: null, loadOlderDetail: null,
        pane: null, refocus: null,
        // 暂停期归因环不累计（laf=null）；降频是缓解项，与 observe 独立，照实上报。
        laf: null, pace: paceSnapshot(),
        paneOpen: null, panelQuiet: 0,
        ver: VERSION, updateCheck: pausedAsk,
        restart: state.restartRequested ? 1 : 0,
      });
    }
    // v0.3.3：每轮采集重新确认侧栏标记（宿主可能改版/切布局），并更新常开属性。
    try { syncPaneProbe(); } catch (e) {}
    var now = performance.now();
    var askUpdate = state.updateCheckRequested ? 1 : 0;
    var dtS = state.lastCollectAt ? (now - state.lastCollectAt) / 1000 : 0;
    state.lastCollectAt = now;
    try {
      var cs = commitStats();
      var fs = frameStats();
      // DOM 计数降频到 60s：全量 querySelectorAll 在大会话下是几十 ms 的长任务，
      // 观测器不该成为被观测的卡顿源。
      if (!domAt || now - domAt > 60000) {
        try { domCount = document.getElementsByTagName("*").length; } catch (e) {}
        domAt = now;
      }
      var heap = null;
      try {
        if (performance.memory && performance.memory.usedJSHeapSize) {
          heap = Math.round(performance.memory.usedJSHeapSize / 1048576);
        }
      } catch (e) {}
      // 悬停统计的柱状图数据：每个采集周期一条，只留最近 HIST_MAX 条。
      // 用当前 30s 窗口的 P95 而不是本周期瞬时值 —— 后者在流式暂停时会掉到 0，
      // 柱子会无故见底，和角标判定也对不上。
      hist.push({
        t: Date.now(),
        p95: fs.p95,
        fmax: frameMaxAll || null,
        rate: dtS > 0 ? Math.round((state.frames / dtS) * 10) / 10 : 0,
        lt: longTaskCount,
        heap: heap,
      });
      if (hist.length > HIST_MAX) hist.shift();
      var sessionSnap = null;
      try { sessionSnap = sessionSnapshot(now); } catch (e) { err(); }
      var detailSnap = null;
      if (settings.scrollDiagOn) {
        // 明细只在变化时携带完整数组；未变化的样本发 []。否则每 5s 重复
        // 最多 10 条记录，会让日志量翻倍、report 的可用时间窗口缩到几小时。
        // 消费端（report）向前找最近一次非空数组。
        var dk = loadOlderDetailKey();
        detailSnap = dk === lastDetailKey ? [] : loadOlderDetail.slice();
        lastDetailKey = dk;
      }
      var out = {
        sid: state.sid,
        frames: state.frames,
        dt: Math.round(dtS * 100) / 100,
        commitP50: cs.p50, commitP95: cs.p95,
        frameP50: fs.p50, frameP95: fs.p95,
        frameMax: frameMaxAll || null,
        commitMaxAll: state.allTimeMax || null,
        longTasks: longTaskCount, maxLongTask: maxLongTaskMs || null,
        samples: cs.n,
        heapMB: heap, dom: domCount,
        hidden: document.hidden,
        dead: false,
        miss: state.missed ? (state.missedReason || true) : false,
        errs: state.errCount,
        settings: settingsSnapshot(),
        fix: fixSnapshot(),
        scroll: scrollSnapshot(now),
        input: inputSnapshot(now),
        sessions: sessionSnap,
        loadOlderDetail: detailSnap,
        pane: paneSnapshot(now),
        refocus: refocusSnapshot(now),
        laf: lafSnapshot(),
        pace: paceSnapshot(),
        // v0.3.5：P0 的窗口上下文 + O5 是否正在生效；未检测到侧栏时 paneOpen=null。
        paneOpen: paneDetected ? !!paneOpen : null,
        panelQuiet: panelQuietActive() ? 1 : 0,
        ver: VERSION,
        updateCheck: askUpdate,
        restart: state.restartRequested ? 1 : 0,
      };
      return JSON.stringify(out);
    } catch (e) {
      err();
      return JSON.stringify({ sid: state.sid, frames: 0, dt: 0, dead: false, errs: state.errCount,
        settings: cfg, fix: fixSnapshot(),
        scroll: null, input: null, sessions: null, loadOlderDetail: null,
        pane: null, refocus: null, laf: null, pace: null,
        paneOpen: null, panelQuiet: 0, ver: VERSION,
        updateCheck: askUpdate,
        restart: state.restartRequested ? 1 : 0 });
    } finally {
      state.frames = 0;   // 异常路径也要清零，否则下次会跨窗口累计上报
      longTaskCount = 0;
      // 周期计数一律清零；30s 环形窗口（scrollRing/loadOlderRing/inputRing）不清。
      scrollEvents = 0;
      anyScrollEvents = 0;
      lafCount = 0;
      // 检查更新请求只随一个样本回传：主进程收到后就会去查，不需要重发。
      // 记下已发出，面板在结果注入前继续显示「正在检查」。
      if (askUpdate) markUpdateRequestSent();
      state.updateCheckRequested = false;
      // v0.3.4：lafMax 与 lafCount 同为「本周期」口径（终审对齐 spec 1.1.1；
      // 此前跨周期保留会让报告的「本周期最长」拿到陈旧值）。
      lafMax = 0;
      // v0.3.5：来源分布同样是周期计数。
      lafCtxCounts = { flush: 0, notify: 0, scroll: 0, other: 0 };
    }
  };

  // 控制台手查入口
  window.__lagfixDiag = function () {
    return {
      since: state.since, sid: state.sid, dead: state.dead,
      primed: state.primed, missed: state.missedReason || state.missed,
      samples: state.ring.length, frameSamples: frameRing.length,
      allTimeMax: state.allTimeMax, frameMaxAll: frameMaxAll,
      longTaskCount: longTaskCount, maxLongTaskMs: maxLongTaskMs,
      scrollFrames: scrollRing.length, loadOlderCalls: loadOlderCalls,
      loadOlderErrors: loadOlderErrors, inputSamples: inputRing.length,
      sessionBuckets: sessionBuckets.length, sessionPanes: sessionPanes.length,
      loadOlderDetail: loadOlderDetail.length,
      lafCtx: {
        notify: lastNotifyAt, flush: lastFlushAt,
        scroll: lastLafScrollAt, commit: lastCommitAt,
        counts: lafCtxCounts,
      },
      paneDetected: paneDetected, paneOpen: paneOpen, paneSwitches: paneSwitches,
      paneGuardHits: paneGuardHits,
      paneSwitchFrames: paneSwitchRing.length,
      refocusSamples: refocusRing.length, refocusFlushes: refocusFlushes,
      refocusGuardHits: refocusGuardHits, hiddenMs: hiddenMs,
      paneGuardAttr: (function () {
        try { return document.documentElement.getAttribute("data-lagfix-pane-switch"); } catch (e) { return null; }
      })(),
      paneOpenAttr: (function () {
        try { return document.documentElement.getAttribute("data-lagfix-pane-open"); } catch (e) { return null; }
      })(),
      maskAttr: (function () {
        try { return document.documentElement.getAttribute("data-lagfix-scroll"); } catch (e) { return null; }
      })(),
      errs: state.errCount,
    };
  };

  // 冒烟测试入口：只暴露"判定配色"这一条纯逻辑，便于断言面板里的黄/红阈值
  // 真的会改变角标颜色（终审 P1-1）。不影响运行时行为。
  window.__lagfixTest = {
    verdict: verdictOf,
    setThresholds: function (warnMs, badMs) {
      // 与面板/加载路径保持同一组不变量：1~5000、2~10000、bad > warn。
      var w = Math.min(5000, Math.max(1, Number(warnMs) || DEFAULTS.warnMs));
      var b = Math.min(10000, Math.max(w + 1, Number(badMs) || DEFAULTS.badMs));
      settings.warnMs = w;
      settings.badMs = b;
      return [w, b];
    },
  };
})();
