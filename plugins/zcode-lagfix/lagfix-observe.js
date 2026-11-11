/**
 * zcode-lagfix renderer 观测脚本 v0.3.0
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
  var WINDOW_MS = 30000;            // P95 只看最近 30 秒
  var ERR_LIMIT = 50;
  var OVERLAY_ID = "lagfix-overlay-badge";
  var PANEL_ID = "lagfix-settings-panel";
  var SETTINGS_KEY = "lagfix.settings.v1";
  var OVERLAY_TICK_MS = 1000;
  var LONG_TASK_MS = 50;

  var DEFAULTS = {
    observe: true,      // 观测开关
    badgeVisible: true, // 角标整体显隐
    badgeText: true,    // 角标是否显示文字（关掉只留小圆点）
    badgeMode: "simple",// 角标内容：simple=判定+帧 / detail=提交+帧+长任务+堆
    // v0.3 性能增强（全部可开关）
    adaptiveOn: true,   // 帧变差时自动放大节流窗口
    switchGuardOn: true,// 切会话后 10s 内至少 250ms，避让首屏水合
    hiddenSkipOn: true, // 窗口在后台时最多 1s 通知一次
    bigSessionOn: true, // 超大历史会话不自动补拉全部旧问题
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
    if (typeof o.badgeVisible === "boolean") s.badgeVisible = o.badgeVisible;
    if (typeof o.badgeText === "boolean") s.badgeText = o.badgeText;
    if (o.badgeMode === "simple" || o.badgeMode === "detail") s.badgeMode = o.badgeMode;
    if (typeof o.adaptiveOn === "boolean") s.adaptiveOn = o.adaptiveOn;
    if (typeof o.switchGuardOn === "boolean") s.switchGuardOn = o.switchGuardOn;
    if (typeof o.hiddenSkipOn === "boolean") s.hiddenSkipOn = o.hiddenSkipOn;
    if (typeof o.bigSessionOn === "boolean") s.bigSessionOn = o.bigSessionOn;
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
    lastEffMs: 0,              // 最近一次实际生效的节流窗口（面板展示）
    restartRequested: false,   // 只存内存：随样本回传给主进程，不落盘（防重启死循环）
  };

  // rAF 真实帧间隔
  var frameRing = [];       // [{t, ms}]
  var frameMaxAll = 0;
  var rafLast = 0;

  // 长任务
  var longTaskCount = 0;
  var maxLongTaskMs = 0;
  // 实际上经过我们 wrapper 的通知次数：用来判断"装了但宿主没走这条路"
  // （applied=true 却完全不增长 → 包装无效，只能靠这个看出来）
  var throttleHits = 0;
  var logStatsRow = null;    // 维护页「当前日志量」文本节点（主进程随采集注入字节数）
  var bigBlocked = 0;        // 大会话保护拦下的全量补拉次数
  var bigBlockedMark = 0;    // 本轮保护启用时的拦截计数快照（只有真拦过才在关闭时补拉）
  var loadAllInFlightAt = 0; // 关闭保护后的补拉去重：防止快速关/开/关并发跑两遍
  var bgFlushers = [];       // 后台挂起的通知：回前台立即补发（见 visibilitychange）
  // 后台降频只保证"最多 1s 一次"，但窗口不可见时 Chromium 会把定时器降到 1/min。
  // 回到前台必须立刻补一次，否则流式刚结束时界面可能停在旧状态。
  try {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      // 后台 overlay 定时器会被降到 1/min；回前台的第一个 tick 不能拿几十秒的
      // dt 去算 stallMs，否则角标会闪一下"卡死"。
      lastTickAt = 0;
      var list = bgFlushers.slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](); } catch (e) {}
      }
    });
  } catch (e) {}

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
    loadTarget: null, loadOrig: null };

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
  function rafTick(t) {
    if (state.dead || !settings.observe) { rafRunning = false; return; }
    try {
      if (!document.hidden) {
        if (rafLast) {
          var d = t - rafLast;
          if (d > 0 && d < 60000) {
            frameRing.push({ t: t, ms: Math.round(d) });
            if (frameRing.length > RING_MAX) frameRing.shift();
            if (d > frameMaxAll) frameMaxAll = Math.round(d);
          }
        }
        rafLast = t;
      } else {
        rafLast = 0;  // 后台窗口不采样，回来时重新建基线
      }
    } catch (e) { err(); }
    if (!state.dead) requestAnimationFrame(rafTick);
    else rafRunning = false;
  }
  // 后台期间 rAF 通常整段挂起，rafLast 停在进入后台前；不显式归零的话，
  // 回到前台的第一帧会把整段后台时长当成"一帧"记录（角标变红、P95 被污染）。
  try {
    document.addEventListener("visibilitychange", function () { rafLast = 0; });
  } catch (e) {}

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
            state.lastSeq = state.el.getAttribute(ATTR);
            state.lastT = performance.now();
            resetWindow();
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
    armWatchdog();    // 锚点一挂上就尝试装节流（store 只能从真实 fiber 上取，必须等挂载完成）
    if ((settings.throttleOn && !fixState.applied) || settings.bigSessionOn) applyThrottle();
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
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          startReacquire();
          return;
        }
        // 宿主可能重建 store（切会话/换 pane）：定期核对当前目标还是不是被包的那个。
        // 大会话保护也走同一条复核：只判 !loadTarget 的话，宿主中途换原型会让
        // 保护静默失效，而面板仍按旧目标显示"已装"。
        if ((settings.throttleOn && (fixState.applied || fixState.tries < 20))
          || settings.bigSessionOn) {
          applyThrottle();
        }
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
      if (!rafRunning) { rafRunning = true; requestAnimationFrame(rafTick); }
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
          if (!rafRunning) { rafRunning = true; requestAnimationFrame(rafTick); }
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

  function verdictOf(frameP95, stallMs, recentMax, commitRate) {
    if (state.dead) return { label: "已停", color: "#8b949e" };
    if (!settings.observe) return { label: "已暂停", color: "#8b949e" };
    // 当前主线程被占死（定时器迟到 >500ms）和"最近刚卡过一次"要分开说：
    // 前者是正在进行，后者是 30s 内的历史峰值，用"刚卡过"避免误读成一直卡死。
    if (stallMs > 500) return { label: "卡死", color: "#f85149" };
    if (recentMax !== null && recentMax >= 300) {
      return { label: "刚卡过", color: "#f85149" };
    }
    if (frameP95 === null || frameP95 === undefined) {
      return commitRate === 0
        ? { label: "空闲", color: "#8b949e" }
        : { label: "流畅", color: "#3fb950" };
    }
    var t = tierOf(frameP95);
    return { label: t.label, color: t.color };
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
      "#" + PANEL_ID + " .dlg-ft{display:flex;justify-content:space-between;align-items:center;",
      "padding:10px 18px;border-top:1px solid var(--color-border,rgba(255,255,255,.1));",
      "font-size:11.5px;color:var(--color-foreground-subtle,#8791a3)}",
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
    el.title = "点开看统计：每帧=画面刷新间隔（越小越顺），重绘=对话区每秒重画几次，"
      + "卡顿=主线程被占住>50ms 的次数。齿轮进设置。";

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
      var fallback = document.querySelector('[data-testid="v4-composer"]');
      return composerUsable(fallback) ? fallback : null;
    } catch (e) { return null; }
  }

  // 角标浮在输入框**上方**（不是内侧）：内侧会压住模型选择/发送按钮等工具行，
  // 用户实测反馈遮挡视线。位置取 composer 顶边再往上让出角标高度 + 6px；
  // 上方若还有排队面板，就继续让到队列上沿——「立即/编辑/删除」永远不被盖住。
  // 宿主重渲染可能清掉 React 子节点，所以不往里插，用 fixed + 每秒同步坐标。
  // 返回 false 表示当前没有可用输入框（设置页/被遮住）或上方没有空间，调用方应隐藏角标。
  function positionBadge() {
    var el = document.getElementById(OVERLAY_ID);
    if (!el) return false;
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
    var w = el.offsetWidth || 190;
    var vw = window.innerWidth || 1024;
    var left = Math.min(Math.max(8, r.right - w - 8), vw - w - 8);
    // 角标高度约 25px（12px 字号 + 6px 内边距 + 边框），留 26px 上限。
    // 不用 offsetHeight：隐藏时它是 0，会让"隐藏/显示"的判定自相矛盾。
    var BADGE_H = 26;
    var GAP = 6;
    var top = r.top - BADGE_H - GAP;
    // 排队面板（data-testid="v4-queue"）在 composer 上方。角标现在也住在这条带上，
    // 若两者竖向相交，就整体让到队列上沿，绝不覆盖「立即 / 编辑 / 删除」。
    try {
      // 分屏时每个 pane 各有一个队列；优先取输入框所在会话子树里的，
      // 并要求水平方向有交集，避免拿另一个 pane 的队列把角标顶走。
      var scope = (surface.closest && surface.closest('[data-session-id]')) || document;
      var q = scope.querySelector('[data-testid="v4-queue"]');
      if (q) {
        var qr = q.getBoundingClientRect();
        var vh2 = window.innerHeight || 768;
        var overlapsX = qr && qr.left < r.right && qr.right > r.left;
        var overlapsY = qr && qr.height > 0 && qr.bottom > top && qr.top < top + BADGE_H;
        if (qr && overlapsX && overlapsY && qr.top < vh2) {
          top = qr.top - BADGE_H - GAP;
        }
      }
    } catch (e) {}
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
          parts.push("重绘 " + commitRate + "次/秒");
          parts.push("每帧 " + (fs.p95 === null ? "-" : fs.p95 + "ms"));
          parts.push("卡顿 " + longTaskCount + "次");
          var hp = heapMB();
          if (hp !== null) parts.push("内存 " + hp + "MB");
        } else {
          parts.push("每帧 " + (fs.p95 === null ? "-" : fs.p95 + "ms"));
          if (longTaskCount > 0) parts.push("卡顿 " + longTaskCount + "次");
          if (stallMs > 500) parts.push("主线程停顿 " + stallMs + "ms");
        }
        mEl.textContent = parts.join(" · ");
      }

      // 只有主对话页且输入框可见时才显示角标；设置页/被覆盖时整条隐藏。
      var placed = positionBadge();
      if (el) el.style.display = (settings.badgeVisible && placed) ? "" : "none";
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
      + '<span>ms · 每帧间隔 P95（越小越流畅，最近 30 秒）</span></div>'
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
      + '<div class="st-help">每帧 = 连续两帧的间隔，越大越卡；重绘 = 对话区每秒重新画几次；'
      + '卡顿 = 主线程被占住超过 50ms 的次数；内存 = 渲染进程 JS 堆。</div>'
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
      foot.textContent = "对话区重绘 " + rate + " 次/秒 · 主线程卡顿 " + longTaskCount + " 次"
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
      b.textContent = disabled ? sub + "（依赖订阅通知节流，当前已关闭）" : sub;
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
    sm.textContent = "v0.3.0";
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
      { id: "fix", label: "修复" },
      { id: "maint", label: "维护" },
    ];
    var sections = {};

    // --- 状态条 ---
    var sStatus = section("status", "状态条",
      "角标浮在输入框上方。鼠标悬停看统计，点齿轮回到这里；角标隐藏后按 Ctrl+Alt+L 仍可打开。");
    var c1 = card();
    c1.appendChild(rowEl("显示角标", "关掉后角标完全隐藏；按 Ctrl+Alt+L（Mac：Cmd+Alt+L）或控制台 __lagfixSettings() 可重新打开设置。",
      switchEl(settings.badgeVisible, function (v) {
        settings.badgeVisible = v; saveSettings(); rebuildPanel(); renderOverlay();
      })));
    c1.appendChild(rowEl("角标文字", "关掉只留一个颜色圆点，几乎不占位置。",
      switchEl(settings.badgeText, function (v) {
        settings.badgeText = v; saveSettings(); renderOverlay();
      })));
    c1.appendChild(rowEl("角标内容", "简洁只给结论和每帧间隔；详细再加上重绘次数、卡顿次数、内存。",
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
    c1.appendChild(rowEl("变黄阈值", "帧 P95 超过它就变黄。50ms 起能看出掉帧。",
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
    c1.appendChild(rowEl("变红阈值", "帧 P95 超过它就变红。100ms 以上是明显卡顿。",
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
      "只读采样，不改宿主行为。数据写入 ~/.zcode/zcode-lagfix/observe-YYYYMMDD.jsonl。");
    var c2 = card();
    c2.appendChild(rowEl("开启观测", "关闭后不再采样帧间隔与长任务，角标变灰。",
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
    c2.appendChild(rowEl("采集间隔", "多久记录一次数据。越短越细，日志也越多。", sel));
    sObs.appendChild(c2);
    sections.observe = sObs;

    // --- 修复 ---
    var sFix = section("fix", "修复",
      "减少流式输出与大会话加载时的卡顿。所有改动只影响渲染时机，不改消息、会话数据与工具执行。"
      + "每项标题后的「!」可展开该项影响什么、不影响什么。");
    var capThrottle = document.createElement("div");
    capThrottle.className = "cap";
    capThrottle.textContent = "通知节流";
    sFix.appendChild(capThrottle);
    var c3 = card();
    c3.appendChild(rowEl("订阅通知节流", "关闭后立即恢复宿主原始刷新频率（会重新变卡）。",
      switchEl(settings.throttleOn, function (v) {
        settings.throttleOn = v;
        saveSettings();
        if (v) applyThrottle(); else releaseThrottle();
        rebuildPanel(); renderOverlay();
      }),
      "影响：宿主会话 store 的 subscribe 通知频率——同一窗口内的多次通知合并成一次，"
      + "流式输出、工具状态、思考过程的刷新最多晚一个窗口。\n"
      + "不影响：消息内容、会话数据、工具执行与任务队列。关闭后立即回到宿主原始频率。"));
    var tw = document.createElement("div");
    tw.className = "ctl";
    tw.appendChild(numberInput(settings.throttleMs, 30, 1000, function (v) {
      settings.throttleMs = v;
      saveSettings();
      renderPanelStatus();
    }));
    tw.appendChild(unit("ms"));
    c3.appendChild(rowEl("节流窗口", "两次刷新至少间隔多久。越大越省 CPU，画面也越迟。", tw,
      "影响：两次通知之间的最小间隔。调大 → React 重绘更少、CPU 更省，但文字刷新更\"跳\"；"
      + "调小 → 更跟手，但流式输出时重绘更多。\n"
      + "不影响：Agent 收流、消息落盘、工具执行。它只决定\"什么时候把最新状态画出来\"。",
      !settings.throttleOn));
    var fixStatus = document.createElement("div");
    fixStatus.className = "status";
    fixStatus.id = PANEL_ID + "-fixstatus";
    c3.appendChild(fixStatus);
    sFix.appendChild(c3);

    // 性能优化：四项都只影响"什么时候通知 React 渲染 / 要不要全量补拉"，不改宿主数据。
    var capPerf = document.createElement("div");
    capPerf.className = "cap";
    capPerf.textContent = "加载与后台";
    sFix.appendChild(capPerf);
    var c3b = card();
    c3b.appendChild(rowEl("自适应窗口", "最近帧变差时自动把窗口加到 200–300ms，恢复后回落。",
      switchEl(settings.adaptiveOn, function (v) {
        settings.adaptiveOn = v; saveSettings(); rebuildPanel(); renderPanelStatus();
      }),
      "影响：最近帧 P95 ≥ 80ms 时窗口抬到 200ms，≥ 150ms 抬到 300ms；帧恢复后自动回到"
      + "\"节流窗口\"里的值。卡顿时主动少画几帧，把主线程让给布局和输入。\n"
      + "不影响：数据与会话状态；也不会改写\"节流窗口\"设置本身。帧很好时它完全不介入。",
      !settings.throttleOn));
    c3b.appendChild(rowEl("切会话冷静期", "刚切会话的 10 秒内至少 250ms，不和首屏加载抢主线程。",
      switchEl(settings.switchGuardOn, function (v) {
        settings.switchGuardOn = v; saveSettings(); rebuildPanel(); renderPanelStatus();
      }),
      "影响：切会话/新建会话后的 10 秒内，通知窗口不低于 250ms。这段时间宿主正在挂载"
      + "历史行、跑布局和虚拟列表，少几次重绘能明显缩短白屏和输入延迟。10 秒后自动恢复正常窗口。\n"
      + "不影响：订阅关系与会话切换本身；切到小会话时只是前 10 秒刷新稍慢。",
      !settings.throttleOn));
    c3b.appendChild(rowEl("后台降频", "窗口在后台时最多每秒通知一次，前台恢复立即追上。",
      switchEl(settings.hiddenSkipOn, function (v) {
        settings.hiddenSkipOn = v; saveSettings(); rebuildPanel();
      }),
      "影响：窗口不可见（最小化、切到别的应用、其他标签页）时，通知最多 1 秒 1 次，"
      + "省下看不见的重绘和 CPU。\n"
      + "不影响：Agent 执行、流式收包、日志采集；回到前台会立刻补一次最新状态，不会漏消息。",
      !settings.throttleOn));
    c3b.appendChild(rowEl("大会话保护", "超过 800 行的会话不再自动补拉全部历史；分享时自动放行。",
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
      "影响：会话总行数 ≥ 800 且只加载了一部分时，拦下宿主的\"一次性补拉全部历史\""
      + "（问题导航目录、分享前的目录补齐）。大会话打开时不再突然渲染几千行。\n"
      + "不影响：正常上翻分页（loadOlder）、当前可见消息、Agent 运行。分享面板打开、"
      + "选中、复制时自动放行，分享功能照常。代价是大会话的问题导航只覆盖已加载部分。\n"
      + "与订阅通知节流相互独立：即使节流关掉，这一项仍然生效。"));
    sFix.appendChild(c3b);
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
      rz.textContent = "已请求重启，等待主进程…";
      renderPanelStatus();
      setTimeout(function () {
        if (!rz.parentNode || !state.restartRequested) return;
        rz.disabled = false;
        rz.textContent = "重启 ZCode（上次未生效，可再试）";
        rz.title = "主进程可能未收到请求（看 ~/.zcode/zcode-lagfix/main.log），可再点一次";
      }, 60000);
    });
    c4.appendChild(rowEl("重启 ZCode", "宿主清理超过 15s 才会强制结束；请求不落盘。", rz));
    var up = document.createElement("button");
    up.type = "button";
    up.className = "act";
    up.textContent = "检查更新";
    up.disabled = true;   // 还没发布到 GitHub，先置灰，避免给出假的"已是最新"
    up.title = "尚未发布到 GitHub，暂无更新源";
    c4.appendChild(rowEl("检查更新", "暂无更新源；发布到 GitHub 后启用。", up));
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
    c4.appendChild(rowEl("日志存储路径", "observe-*.jsonl / main.log / inject.log 都在这里。", logCtl));
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
    c4.appendChild(rowEl("日志上限", "超过上限自动删最旧的日志；今天正在写的文件会先滚动再删。", logSel));

    var verLine = document.createElement("div");
    verLine.className = "status";
    verLine.textContent = "版本 v0.3.0 · 控制台 __lagfixOff() 可一键还原全部修复";
    c4.appendChild(verLine);
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
    ftL.textContent = "所有设置已展示";
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

  function renderPanelStatus() {
    var s = document.getElementById(PANEL_ID + "-fixstatus");
    if (!s) return;
    try {
      var fs = frameStats();
      var f = fixState;
      var line = f.applied
        ? "节流：已生效（基础 " + settings.throttleMs + "ms / 当前 "
          + (state.lastEffMs || settings.throttleMs) + "ms，经过 " + throttleHits + " 次通知）"
        : (settings.throttleOn
            ? "节流：待生效（" + (f.reason || "等待会话挂载") + "）"
            : "节流：已关闭");
      var bigLine = settings.bigSessionOn
        ? "大会话保护：" + (f.loadTarget ? "已装" : "待装") + "（拦下 " + bigBlocked + " 次全量补拉）"
        : "大会话保护：关";
      s.textContent = "会话 " + (state.sid ? state.sid.slice(0, 12) : "未挂载")
        + " · 帧采样 " + fs.n + " 个 · 卡顿 " + longTaskCount + " 次 · " + line + " · " + bigLine
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
    if (now - effCache.at < 1000) return effCache.ms;
    var ms = settings.throttleMs;
    if (settings.adaptiveOn && !state.dead) {
      var p = frameStats().p95;
      if (p !== null && p >= 150) ms = Math.max(ms, 300);
      else if (p !== null && p >= 80) ms = Math.max(ms, 200);
    }
    if (settings.switchGuardOn && Date.now() - state.switchedAt < 10000) {
      ms = Math.max(ms, 250);
    }
    effCache = { at: now, ms: ms };
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
        win.last = performance.now();
        var args = lastArgs;
        lastArgs = null;
        try { cb.apply(null, args || []); } catch (e) {}
      }
      function wrapped() {
        lastArgs = arguments;
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
      // 回前台立即补发：只处理本订阅自己的 pending，不影响其它订阅。
      var flushOnVisible = function () {
        if (!pending || !timer) return;
        clearTimeout(timer);
        timer = null;
        pending = false;
        fire();
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
      fixState.reason = "未找到 store（已停止重试）";
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
  // （not-enough-queries），不主动补一次的话，当前会话的问题导航要等重开才完整。
  function resumeFullHistory() {
    if (Date.now() < loadAllInFlightAt) return;
    loadAllInFlightAt = Date.now() + 2000;
    try {
      var st = findStoreFrom(state.el);
      if (!st || typeof st.loadAllOlder !== "function") return;
      var pr = st.loadAllOlder();
      if (pr && typeof pr.then === "function") {
        pr.then(function (r) {
          // 宿主在 loadingOlder=true 时直接返回 stale；等当前分页结束再补一次。
          if (r && r.status === "stale" && !settings.bigSessionOn && !state.dead) {
            setTimeout(function () {
              if (settings.bigSessionOn || state.dead) return;
              try {
                var st2 = findStoreFrom(state.el);
                if (st2 && typeof st2.loadAllOlder === "function") {
                  var p2 = st2.loadAllOlder();
                  if (p2 && typeof p2.catch === "function") p2.catch(function () {});
                }
              } catch (e) {}
            }, 800);
          }
        }).catch(function () {});
      }
    } catch (e) {}
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
    } else if (!settings.bigSessionOn) {
      releaseLoadAllGuard();
    }
    if (!settings.throttleOn) return false;
    if (!store) {
      // 已经装好一个目标时不要把它降级成"未生效"：宿主可能只是临时卸了锚点
      if (!fixState.applied) {
        fixState.reason = "未找到 store";
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
  }

  // 一键还原（控制台 / 出问题时）
  window.__lagfixOff = function () {
    try {
      settings.throttleOn = false;
      settings.bigSessionOn = false;
      saveSettings();
      releaseThrottle();
      releaseLoadAllGuard();
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
      if (!rafRunning && !state.dead) {
        rafRunning = true;
        requestAnimationFrame(rafTick);
      }
    } else {
      try { if (mo) { mo.disconnect(); mo = null; } } catch (e) {}
      try { if (ltObserver) ltObserver.disconnect(); } catch (e) {}
      rafRunning = false;
      // 暂停后不再需要锚点轮询/看门狗：它们每 2s/5s 还在跑，
      // 既白耗 CPU，又会在恢复时和 attach 抢着挂载。
      try { if (acquireTimer) { clearInterval(acquireTimer); acquireTimer = null; } } catch (e) {}
      try { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } } catch (e) {}
      try { if (slowRetryTimer) { clearTimeout(slowRetryTimer); slowRetryTimer = null; } } catch (e) {}
    }
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
    mergeStored(o, settings);
    if (settings.badMs <= settings.warnMs) settings.badMs = settings.warnMs + 1;
    if (settings.observe !== wasObserve) setObserving(settings.observe, true);
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
      observe: settings.observe, badgeVisible: settings.badgeVisible,
      badgeText: settings.badgeText, badgeMode: settings.badgeMode,
      adaptiveOn: settings.adaptiveOn, switchGuardOn: settings.switchGuardOn,
      hiddenSkipOn: settings.hiddenSkipOn, bigSessionOn: settings.bigSessionOn,
      logMaxMB: settings.logMaxMB,
      warnMs: settings.warnMs, badMs: settings.badMs, collectSec: settings.collectSec,
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
        restart: state.restartRequested ? 1 : 0,
      });
    }
    // 用户暂停观测：同样返回廉价 payload，但保留 settings 以便主进程对齐间隔
    if (!settings.observe) {
      state.frames = 0;
      longTaskCount = 0;
      return JSON.stringify({
        sid: state.sid, frames: 0, dt: 0,
        commitP50: null, commitP95: null, frameP50: null, frameP95: null,
        frameMax: null, samples: 0, heapMB: null, dom: null,
        hidden: document.hidden, dead: false, paused: true,
        miss: false, errs: state.errCount,
        settings: cfg, fix: fixSnapshot(),
        restart: state.restartRequested ? 1 : 0,
      });
    }
    var now = performance.now();
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
        restart: state.restartRequested ? 1 : 0,
      };
      return JSON.stringify(out);
    } catch (e) {
      err();
      return JSON.stringify({ sid: state.sid, frames: 0, dt: 0, dead: false, errs: state.errCount,
        restart: state.restartRequested ? 1 : 0 });
    } finally {
      state.frames = 0;   // 异常路径也要清零，否则下次会跨窗口累计上报
      longTaskCount = 0;
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
      errs: state.errCount,
    };
  };
})();
