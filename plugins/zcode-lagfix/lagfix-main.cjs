#!/usr/bin/env node
/**
 * zcode-lagfix 主进程加载器 v0.3（观测 + 渲染通知节流 + 日志预算）。
 *
 * 由 app.asar 入口尾部的 dynamic import 加载（CommonJS）。
 * 职责：
 *   1. 每个窗口 webContents dom-ready 时注入 lagfix-observe.js（先 new Function 语法预检）；
 *      同时接管注册监听之前就已存在的窗口（loader 晚于首窗加载时不漏注，P1-4）；
 *   2. 每 5s 收集各窗口观测数据，追加写 ~/.zcode/zcode-lagfix/observe-YYYYMMDD.jsonl；
 *   3. 连续 5 次异常永久自禁用。
 *
 * 安全约束：
 *   - 绝不 appendSwitch（不开 CDP/调试端口）；
 *   - 绝不监听宿主 IPC 通道；
 *   - 只有 renderer 侧会包装 store 的 subscribe / loadAllOlder（可逆、可逐项关闭），
 *     主进程自身不改任何宿主对象/store 原型；
 *   - 所有回调 try/catch，不拖垮宿主主进程；
 *   - 日志链路兜底 catch，绝不留 floating rejected promise（P2-1）。
 */
"use strict";

(function () {
  if (globalThis.__lagfixMainLoaded) return;
  globalThis.__lagfixMainLoaded = true;

  var fs = require("fs");
  var path = require("path");

  var RUNTIME_DIR = __dirname; // 运行时文件即本目录
  var DATA_DIR = RUNTIME_DIR;  // observe 日志也写这里（~/.zcode/zcode-lagfix）
  var OBSERVE_JS = path.join(RUNTIME_DIR, "lagfix-observe.js");
  var MAIN_LOG = path.join(DATA_DIR, "main.log");
  var MAIN_LOG_MAX = 1024 * 1024;   // 超过 1MB 轮转为 main.log.1，保留上一代
  var COLLECT_INTERVAL_MS = 5000;
  var LOG_ROTATE_BYTES = 5 * 1024 * 1024;

  var errStreak = 0;
  var disabled = false;
  var dataDirReady = false;
  var observeSrcCache = null;
  var hookedWc = null;       // WeakSet：防同一 wc 被事件与快照各挂一次
  var inflight = null;       // Set<wcId>：防 collect 重叠（renderer 卡时调用会堆积）
  var lastDead = false;      // 连续 dead 样本只记一次，避免日志膨胀

  // 打包版 Electron 的 main 进程 stderr 没人接，console.error 等于扔进黑洞。
  // 排查"角标不出现/数据不更新"要能事后看到主进程自己说了什么，所以同时落盘。
  function log() {
    var parts = [].slice.call(arguments);
    try { console.error.apply(console, ["[lagfix]"].concat(parts)); } catch (e) {}
    try {
      var msg;
      try {
        msg = parts.map(function (x) {
          return typeof x === "string" ? x : (x && x.message) || String(x);
        }).join(" ");
      } catch (e) { msg = "<unstringifiable>"; }
      if (!ensureDataDir()) return;
      try {
        if (fs.statSync(MAIN_LOG).size > MAIN_LOG_MAX) {
          fs.renameSync(MAIN_LOG, MAIN_LOG + ".1");
        }
      } catch (e) { /* 文件不存在或无法轮转：继续追加 */ }
      fs.promises.appendFile(
        MAIN_LOG, new Date().toISOString() + " [lagfix] " + msg + "\n", "utf8"
      ).catch(function () {});
    } catch (e) {}
  }

  function loadObserveSource() {
    try {
      var st = fs.statSync(OBSERVE_JS);
      if (!observeSrcCache || observeSrcCache.mtime !== st.mtimeMs) {
        var src = fs.readFileSync(OBSERVE_JS, "utf8");
        new Function(src); // 语法预检：坏文件绝不注入
        observeSrcCache = { src: src, mtime: st.mtimeMs };
      }
      return observeSrcCache.src;
    } catch (e) {
      log("observe 脚本不可用：", e && e.message);
      return null;
    }
  }

  // 注入结果落一条轻量日志：报告端据此区分「asar 未注入」与「注入了但 observer 没响应」
  function noteInject(wc, ok, why) {
    try {
      if (!ensureDataDir()) return;
      var f = path.join(DATA_DIR, "inject.log");
      try { if (fs.statSync(f).size > 1024 * 1024) return; } catch (e) {}
      var line = new Date().toISOString() + " wc=" + (wc && wc.id) + " ok=" + ok
        + (why ? " why=" + why : "") + "\n";
      fs.promises.appendFile(f, line, "utf8").catch(function () {});
    } catch (e) {}
  }

  function inject(wc) {
    try {
      if (!wc || wc.isDestroyed() || wc.getType() !== "window") return;
      var src = loadObserveSource();
      if (!src) { noteInject(wc, false, "observe-src-unavailable"); return; }
      // 面板要显示日志路径：主进程才知道 DATA_DIR，注入前把它写进 window。
      var prelude = "window.__lagfixDataDir=" + JSON.stringify(DATA_DIR) + ";\n";
      wc.executeJavaScript(prelude + src, false).then(function () {
        noteInject(wc, true, "");
      }).catch(function (e) {
        // 注入失败不能静默：否则报告端会把「observer 没起来」误诊成「asar 未注入」
        log("注入失败 wc=" + wc.id + "：", e && e.message);
        noteInject(wc, false, (e && e.message) || "unknown");
      });
    } catch (e) {
      log("注入异常：", e && e.message);
      noteInject(wc, false, "exception");
    }
  }

  // 单个 webContents 的挂载逻辑：dom-ready 注入 + did-finish-load 幂等补注。
  // WeakSet 去重：web-contents-created 事件与 getAllWebContents() 快照之间存在
  // 窄竞态，同一 wc 可能被两条路径各挂一次（终审 C10）。
  function hookWc(wc) {
    try {
      if (!hookedWc) hookedWc = new WeakSet();
      if (hookedWc.has(wc)) return;
      hookedWc.add(wc);

      wc.on("dom-ready", function () { inject(wc); });
      wc.on("did-finish-load", function () {
        // 幂等补注：宿主整页 reload 后 observer 会丢，补一次
        try {
          wc.executeJavaScript("!!window.__lagfixObs", false).then(function (ok) {
            if (!ok) inject(wc);
          }).catch(function () {});
        } catch (e) {}
      });
      // 已过 dom-ready 的存量窗口直接补一次
      try {
        if (!wc.isLoadingMainFrame()) inject(wc);
      } catch (e) {}
    } catch (e) {
      log("挂载 wc 失败：", e && e.message);
    }
  }

  function ensureDataDir() {
    if (dataDirReady) return true;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); dataDirReady = true; } catch (e) {}
    return dataDirReady;
  }

  function logFilePath(now) {
    var d = new Date(now);
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return path.join(DATA_DIR, "observe-" + d.getFullYear() + mm + dd + ".jsonl");
  }

  function appendSample(winId, payloadText) {
    if (!ensureDataDir()) return;
    var parsed = safeParse(payloadText);
    var isDead = !!(parsed && parsed.dead);
    // 自禁用的窗口内存里是旧设置；它每 5s 仍会回传同一份 payload。若照常应用，
    // 活窗口改过的 collectSec/logMaxMB 会被旧值反复覆盖（采集泵来回重建、预算反复 sweep）。
    // dead 样本只保留重启请求，不再参与设置应用。
    if (!isDead) applyRendererSettings(parsed);
    honorRestart(parsed);
    // dead 样本连续去重：observer 已禁用时它每 5s 返回同一份 dead payload，
    // 不去重会让日志文件被"观测器已停止"刷满（终审 P1-9）。
    if (isDead) {
      if (lastDead) return;
      lastDead = true;
    } else {
      lastDead = false;
    }
    var now = Date.now();
    // 日志预算：收到 renderer 的真实 logMaxMB 之后才开始扫；每 60s 至多一次。
    if (haveRendererSettings && now - lastSweepAt > 60000) {
      lastSweepAt = now;
      sweepByBudget();
    }
    var file = logFilePath(now);
    var line = JSON.stringify({ win: winId, t: now, d: parsed }) + "\n";
    fs.promises.stat(file).then(function (st) {
      if (st.size > LOG_ROTATE_BYTES) {
        return fs.promises.rename(file, file + ".1").catch(function (e) {
          log("日志轮转失败（继续写当前文件）：", e && e.message);
        });
      }
    }).catch(function () { /* 文件不存在，直接写 */ }).then(function () {
      return fs.promises.appendFile(file, line, "utf8");
    }).catch(function (e) {
      log("日志落盘失败：", e && e.message);
    });
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function collectAll(windows) {
    if (!inflight) inflight = {};
    windows.forEach(function (win) {
      try {
        var wc = win.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (inflight[wc.id]) return;   // 上一次还没返回：renderer 卡住了，跳过本轮
        inflight[wc.id] = true;
        // 采集前把当前日志量推给 renderer（维护页显示「当前 / 上限」），
        // 与 collect 同一次 executeJavaScript，避免额外往返。
        var pre = "window.__lagfixLogStats=" + JSON.stringify(logStats()) + ";";
        wc.executeJavaScript(pre + "window.__lagfixCollect ? window.__lagfixCollect() : null", false)
          .then(function (text) {
            delete inflight[wc.id];
            if (typeof text === "string" && text.length > 0) appendSample(wc.id, text);
          })
          .catch(function (e) {
            delete inflight[wc.id];
            log("采集失败 wc=" + wc.id + "：", e && e.message);
          });
      } catch (e) {
        if (win && win.webContents) delete inflight[win.webContents.id];
      }
    });
  }

  // 观测日志保留 14 天：每 5s 一条 ≈ 8MB/天，不清会无声无息吃掉几百 MB。
  // 只匹配本插件自己生成的文件名，任何其它文件一律不碰。
  function sweepOldLogs(days) {
    try {
      var cutoff = Date.now() - days * 86400000;
      fs.readdirSync(DATA_DIR).forEach(function (name) {
        if (!/^observe-\d{8}\.jsonl(\.1)?$/.test(name)) return;
        var f = path.join(DATA_DIR, name);
        try {
          if (fs.statSync(f).mtimeMs < cutoff) {
            fs.unlinkSync(f);
            log("清理过期观测日志（超过 " + days + " 天）：" + name);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  // 日志总预算（面板可调，默认 50MB）：超过就删最旧的文件。
  // 只匹配本插件自己生成的日志名；今天正在写的 observe 文件不删，
  // 它的 .1 归档可以删。单个文件仍由 LOG_ROTATE_BYTES 轮转兜底。
  var LOG_RE = /^(observe-\d{8}\.jsonl(?:\.\d+)?|(?:main|inject|monitor|install|hook-error)\.log(?:\.\d+)?)$/;
  var curLogMaxMB = 50;
  var haveRendererSettings = false;   // 收到过 renderer 设置后才知道真实预算，之前不删日志
  var lastSweepAt = 0;

  // 当前日志量与文件数（与 sweepByBudget 同一份白名单，口径一致）。
  // 随每次采集注入 renderer，维护页据此显示「当前 X MB / 上限 Y MB」。
  function logStats() {
    var out = { bytes: 0, files: 0 };
    try {
      if (!ensureDataDir()) return out;
      fs.readdirSync(DATA_DIR).forEach(function (name) {
        if (!LOG_RE.test(name)) return;
        try {
          var st = fs.statSync(path.join(DATA_DIR, name));
          if (!st.isFile()) return;
          out.bytes += st.size;
          out.files++;
        } catch (e) {}
      });
    } catch (e) {}
    return out;
  }

  function sweepByBudget() {    try {
      if (!ensureDataDir()) return 0;
      var maxBytes = Math.max(5, curLogMaxMB) * 1024 * 1024;
      var nowName = path.basename(logFilePath(Date.now()));
      var files = [];
      var total = 0;
      fs.readdirSync(DATA_DIR).forEach(function (name) {
        if (!LOG_RE.test(name)) return;
        try {
          var st = fs.statSync(path.join(DATA_DIR, name));
          if (!st.isFile()) return;
          files.push({ name: name, size: st.size, at: st.mtimeMs });
          total += st.size;
        } catch (e) {}
      });
      if (total <= maxBytes) return 0;
      files.sort(function (a, b) { return a.at - b.at; });
      var removed = 0;
      for (var i = 0; i < files.length && total > maxBytes; i++) {
        if (files[i].name === nowName) continue;   // 今天正在写的留着
        try {
          fs.unlinkSync(path.join(DATA_DIR, files[i].name));
          total -= files[i].size;
          removed++;
        } catch (e) {}
      }
      if (removed > 0) {
        log("日志超预算（" + curLogMaxMB + "MB），已删除 " + removed
          + " 个最旧文件，剩余 " + Math.round(total / 1048576) + "MB");
      }
      return removed;
    } catch (e) { return 0; }
  }

  function start() {
    var electron;
    try { electron = require("electron"); } catch (e) { log("无法加载 electron，退出：", e && e.message); return; }
    var app = electron.app;
    if (!app) { log("非主进程上下文，退出"); return; }

    // 启动时不按默认 50MB 扫：此时还没收到 renderer 的 logMaxMB（存在 localStorage），
    // settings.json 也可能落后一个采集周期。日志只由样本增长，等首个样本到了再按
    // 真实上限扫，最多晚一个采集间隔，不会失控。
    if (ensureDataDir()) sweepOldLogs(14);

    // 新窗口：事件驱动挂载
    app.on("web-contents-created", function (_e, wc) { hookWc(wc); });

    // 存量窗口：loader 晚于首窗加载时兜底挂载（P1-4）
    try {
      var all = electron.webContents && electron.webContents.getAllWebContents();
      if (all && all.length) all.forEach(function (wc) { hookWc(wc); });
    } catch (e) {}

    var pump = setInterval(function () {
      if (disabled) return;
      try {
        var wins = electron.BrowserWindow.getAllWindows();
        collectAll(wins);
        errStreak = 0;
      } catch (e) {
        if (++errStreak >= 5) {
          disabled = true;
          clearInterval(pump);
          log("采集泵连续失败，已自禁用");
        }
      }
    }, curCollectMs);
    pump.unref && pump.unref();
    pumpTimer = pump;

    // 设置面板可能在用户拖动前后多次改采集间隔：重建定时器即可
    ELECTRON = electron;

    log("v0.3 加载器已启动（观测 + 订阅节流 + 大会话保护 + 日志预算；__lagfixOff 一键还原）");
  }

  var ELECTRON = null;
  var pumpTimer = null;
  var curCollectMs = COLLECT_INTERVAL_MS;
  var lastSettingsText = "";
  var lastFixText = "";

  function restartPump() {
    if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; }
    if (!ELECTRON || disabled) return;
    var pump = setInterval(function () {
      if (disabled) return;
      try {
        var wins = ELECTRON.BrowserWindow.getAllWindows();
        collectAll(wins);
        errStreak = 0;
      } catch (e) {
        if (++errStreak >= 5) {
          disabled = true;
          clearInterval(pump);
          log("采集泵连续失败，已自禁用");
        }
      }
    }, curCollectMs);
    pump.unref && pump.unref();
    pumpTimer = pump;
  }

  // renderer 的设置在 localStorage 里，主进程看不到；随着样本回传后在此应用并落盘，
  // 便于排查"为什么采集间隔不是 5s"。只在值变化时写文件。
  function applyRendererSettings(d) {
    try {
      var s = d && d.settings;
      if (s) {
        haveRendererSettings = true;
        var sec = parseInt(s.collectSec, 10);
        if (isFinite(sec)) {
          // 下限 1s：面板允许 1/3/5/10/30s，1s 用于抓瞬时卡顿（日志量约为 5s 的 5 倍）
          var ms = Math.min(120000, Math.max(1000, sec * 1000));
          if (ms !== curCollectMs) {
            curCollectMs = ms;
            restartPump();
            log("采集间隔调整为 " + ms + "ms");
          }
        }
        var text = JSON.stringify(s);
        // 日志预算随设置回传：改小立即清一次，不必等 60s 周期。
        var mb = parseInt(s.logMaxMB, 10);
        if (isFinite(mb)) {
          var mb2 = Math.min(1000, Math.max(5, mb));
          if (mb2 !== curLogMaxMB) {
            curLogMaxMB = mb2;
            sweepByBudget();
          }
        }
        // 写成功才记住：否则一次磁盘抖动会让这个值永远不再重试落盘，
        // 排查时 settings.json 就停在旧值上骗人。
        if (text !== lastSettingsText && ensureDataDir()) {
          if (writeSettingsAtomic(text)) lastSettingsText = text;
        }
      }
      var f = d && d.fix;
      if (f) {
        // 用不含 hits 的元组做去重键：hits 是累计值，每轮都在涨，
        // 带上它会让"节流状态"每 5s 刷一行日志。
        var ft = JSON.stringify({ on: f.on, ms: f.ms, applied: f.applied, why: f.why,
          big: f.big, bigApplied: f.bigApplied });
        if (ft !== lastFixText) {
          lastFixText = ft;
          log("节流状态：on=" + f.on + " ms=" + f.ms
            + " applied=" + f.applied + (f.why ? " why=" + f.why : ""));
        }
      }
    } catch (e) {}
  }

  function writeSettingsAtomic(text) {
    var f = path.join(DATA_DIR, "settings.json");
    var tmp = f + ".tmp";
    try {
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, f);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return false;
    }
  }

  // 面板里的「重启 ZCode」：渲染端只置一个内存标记，随样本回传；主进程收到后
  // 走 Electron 标准 relaunch。标记不落盘，进程一重启就消失 —— 从根上排除
  // "重启后读到旧标记 → 无限重启" 的死循环。
  var restartHandled = false;

  function honorRestart(d) {
    if (restartHandled || !d || d.restart !== 1) return;
    restartHandled = true;
    log("收到重启请求：app.relaunch() + 优雅退出（15s 不退则强制）");
    try {
      if (!ELECTRON || !ELECTRON.app) throw new Error("electron.app 不可用");
      ELECTRON.app.relaunch();
      // 照 zusage 的做法走 app.quit()：宿主的 before-quit 要回收会话/扩展子进程树，
      // 这段时间不能强杀（4s 会切在清理中途）。只在 quit 被彻底拦住时才兜底强退。
      try { ELECTRON.app.quit(); } catch (e) {}
      var t = setTimeout(function () {
        log("优雅退出超时，强制 app.exit(0)");
        try { ELECTRON.app.exit(0); } catch (e) {}
      }, 15000);
      t.unref && t.unref();
    } catch (e) {
      log("重启失败：", e && e.message);
      restartHandled = false;
    }
  }

  try { start(); } catch (e) { log("启动失败：", e && e.message); }
})();
