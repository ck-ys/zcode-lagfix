#!/usr/bin/env node
/**
 * zcode-lagfix 主进程加载器 v0.4.0（观测 + 渲染通知节流 + 日志预算与清理加固 + 检查更新）。
 *
 * 由 app.asar 入口尾部的 dynamic import 加载（CommonJS）。
 * 职责：
 *   1. 每个窗口 webContents dom-ready 时注入 lagfix-observe.js（先 new Function 语法预检）；
 *      同时接管注册监听之前就已存在的窗口（loader 晚于首窗加载时不漏注，P1-4）；
 *   2. 每 5s 收集各窗口观测数据，追加写 ~/.zcode/zcode-lagfix/observe-YYYYMMDD.jsonl；
 *   3. 手动「检查更新」时请求一次 GitHub Releases（仅 https + api.github.com）；
 *   4. 连续 5 次异常永久自禁用。
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
  var https = require("https");

  var RUNTIME_DIR = __dirname; // 运行时文件即本目录
  var DATA_DIR = RUNTIME_DIR;  // observe 日志也写这里（~/.zcode/zcode-lagfix）
  var OBSERVE_JS = path.join(RUNTIME_DIR, "lagfix-observe.js");
  var MAIN_LOG = path.join(DATA_DIR, "main.log");
  var MAIN_LOG_MAX = 1024 * 1024;   // 超过 1MB 轮转为 main.log.1，保留上一代
  var COLLECT_INTERVAL_MS = 5000;
  var LOG_ROTATE_BYTES = 5 * 1024 * 1024;
  // v0.3.8：预算删除只碰 10 分钟前的归档，避免和正在写入/刚轮转的文件抢。
  var LOG_MIN_DELETE_AGE_MS = 10 * 60 * 1000;

  var errStreak = 0;
  var disabled = false;
  var dataDirReady = false;
  var observeSrcCache = null;
  var hookedWc = null;       // WeakSet：防同一 wc 被事件与快照各挂一次
  var inflight = null;       // Set<wcId>：防 collect 重叠（renderer 卡时调用会堆积）
  // 按窗口去重连续 dead 样本，避免日志膨胀。必须分窗口：全局布尔值在
  // "窗口 A 已死、窗口 B 还活着"时会被 B 的活样本反复清零，A 的 dead 行
  // 就会每个采集周期都写一遍（终审 P2-3）。
  var lastDeadByWin = Object.create(null);

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
    var parsed = safeParse(payloadText);
    if (!ensureDataDir()) return parsed;
    var isDead = !!(parsed && parsed.dead);
    // 自禁用的窗口内存里是旧设置；它每 5s 仍会回传同一份 payload。若照常应用，
    // 活窗口改过的 collectSec/logMaxMB 会被旧值反复覆盖（采集泵来回重建、预算反复 sweep）。
    // dead 样本只保留重启请求，不再参与设置应用。
    if (!isDead) applyRendererSettings(parsed);
    honorRestart(parsed);
    // dead 样本连续去重：observer 已禁用时它每 5s 返回同一份 dead payload，
    // 不去重会让日志文件被"观测器已停止"刷满（终审 P1-9）。
    if (isDead) {
      if (lastDeadByWin[winId]) return;
      lastDeadByWin[winId] = true;
      // 窗口 id 会随重开增长；超过 50 个先清掉"活窗口"的 false 记录，
      // 保留仍 dead 的窗口标记，避免重置后立刻重复刷日志（三审 P2）。
      if (Object.keys(lastDeadByWin).length > 50) {
        for (var wid in lastDeadByWin) {
          if (!lastDeadByWin[wid]) delete lastDeadByWin[wid];
        }
      }
    } else {
      lastDeadByWin[winId] = false;
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
    return parsed;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function collectAll(windows) {
    if (!inflight) inflight = {};
    // 日志量每轮只扫一次目录，所有窗口共用同一份（多窗口时不重复 readdir）。
    var statsJson = JSON.stringify(logStats());
    windows.forEach(function (win) {
      try {
        var wc = win.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (inflight[wc.id]) return;   // 上一次还没返回：renderer 卡住了，跳过本轮
        inflight[wc.id] = true;
        // 采集前把当前日志量推给 renderer（维护页显示「当前 / 上限」），
        // 与 collect 同一次 executeJavaScript，避免额外往返。
        var pre = "window.__lagfixLogStats=" + statsJson + ";";
        wc.executeJavaScript(pre + "window.__lagfixCollect ? window.__lagfixCollect() : null", false)
          .then(function (text) {
            delete inflight[wc.id];
            if (typeof text === "string" && text.length > 0) {
              var d = appendSample(wc.id, text);
              // 手动「检查更新」：渲染端只置一个内存标记，真正的网络请求在主进程发。
              // dead 样本不带请求，避免已自禁用窗口反复触发。
              if (d && !d.dead && d.updateCheck === 1) checkUpdate(wc, d.ver, d.updateAuto === 1);
            }
          })
          .catch(function (e) {
            delete inflight[wc.id];
            log("采集失败 wc=" + wc.id + "：", e && e.message);
          });
      } catch (e) {
        // 已销毁窗口的 webContents getter 也可能抛；catch 里再抛会逃出
        // forEach 被采集泵计为失败，连续 5 次就永久自禁用（三审 P2）。
        try {
          if (win && win.webContents) delete inflight[win.webContents.id];
        } catch (e2) {}
      }
    });
  }

  // 观测日志保留 14 天：每 5s 一条 ≈ 8MB/天，不清会无声无息吃掉几百 MB。
  // 只匹配本插件自己生成的文件名；符号链接、目录、非普通文件一律跳过。
  function sweepOldLogs(days) {
    try {
      if (!cleanupDirSafe()) return;
      var cutoff = Date.now() - days * 86400000;
      fs.readdirSync(DATA_DIR).forEach(function (name) {
        try {
          var rec = ownedLogStat(name);
          if (!rec || isLiveLog(name)) return;
          if (rec.st.mtimeMs < cutoff) {
            fs.unlinkSync(rec.full);
            log("清理过期观测日志（超过 " + days + " 天）：" + name);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  // 日志总预算（面板可调，默认 50MB）：超过就删最旧的文件。
  // 只匹配本插件自己生成的日志名；今天正在写的 observe 文件不删，
  // 它的 .1 归档可以删。单个文件仍由 LOG_ROTATE_BYTES 轮转兜底。
  // elevated-finalize.log 由 tools/finalize_all_admin.py 以管理员身份写入同一目录，
  // 不纳入预算的话它会绕过 50MB 上限一直长（终审 P2）。
  var LOG_RE = /^(observe-\d{8}\.jsonl(?:\.\d+)?|(?:main|inject|monitor|install|hook-error|elevated-finalize)\.log(?:\.\d+)?)$/;
  var LIVE_LOG_RE = /^(main|inject|monitor|install|hook-error|elevated-finalize)\.log$/;
  var OBSERVE_LOG_RE = /^observe-(\d{4})(\d{2})(\d{2})\.jsonl(?:\.\d+)?$/;
  var curLogMaxMB = 50;
  var haveRendererSettings = false;   // 收到过 renderer 设置后才知道真实预算，之前不删日志
  var lastSweepAt = 0;

  // v0.3.8：8 位数字不等于真实日期。只认能 round-trip 的日期，
  // 避免用户文件 observe-99999999.jsonl / observe-20261340.jsonl 被当旧日志删掉。
  function validObserveLogName(name) {
    var m = OBSERVE_LOG_RE.exec(String(name || ""));
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2020 || y > 2100) return false;
    var dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  // v0.3.8：运行目录本身必须是普通目录。符号链接/junction 下删除会作用到目标目录，
  // 无法确认目标是谁时整轮跳过；读写日志仍照常，宁可超预算也不隔着链接删。
  var dataDirSafe = 0;   // 0 未检查，1 安全，-1 拒绝清理
  function cleanupDirSafe() {
    if (dataDirSafe === 1) return true;
    if (dataDirSafe === -1) return false;
    try {
      var st = fs.lstatSync(DATA_DIR);
      if (!st || typeof st.isDirectory !== "function" || !st.isDirectory()
        || (typeof st.isSymbolicLink === "function" && st.isSymbolicLink())) {
        dataDirSafe = -1;
        log("日志目录不是普通目录，已跳过自动清理：" + DATA_DIR);
        return false;
      }
      dataDirSafe = 1;
      return true;
    } catch (e) {
      dataDirSafe = -1;
      log("无法确认日志目录类型，已跳过自动清理：" + (e && e.message));
      return false;
    }
  }

  // 清理只允许操作「DATA_DIR 直接子项 + 本插件白名单文件名 + 普通文件」。
  // 任何一步不满足就返回 null，调用方一律跳过：宁可超预算，也不误删。
  function ownedLogPath(name) {
    if (typeof name !== "string" || !LOG_RE.test(name)) return null;
    // v0.3.8：observe 文件名必须带真实日期，不能只看 8 位数字。
    if (name.indexOf("observe-") === 0 && !validObserveLogName(name)) return null;
    var dir = path.resolve(DATA_DIR);
    var full = path.resolve(dir, name);
    if (path.dirname(full) !== dir) return null;   // 防目录穿越/多余路径段
    return full;
  }

  // 当前正在写的文件不参与预算删除：
  // - 今天的 observe-*.jsonl；
  // - 未轮转的 main/inject/monitor/install/hook-error/elevated-finalize.log。
  // 活动文件在 Windows 上通常删不掉，在 POSIX 上删掉也只是 unlink 活动 inode；
  // 这里统一保守处理，只删旧 observe 与 .1/.2 归档。
  function isLiveLog(name) {
    return name === path.basename(logFilePath(Date.now())) || LIVE_LOG_RE.test(name);
  }

  function ownedLogStat(name) {
    var full = ownedLogPath(name);
    if (!full) return null;
    // lstat 不跟随符号链接：链接本身、目录、设备文件一律不碰。
    var st = fs.lstatSync(full);
    if (!st || !st.isFile()) return null;
    if (typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) return null;
    return { full: full, st: st };
  }

  // 当前日志量与文件数（与 sweepByBudget 同一份白名单，口径一致）。
  // 随每次采集注入 renderer，维护页据此显示「当前 X MB / 上限 Y MB」。
  function logStats() {
    var out = { bytes: 0, files: 0 };
    try {
      if (!ensureDataDir()) return out;
      fs.readdirSync(DATA_DIR).forEach(function (name) {
        try {
          var rec = ownedLogStat(name);
          if (!rec) return;
          out.bytes += rec.st.size;
          out.files++;
        } catch (e) {}
      });
    } catch (e) {}
    return out;
  }

  var lastRetentionAt = 0;
  var deniedLogs = Object.create(null);
  function sweepByBudget() {
    try {
      if (!ensureDataDir()) return 0;
      if (!cleanupDirSafe()) return 0;
      // 14 天保留以前只在启动时跑一次；长期不重启（用户常见的常驻场景）
      // 会让过期文件一直留着。这里每小时补跑一次，成本是一次 readdir。
      var nowTs = Date.now();
      if (nowTs - lastRetentionAt > 3600000) {
        lastRetentionAt = nowTs;
        sweepOldLogs(14);
      }
      var maxBytes = Math.max(5, curLogMaxMB) * 1024 * 1024;
      var nowName = path.basename(logFilePath(Date.now()));
      var minAgeCutoff = nowTs - LOG_MIN_DELETE_AGE_MS;
      var files = [];
      var total = 0;
      fs.readdirSync(DATA_DIR).forEach(function (name) {
        try {
          var rec = ownedLogStat(name);
          if (!rec) return;
          if (isLiveLog(name)) return;   // 活动文件不参与预算删除
          files.push({ name: name, size: rec.st.size, at: rec.st.mtimeMs });
          total += rec.st.size;
        } catch (e) {}
      });
      if (total <= maxBytes) return 0;
      files.sort(function (a, b) { return a.at - b.at; });
      var removed = 0;
      for (var i = 0; i < files.length && total > maxBytes; i++) {
        if (files[i].name === nowName) continue;   // 今天正在写的留着
        try {
          // 删前复核：名字、路径、普通文件、非符号链接，任何一项变了就跳过。
          var rec = ownedLogStat(files[i].name);
          if (!rec || isLiveLog(files[i].name)) continue;
          // v0.3.8：刚轮转/刚写入的文件至少保留 10 分钟，避免和写入方抢文件。
          if (typeof rec.st.mtimeMs !== "number" || rec.st.mtimeMs > minAgeCutoff) continue;
          // v0.3.8：按当前大小修正总量；文件变小后已回到预算内就不再继续删。
          var actual = typeof rec.st.size === "number" ? rec.st.size : files[i].size;
          total += actual - files[i].size;
          if (total <= maxBytes) break;
          fs.unlinkSync(rec.full);
          total -= actual;
          removed++;
        } catch (e) {
          // 文件还在磁盘上，不能从 total 里扣掉；否则「不可删文件 > 预算」时
          // 循环会误以为已经达标，后面的可删文件一个都不会动。
          // 只记录一次（按文件名去重），然后继续尝试后面的文件。
          if (!deniedLogs[files[i].name]) {
            deniedLogs[files[i].name] = true;
            log("无法删除日志（权限/占用），已跳过：" + files[i].name);
          }
        }
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

    log("v0.4.0 加载器已启动（观测 + 渲染节流 + 大历史保护 + 侧栏/回前台保护 + 卡顿归因 + 定时器归因 + 自适应补页实验 + 自动检查更新/红点 + 日志预算与清理加固 + 设置面板滚动/焦点 + 更新红点可见性；__lagfixOff 一键还原）");
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

  // ---- 检查更新（手动或自动触发，只在主进程发 GitHub Releases 请求） ----
  // 渲染端把 updateCheck=1 塞进样本；主进程查完把结果注入 window.__lagfixUpdate。
  // 不带 token、不自动下载、不自动安装；失败只影响面板那一行提示。
  // v0.3.7：自动检查（updateAuto=1）默认由渲染端开关控制；主进程再按 24h 去重，
  // 多窗口同时到期也只发一次网络请求，其余窗口复用缓存结果。
  var UPDATE_API = "https://api.github.com/repos/ck-ys/zcode-lagfix/releases";
  var UPDATE_HOST = "api.github.com";
  var UPDATE_HOME = "https://github.com/ck-ys/zcode-lagfix/releases";
  var UPDATE_MAX_BYTES = 2 * 1024 * 1024;
  var UPDATE_TIMEOUT_MS = 10000;
  var AUTO_UPDATE_MIN_MS = 24 * 60 * 60 * 1000;
  var lastUpdateAt = 0;
  var lastAutoUpdateAt = 0;
  var lastUpdateInfo = null;
  var updateInflight = false;

  function parseSemver(s) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(s || ""));
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || "" };
  }

  function cmpSemver(a, b) {
    var d = (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
    if (d) return d < 0 ? -1 : 1;
    if (a.pre === b.pre) return 0;
    if (!a.pre) return 1;   // 正式版 > 同号预发布
    if (!b.pre) return -1;
    return a.pre < b.pre ? -1 : 1;
  }

  function sendUpdate(wc, info) {
    try {
      if (!wc || wc.isDestroyed()) return;
      wc.executeJavaScript("window.__lagfixUpdate=" + JSON.stringify(info) + ";", false)
        .catch(function () {});
    } catch (e) {}
  }

  function checkUpdate(wc, current, auto) {
    var now = Date.now();
    if (auto) {
      // 24h 内已有结果：直接回放缓存，不再联网；at 用回放时刻，避免接收端
      // 把旧结果误判成「本次请求还没回来」而一直显示正在检查。
      if (lastUpdateInfo && now - lastAutoUpdateAt < AUTO_UPDATE_MIN_MS) {
        sendUpdate(wc, Object.assign({}, lastUpdateInfo, { at: now }));
        return;
      }
      // 24h 内已经试过但失败了（无缓存），或另一次请求在途：自动检查静默跳过，不弹错误。
      if (now - lastAutoUpdateAt < AUTO_UPDATE_MIN_MS || updateInflight) return;
    }
    if (updateInflight || now - lastUpdateAt < 5000) {
      if (auto) return;   // 自动检查不叠加，也不把“太频繁”当失败塞给用户
      sendUpdate(wc, { status: "error", message: "请求过于频繁，请稍后再试", at: now });
      return;
    }
    updateInflight = true;
    lastUpdateAt = now;
    if (auto) lastAutoUpdateAt = now;
    var cur = parseSemver(current) || parseSemver("0.0.0");
    // 总时限覆盖连接、重定向与慢速滴流；每跳不再单独重置 10s。
    var deadline = Date.now() + UPDATE_TIMEOUT_MS;
    getJson(UPDATE_API, 2, deadline, function (e, data) {
      updateInflight = false;
      if (e) {
        log("检查更新失败：" + e.message);
        sendUpdate(wc, { status: "error", message: e.message, at: Date.now() });
        return;
      }
      var best = null;
      try {
        (Array.isArray(data) ? data : []).forEach(function (r) {
          if (!r || r.draft || r.prerelease) return;
          var v = parseSemver(r.tag_name);
          if (!v) return;
          if (!best || cmpSemver(v, best.v) > 0) {
            best = { v: v, tag: String(r.tag_name), url: r.html_url };
          }
        });
      } catch (e2) {}
      var newer = !!(best && cmpSemver(best.v, cur) > 0);
      if (!best) {
        log("检查更新：当前 " + current + "，仓库还没有正式发布版本");
        sendUpdate(wc, {
          status: "error",
          message: "仓库还没有正式发布版本（只有 tag 不算 Release）",
          at: Date.now(),
        });
        return;
      }
      log("检查更新：当前 " + current + "，最新 " + best.tag
        + (newer ? "（有新版本）" : "（已是最新）"));
      var info = {
        status: "ok",
        current: current || "",
        latest: best ? best.tag.replace(/^v/, "") : "",
        newer: newer,
        url: (best && best.url) || UPDATE_HOME,
        at: Date.now(),
      };
      // 只缓存成功结果；失败不缓存，但 24h 窗口已开始计时，自动检查不会反复重试。
      lastAutoUpdateAt = Date.now();
      lastUpdateInfo = info;
      sendUpdate(wc, info);
    });
  }

  // 只允许 https + api.github.com + 443；重定向逐跳重新校验，最多 2 跳。
  // deadline 是整个请求链的绝对截止时间（含连接/重定向/慢速滴流）。
  function getJson(url, redirects, deadline, cb) {
    var u;
    try { u = new URL(url); } catch (e) { cb(new Error("地址无效")); return; }
    if (u.protocol !== "https:" || u.hostname !== UPDATE_HOST
      || (u.port && u.port !== "443")) {
      cb(new Error("拒绝非 GitHub API 地址"));
      return;
    }
    var done = false;
    var hardTimer = null;
    function finish(e, data) {
      if (done) return;
      done = true;
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      cb(e, data);
    }
    var req = null;
    // 硬截止：覆盖 DNS/TCP 连接、重定向等待与慢速滴流（socket 空闲超时兜不住）。
    // 在发请求前挂上，重定向时由当前跳负责清掉再递归。
    hardTimer = setTimeout(function () {
      try { if (req) req.destroy(); } catch (e2) {}
      finish(new Error("请求超时"));
    }, Math.max(1, deadline - Date.now()));
    hardTimer.unref && hardTimer.unref();
    try {
      req = https.get({
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "User-Agent": "zcode-lagfix",
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }, function (res) {
        var code = res.statusCode || 0;
        if (code >= 300 && code < 400) {
          var loc = res.headers && res.headers.location;
          res.resume();
          if (!loc) { finish(new Error("重定向缺少地址")); return; }
          if (redirects <= 0) { finish(new Error("重定向次数过多")); return; }
          var next;
          try { next = new URL(loc, url).toString(); } catch (e2) {
            finish(new Error("重定向地址无效"));
            return;
          }
          if (done) return;
          done = true;
          if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          getJson(next, redirects - 1, deadline, cb);
          return;
        }
        var total = 0;
        var chunks = [];
        res.on("data", function (c) {
          total += c.length;
          if (total > UPDATE_MAX_BYTES) {
            try { req.destroy(); } catch (e3) {}
            finish(new Error("响应超过 2MB"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", function () {
          if (code !== 200) {
            finish(new Error(code === 403 ? "GitHub 限流，请稍后再试" : "HTTP " + code));
            return;
          }
          var data = null;
          try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e4) {
            finish(new Error("返回内容不是有效 JSON"));
            return;
          }
          finish(null, data);
        });
        res.on("error", function (e5) { finish(e5); });
      });
    } catch (e) {
      finish(e);
      return;
    }
    req.setTimeout(UPDATE_TIMEOUT_MS, function () {
      try { req.destroy(); } catch (e2) {}
      finish(new Error("请求超时"));
    });
    req.on("error", function (e) { finish(e); });
  }

  try { start(); } catch (e) { log("启动失败：", e && e.message); }
})();
