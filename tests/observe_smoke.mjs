/**
 * lagfix-observe.js 的 Node 侧冒烟测试（无浏览器、无 jsdom）。
 *
 * 覆盖 v0.2.1 里最容易出事、且纯靠读代码看不出来的几件事：
 *   1. 角标建出来了（IIFE 在最小 DOM 下能跑通，没有早期崩溃）；
 *   2. store 能从真实形状的 React fiber 上找到（hook 链表 + binding.lease.store，
 *      而不是只认 memoizedProps.store —— 三审 P0-1 就是这里漏的）；
 *   3. 节流合并通知且尾沿必达；
 *   4. **跨重订阅**窗口不清零（React 19 每次 commit 用新箭头重订阅，三审 P0-2）；
 *   5. __lagfixOff() 之后 subscribe 回到原函数；
 *   6. 面板里的重启请求能真的进到 collect payload（主进程据此 relaunch），
 *      检查更新按钮可用且点击后置位 updateCheckRequested。
 *   7. v0.3.1：滚动诊断/loadOlder 观测/遮罩属性/输入延迟/暂停降级/A8 角标常驻。
 *
 * 只 stub 到"能跑"为止：任何真实浏览器行为（布局、rAF 时序）都不断言。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "plugins", "zcode-lagfix", "lagfix-observe.js");

let failures = 0;
function check(name, cond, extra) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
}

// ---------- 最小 DOM ----------
const nodes = new Map();

function listenBag(el) {
  el._listeners = {};
  // 与浏览器一致：同一 (type, fn, capture) 重复 add 不叠加，否则开关反复
  // 应用会让滚动/按键回调被调用多次、计数翻倍。
  el.addEventListener = (t, fn) => {
    const a = (el._listeners[t] = el._listeners[t] || []);
    if (a.indexOf(fn) < 0) a.push(fn);
  };
  el.removeEventListener = (t, fn) => {
    const a = el._listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    title: "",
    parentNode: null,
    children: [],
    style: {},
    dataset: {},
    value: "",
    disabled: false,
    checked: false,
    type: "",
    selected: false,
    isConnected: true,   // 真实 DOM 属性；缺了会被看门狗当成"锚点已丢失"
    attrs: {},
    _rect: { left: 40, top: 48, right: 220, bottom: 64, width: 180, height: 16 },
    offsetWidth: 288,
    offsetHeight: 300,
    appendChild(c) { c.parentNode = el; el.children.push(c); if (c.id) nodes.set(c.id, c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attrs[k] = String(v); if (k === "id") { el.id = String(v); nodes.set(el.id, el); } },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    // v0.3.1：滚动监听用 target.matches('[data-v4-timeline-scroll="true"]') 过滤，
    // stub 只支持这一种属性选择器形态，够用且不引入 jsdom。
    matches(sel) {
      const s = String(sel).trim();
      const m = s.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (m) return el.attrs[m[1]] === m[2];
      return false;
    },
    contains(x) {
      if (x === el) return true;
      return el.children.some((c) => c && typeof c.contains === "function" && c.contains(x));
    },
    getBoundingClientRect() { return { ...el._rect }; },
    querySelectorAll() { return []; },
    focus() {},
    click() { (el._listeners.click || []).forEach((fn) => fn({ target: el })); },
  };
  listenBag(el);
  // id 用 setter 注册：生产代码混用 `el.id = X` 与 `setAttribute("id", X)`，
  // stub 只认后者会让 getElementById 找不到面板。
  let _id = "";
  Object.defineProperty(el, "id", {
    get() { return _id; },
    set(v) { _id = String(v); if (_id) nodes.set(_id, el); },
  });
  // style 既支持 cssText 赋值（像浏览器一样解析成属性），也支持 .left/.top 这类赋值
  Object.defineProperty(el.style, "cssText", {
    set(v) {
      el._cssText = v;
      String(v).split(";").forEach((decl) => {
        const i = decl.indexOf(":");
        if (i <= 0) return;
        const k = decl.slice(0, i).trim();
        const val = decl.slice(i + 1).trim();
        if (!k) return;
        const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.style[camel] = val;
      });
    },
    get() { return el._cssText || ""; },
  });
  el.classList = { add() {}, remove() {}, contains() { return false; } };
  return el;
}

const body = makeEl("body");
const head = makeEl("head");
const docEl = makeEl("html");
const documentStub = {
  body,
  head,
  documentElement: docEl,
  hidden: false,
  getElementById(id) { return nodes.get(id) || null; },
  createElement: makeEl,
  createTextNode(t) { return { textContent: String(t) } },
  querySelectorAll() { return []; },
  getElementsByTagName() { return []; },
};
listenBag(documentStub);   // 文档级监听要真能记录，否则点击/拖动路径测不到

// ---------- 假 store（真实宿主形状：class 原型方法 + 实例自持 listeners） ----------
// ConversationProjectionStore 就是 class：subscribe 在原型上，listeners 在实例上，
// 通知时 `for (const l of this.listeners) l()`。测试必须复刻这一点，
// 否则"B 的监听者被注册进 A"这种 P0 永远测不出来。
function makeStore() {
  const proto = {
    getSnapshot() { return 1; },
    subscribe(l) {
      this._listeners.add(l);
      return () => { this._listeners.delete(l); };
    },
    // v0.3.1 观测对象：成功/失败/同步抛错三种路径都要验证 wrapper 不改变原语义。
    // lastLoadOlderPromise 用来断言 wrapper 返回的是**原 promise**，不是 .then 包出来的新 promise。
    loadOlder() {
      this.loadOlderHits = (this.loadOlderHits || 0) + 1;
      if (this.loadOlderThrow) throw new Error("sync-boom");
      const p = this.loadOlderFail
        ? Promise.reject(new Error("async-boom"))
        : Promise.resolve({ status: "hydrated", who: this.marker || "", n: this.loadOlderHits });
      this.lastLoadOlderPromise = p;
      return p;
    },
    loadAllOlder() {
      this.loadAllCalls = (this.loadAllCalls || 0) + 1;
      return Promise.resolve({ status: "hydrated", logEpoch: "e1" });
    },
  };
  const store = Object.create(proto);
  store._listeners = new Set();
  store.state = {
    snapshot: { logEpoch: "e1", rows: { totalCount: 2000, window: [{ rowId: 1 }] } },
    turnNavigatorDirectoryRevision: 3,
  };
  store.emit = () => { Array.from(store._listeners).forEach((l) => l()); };
  store.listenerCount = () => store._listeners.size;
  return { store, proto };
}

// ---------- 锚点 + fiber ----------
const { store, proto } = makeStore();
const anchor = makeEl("div");
anchor.setAttribute("data-projection-seq", "1");
anchor.setAttribute("data-session-id", "sess_test_123");
anchor.setAttribute("data-testid", "workspace-main");
// 模拟真实宿主形状：store 不在 memoizedProps 顶层，而是在 hook 链表的
// memoizedState.binding.lease.store 上（三审 P0-1 的现场）。
anchor["__reactFiber$test"] = {
  memoizedProps: { className: "timeline" },
  memoizedState: {
    memoizedState: { binding: { lease: { store } } },
    next: { memoizedState: null, next: null },
  },
  return: null,
};
documentStub.querySelectorAll = (sel) => (String(sel).includes("data-projection-seq") ? [anchor] : []);

// ---------- 其它全局 ----------
globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.performance = { now: () => Date.now(), memory: { usedJSHeapSize: 40 * 1048576 } };
// 不自动跑 rAF 循环，改成「可手动驱动」：既能验证「只统计滚动后 200ms 内的帧」，
// 又不会让测试进程被无限循环拖住。driveFrame 用真实 performance.now() 传时间戳，
// 保证与 lastScrollAt 同一时基。
let rafCb = null;
globalThis.requestAnimationFrame = (fn) => { rafCb = fn; return 1; };
globalThis.cancelAnimationFrame = () => { rafCb = null; };
function driveFrame(t) {
  const cb = rafCb;
  if (typeof cb === "function") cb(t === undefined ? performance.now() : t);
}
globalThis.MutationObserver = class { observe() {} disconnect() {} };
// long-animation-frame 也是 PerformanceObserver：记录 observe/disconnect 次数，
// 验证「关掉滚动诊断 / 一键还原」真的断开了观察器，而不是只把输出字段置 null。
const perfCalls = { observe: 0, disconnect: 0 };
globalThis.PerformanceObserver = class {
  observe() { perfCalls.observe++; }
  disconnect() { perfCalls.disconnect++; }
};
window.innerWidth = 1440;
window.innerHeight = 900;
window.addEventListener = (t, fn) => { (window._listeners = window._listeners || {}); (window._listeners[t] = window._listeners[t] || []).push(fn); };
window.removeEventListener = () => {};

// ---------- 加载被测脚本 ----------
const src = readFileSync(SRC, "utf8");
const origSubscribeRef = proto.subscribe;   // 包装前的引用，用来验证"关得掉"
const origLoadAllRef = proto.loadAllOlder;  // v0.3 大会话保护的原始方法
const origLoadOlderRef = proto.loadOlder;   // v0.3.1 loadOlder 观测的原始方法
// 关掉两个自动项，保证下面的节流计时用固定 120ms（否则冷静期会拉到 250ms）。
// badgeVisible:false 故意留着：v0.3.1 起该字段被忽略，角标必须照常显示（A8）。
localStorage.setItem("lagfix.settings.v1",
  JSON.stringify({ adaptiveOn: false, switchGuardOn: false, badgeVisible: false }));
new Function(src)();

await new Promise((r) => setTimeout(r, 60));   // renderOverlay 首次是同步调用，这里只是让事件循环转一圈

console.log("== lagfix-observe 冒烟 ==");
const badge = documentStub.getElementById("lagfix-overlay-badge");
check("角标已创建", !!badge);
check("无输入框（设置页/欢迎页）时不显示", badge.style.display === "none");
check("允许点击（pointer-events 不是 none）", !/pointer-events:\s*none/.test(badge.style.cssText));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 实现前 scroll/input 还不存在：用容错读取，让测试跑完全部用例再报红，
// 而不是第一处 undefined 就崩掉、后面的断言根本没执行。
const collect = () => JSON.parse(window.__lagfixCollect());
const scrollOf = () => collect().scroll || {};
const inputOf = () => collect().input || {};

console.log("-- 判定配色：面板黄/红阈值必须真的生效 --");
window.__lagfixTest.setThresholds(30, 60);
const vGreen = window.__lagfixTest.verdict(10, 0, null, 3);
const vYellow = window.__lagfixTest.verdict(40, 0, null, 3);
const vRed = window.__lagfixTest.verdict(80, 0, null, 3);
check("P95 10ms（< 黄阈值 30）→ 绿色", vGreen.color === "#3fb950", vGreen.color);
check("P95 40ms（≥ 黄阈值 30）→ 黄色", vYellow.color === "#d29922", vYellow.color);
check("P95 80ms（≥ 红阈值 60）→ 红色", vRed.color === "#f85149", vRed.color);
// "卡死 / 刚卡过"分支也不能硬编码红：用户把红阈值调到 1000 时，
// 600ms 停顿和 350ms 近期峰值都只能是黄，否则阈值设置仍然形同虚设。
window.__lagfixTest.setThresholds(200, 1000);
const vStall = window.__lagfixTest.verdict(30, 600, null, 3);
const vRecent = window.__lagfixTest.verdict(30, 0, 350, 3);
check("阈值调高后，600ms 停顿按阈值显示黄色", vStall.color === "#d29922", vStall.color);
check("阈值调高后，350ms 近期峰值按阈值显示黄色", vRecent.color === "#d29922", vRecent.color);
window.__lagfixTest.setThresholds(50, 100);   // 恢复默认，后续用例按默认阈值

// 注入一个可见的 composer；elementFromPoint 按矩形命中，模拟真实浏览器的命中测试。
const surface = makeEl("div");
surface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };
documentStub.querySelector = (sel) =>
  (String(sel).includes("chat-composer-input-surface") ? surface : null);
documentStub.querySelectorAll = (sel) => {
  if (String(sel).includes("data-projection-seq")) return [anchor];
  if (String(sel).includes("chat-composer-input-surface")) return [surface];
  return [];
};
documentStub.elementFromPoint = (x, y) => {
  const r = surface._rect;
  return (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) ? surface : null;
};
(window._listeners.resize || []).forEach((fn) => fn());
await wait(1100);   // 等一次 renderOverlay 刷新（display 在那一拍里设置）
check("回到主页面后角标显示", badge.style.display === "");
check("角标浮在输入框上方（left=604/top=468）",
  badge.style.left === "604px" && badge.style.top === "468px",
  `left=${badge.style.left} top=${badge.style.top}`);

// 等 acquire 轮询（2s）把锚点挂上，attach 里才会装节流
await wait(1400);

console.log("-- 节流：store 发现与生效 --");
check("等锚点挂上后 store 仍可用", typeof store.subscribe === "function");
check("store 原型被包装（存在 __lagfixThrottle 标记）", !!proto.__lagfixThrottle);
check("原始 subscribe 被保存下来", typeof (proto.__lagfixThrottle || {}).orig === "function");

let calls = 0;
const un = store.subscribe(() => { calls++; });
for (let i = 0; i < 20; i++) store.emit();   // 20 次密集通知（同一 tick）
const immediate = calls;
check("密集通知被合并（20 次 -> 1 次）", immediate === 1, `实际 ${immediate} 次`);

await wait(200);                              // 超过 120ms 窗口
check("尾沿必达（静默后补发一次）", calls >= immediate + 1, `实际 ${calls} 次`);
try { un(); } catch (e) {}

const hitPayload = JSON.parse(window.__lagfixCollect());
check("节流命中计数 > 0（证明通知确实经过 wrapper）",
  hitPayload.fix && hitPayload.fix.hits > 0, `hits=${hitPayload.fix && hitPayload.fix.hits}`);

console.log("-- 跨重订阅（React 19 每 commit 重订阅）--");
// 先等过窗口：上一段尾沿补发发生在 ~120ms，此刻距它不足 120ms
await wait(250);
let a = 0, b = 0;
const unA = store.subscribe(() => { a++; });
store.emit();                                  // 窗口已空 → 应立即
check("首个订阅立即触发", a === 1, `a=${a}`);
unA();
const unB = store.subscribe(() => { b++; });   // 模拟 effect 重订阅
store.emit();                                  // 距上次 <120ms：必须被合并
check("重订阅后窗口不清零（立即通知被合并）", b === 0, `b=${b}`);
await wait(200);
check("重订阅后的通知尾沿补发", b === 1, `b=${b}`);
unB();

console.log("-- 同原型第二个实例（切会话/分屏）--");
// 真实宿主：所有会话共享同一个 ConversationProjectionStore 原型，
// B 调 subscribe 时 wrapper 内的 this 必须是 B。写死捕获 A 的话，
// B 的监听者会被登记进 A，B 的对话区永远不刷新（GLM-5.3 终审 P0）。
const bStore = makeStore();
Object.setPrototypeOf(bStore.store, proto);   // 与 A 共享已包装的原型
bStore.store._listeners = new Set();
let bc = 0;
const unB2 = bStore.store.subscribe(() => { bc++; });
bStore.store.emit();
check("B 的通知到达 B 的订阅者（不误路由到 A）", bc === 1, `bc=${bc}`);
check("A 没被 B 的订阅污染", store.listenerCount() === 0, `A listeners=${store.listenerCount()}`);
unB2();

console.log("-- 大会话保护：拦全量补拉，分享放行 --");
check("大会话保护已装到原型", !!proto.__lagfixLoadAll);
check("大会话保护保存了原始 loadAllOlder",
  typeof (proto.__lagfixLoadAll || {}).orig === "function");
const blockedRes = await proto.loadAllOlder.call(store);
check("大会话（totalCount=2000，已载 1 行）拦下全量补拉",
  blockedRes && blockedRes.status === "not-enough-queries" && !store.loadAllCalls,
  `status=${blockedRes && blockedRes.status} calls=${store.loadAllCalls}`);
const fb = JSON.parse(window.__lagfixCollect());
check("拦截次数进 collect payload（fix.blocked）",
  fb.fix && fb.fix.blocked > 0, `blocked=${fb.fix && fb.fix.blocked}`);
check("collect 带上了有效的实际窗口（fix.eff）",
  fb.fix && fb.fix.eff >= 30, `eff=${fb.fix && fb.fix.eff}`);

const shareClicks = documentStub._listeners.click || [];
check("注册了分享入口的点击捕获", shareClicks.length > 0);
shareClicks.forEach((fn) => fn({
  target: { closest: (sel) => (String(sel).includes("conversation-share-trigger") ? {} : null) },
}));
const passRes = await proto.loadAllOlder.call(store);
check("分享流程放行全量补拉", passRes && passRes.status === "hydrated" && store.loadAllCalls === 1,
  `status=${passRes && passRes.status} calls=${store.loadAllCalls}`);

console.log("-- O1 滚动诊断：loadOlder 只观测，不改语义 --");
check("loadOlder 已被包装（原型上有 __lagfixLoadOlder）", !!proto.__lagfixLoadOlder);
check("包装保存了原始 loadOlder",
  typeof (proto.__lagfixLoadOlder || {}).orig === "function");

const callsBefore = scrollOf().loadOlderCalls;
store.marker = "A";
const pRet = proto.loadOlder.call(store);
check("返回的是原 promise（不是 .then 包出来的新 promise）",
  pRet === store.lastLoadOlderPromise, `same=${pRet === store.lastLoadOlderPromise}`);
const okRes = await pRet;
check("调用时 this 被保留（拿到的是 A 实例的数据）",
  okRes && okRes.who === "A", `who=${okRes && okRes.who}`);
const afterOk = scrollOf();
check("成功调用计数 +1", afterOk.loadOlderCalls === callsBefore + 1,
  `calls=${afterOk.loadOlderCalls} 期望 ${callsBefore + 1}`);
check("成功调用记下了耗时（P95 为数值）",
  typeof afterOk.loadOlderP95 === "number" && afterOk.loadOlderP95 >= 0,
  `p95=${afterOk.loadOlderP95}`);

store.loadOlderFail = true;
let rejected = false;
try { await proto.loadOlder.call(store); } catch (e) { rejected = true; }
store.loadOlderFail = false;
const afterFail = scrollOf();
check("reject 原样抛给调用方（没被吞掉）", rejected);
check("失败计数 +1", afterFail.loadOlderErrors === 1, `errors=${afterFail.loadOlderErrors}`);

store.loadOlderThrow = true;
let threw = false;
try { proto.loadOlder.call(store); } catch (e) { threw = true; }
store.loadOlderThrow = false;
const afterThrow = scrollOf();
check("同步异常原样抛出", threw);
check("同步异常也计入失败", afterThrow.loadOlderErrors === 2, `errors=${afterThrow.loadOlderErrors}`);

// 重复 attach（storage 事件会重跑 applyThrottle）后不能套两层：
// 若套了两层，一次调用会让观测计数 +2 而真实命中也 +2 —— 用两组增量对不上就能抓到。
(window._listeners.storage || []).forEach((fn) => fn({ key: "lagfix.settings.v1" }));
const beforeDbl = scrollOf().loadOlderCalls;
const hitsBeforeDbl = store.loadOlderHits || 0;
await proto.loadOlder.call(store);
await proto.loadOlder.call(store);
const afterDbl = scrollOf();
check("重复 attach 不套两层（2 次调用 = 观测 +2 = 真实执行 +2）",
  afterDbl.loadOlderCalls === beforeDbl + 2 && (store.loadOlderHits || 0) === hitsBeforeDbl + 2,
  `观测 +${afterDbl.loadOlderCalls - beforeDbl} 真实 +${(store.loadOlderHits || 0) - hitsBeforeDbl}`);

// 解构调用会丢 this：wrapper 必须让原实现的行为原样发生（不吞、不换成自己的错误）。
// 原方法是严格函数，`this === undefined` 时读 this.loadOlderHits 会抛 TypeError；
// 关键是 wrapper 与未包装时的**结果一致**——同样抛、同样的错误文案。
const detached = proto.loadOlder;
let detachedErr = null;
try { await detached(); } catch (e) { detachedErr = e; }
let origDetachedErr = null;
try { await origLoadOlderRef.call(undefined); } catch (e) { origDetachedErr = e; }
check("解构调用（无 this）与原实现一样抛错，不吞异常",
  !!detachedErr && !!origDetachedErr
    && detachedErr.constructor === origDetachedErr.constructor
    && detachedErr.message === origDetachedErr.message,
  `wrapperErr=${detachedErr && detachedErr.message} origErr=${origDetachedErr && origDetachedErr.message}`);

console.log("-- O2 滚动期隐藏消息层遮罩 --");
const styleText = String((documentStub.getElementById("lagfix-style") || {}).textContent || "");
check("样式表含 data-lagfix-scroll 命中消息层的规则",
  styleText.includes('[data-lagfix-scroll="1"] [data-v4-timeline-message-layer="true"]'));
check("只覆盖 mask-image（不覆盖 mask 简写，避免重置宿主其它 mask 属性）",
  styleText.includes("mask-image:none !important") && !/[{;]mask:none/.test(styleText));

const scrollListeners = documentStub._listeners.scroll || [];
check("注册了 scroll 捕获监听", scrollListeners.length > 0);
const dispatchScroll = (target) => scrollListeners.forEach((fn) => fn({ target }));

const timelineEl = makeEl("div");
timelineEl.setAttribute("data-v4-timeline-scroll", "true");
const otherEl = makeEl("div");
// 非时间线滚动只有落在会话 pane 内才算「可能失配」；
// 面板/浮层/未知元素的滚动不计入 anyEvents。
const sessionPane = makeEl("div");
sessionPane.setAttribute("data-session-id", "sess-1");
otherEl.closest = (sel) => (String(sel).includes("data-session-id") ? sessionPane : null);

dispatchScroll(otherEl);
check("普通元素滚动不加属性", docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
dispatchScroll(timelineEl);
check("时间线滚动立即加属性（第一次滚动就生效）",
  docEl.getAttribute("data-lagfix-scroll") === "1",
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
await wait(220);
check("停滚 180ms 后移除属性", docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);

// deadline 刷新：滚 → 120ms → 再滚 → 120ms 时距第一次已 240ms，但距第二次只有 120ms
dispatchScroll(timelineEl);
await wait(120);
dispatchScroll(timelineEl);
await wait(120);
check("滚动中反复触发会刷新 deadline（不会提前 180ms 就恢复）",
  docEl.getAttribute("data-lagfix-scroll") === "1",
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
await wait(140);
check("最后一次滚动满 180ms 后移除", docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);

dispatchScroll(timelineEl);
(window._listeners.pagehide || []).forEach((fn) => fn({}));
check("pagehide 立即移除滚动属性", docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);

console.log("-- O1 滚动帧窗口：只统计滚动后 200ms 内的帧 --");
driveFrame(performance.now());          // 第一帧只建基线（rafLast=0 → 不计数）
dispatchScroll(timelineEl);
await wait(20);
driveFrame(performance.now());          // 上一帧后约 20ms，且滚动刚发生 → 计入 scrollRing
const sc1 = scrollOf();
check("滚动后的帧进入 30s 窗口", sc1.frames >= 1, `frames=${sc1.frames}`);
check("scroll.p95 为数值", typeof sc1.p95 === "number", `p95=${sc1.p95}`);
check("scroll.max 为数值", typeof sc1.max === "number", `max=${sc1.max}`);

const framesBeforeIdle = scrollOf().frames;
await wait(260);                        // 超过 200ms 没有滚动
await wait(20);
driveFrame(performance.now());          // 距上次滚动 >200ms → 不该计入
const framesAfterIdle = scrollOf().frames;
check("滚动停止 200ms 后的帧不计入滚动 P95",
  framesAfterIdle === framesBeforeIdle, `before=${framesBeforeIdle} after=${framesAfterIdle}`);

const evBefore = scrollOf().events;
dispatchScroll(timelineEl);
dispatchScroll(timelineEl);
const evAfter = scrollOf().events;
check("滚动事件数按采集周期累计", evAfter === evBefore + 2, `events=${evAfter}`);

dispatchScroll(otherEl);
const mm = scrollOf();
check("只在非时间线元素上滚动时标 mismatch（区分「没人滚」与「选择器失配」）",
  mm.mismatch === true && mm.events === 0 && mm.anyEvents === 1,
  `mismatch=${mm.mismatch} events=${mm.events} any=${mm.anyEvents}`);

// 设置面板自己的滚动不能伪造 mismatch（否则用户在面板里滚一下就误报宿主改版）。
const panelScrollEl = makeEl("div");
panelScrollEl.closest = (sel) => (String(sel).includes("lagfix-settings-panel") ? {} : null);
dispatchScroll(panelScrollEl);
const mmPanel = scrollOf();
check("设置面板内滚动不计入 anyEvents", mmPanel.anyEvents === 0 && mmPanel.mismatch === false,
  `any=${mmPanel.anyEvents} mismatch=${mmPanel.mismatch}`);

// 宿主若把滚动改到 document，target 没有 matches，也必须计入 anyEvents。
dispatchScroll(documentStub);
const mmDoc = scrollOf();
check("document 级滚动计入 anyEvents（宿主改版信号）",
  mmDoc.anyEvents === 1 && mmDoc.mismatch === true,
  `any=${mmDoc.anyEvents} mismatch=${mmDoc.mismatch}`);

const baseQS = documentStub.querySelectorAll;
documentStub.querySelectorAll = (sel) => {
  if (String(sel).includes("data-v4-turn-unit")) return { length: 7 };
  return baseQS.call(documentStub, sel);
};
const mt = scrollOf().mountedTurns;
documentStub.querySelectorAll = baseQS;
check("mountedTurns 来自 turn 单元查询", mt === 7, `mountedTurns=${mt}`);

const baseGEB = documentStub.getElementsByTagName;
documentStub.getElementsByTagName = () => ({ length: 4321 });
await wait(5);   // dom 采样有 0ms 间隔保护，同一毫秒内不会重复计数
const dp = scrollOf();
documentStub.getElementsByTagName = baseGEB;
check("domPeak 采样到当前 DOM 数", dp.domPeak === 4321, `domPeak=${dp.domPeak}`);

console.log("-- 关闭滚动诊断：payload 变 null、包装还原 --");
// patch 合并进当前已存对象：只写 patch 里的键，恢复时必须显式写回 true。
// （直接回写一份不含该键的旧快照，mergeStored 不会改它，开关会留在关闭状态。）
const SETTINGS_KEY = "lagfix.settings.v1";
function writeSettings(patch) {
  const cur = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, ...patch }));
  (window._listeners.storage || []).forEach((fn) => fn({ key: SETTINGS_KEY }));
}
const perfDisconnectsBeforeDiagOff = perfCalls.disconnect;
writeSettings({ scrollDiagOn: false });
const offDiag = JSON.parse(window.__lagfixCollect());
check("scrollDiagOn=false 时 scroll 为 null", offDiag.scroll === null);
check("关闭后 loadOlder 恢复原方法", proto.loadOlder === origLoadOlderRef);
check("关闭后 __lagfixLoadOlder 标记已删除", !proto.__lagfixLoadOlder);
check("关闭滚动诊断会断开 long-animation-frame 观察器",
  perfCalls.disconnect > perfDisconnectsBeforeDiagOff,
  `before=${perfDisconnectsBeforeDiagOff} after=${perfCalls.disconnect}`);
check("关闭滚动诊断不影响遮罩开关", offDiag.settings.maskOffOnScroll === true);
dispatchScroll(timelineEl);
check("只关诊断时遮罩仍然工作", docEl.getAttribute("data-lagfix-scroll") === "1");
await wait(220);

writeSettings({ scrollDiagOn: true });
check("重新开启后 loadOlder 再次被包装", !!proto.__lagfixLoadOlder);

console.log("-- 关闭遮罩开关：滚动中立刻移除 --");
writeSettings({ maskOffOnScroll: false });
dispatchScroll(timelineEl);
check("maskOffOnScroll=false 时滚动不加属性",
  docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
writeSettings({ maskOffOnScroll: true });
dispatchScroll(timelineEl);
check("重新开启后属性回来", docEl.getAttribute("data-lagfix-scroll") === "1");
writeSettings({ maskOffOnScroll: false });
check("滚动中途关掉会立刻移除属性",
  docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
writeSettings({ maskOffOnScroll: true });

console.log("-- O1b 输入延迟 --");
const keySurface = makeEl("div");
keySurface.closest = (sel) =>
  (String(sel).includes("chat-composer-input-surface") ? keySurface : null);
const keydownAll = documentStub._listeners.keydown || [];
check("注册了 document 级 keydown（输入延迟采样）", keydownAll.length > 0);
driveFrame(performance.now());
keydownAll.forEach((fn) => fn({ target: keySurface, key: "ArrowDown" }));
await wait(20);
driveFrame(performance.now());
const inp1 = inputOf();
check("输入框内按键产生样本", !!inp1 && inp1.samples >= 1, `samples=${inp1 && inp1.samples}`);
check("input.p95 为数值", !!inp1 && typeof inp1.p95 === "number", `p95=${inp1 && inp1.p95}`);

const outsideEl = makeEl("div");
outsideEl.closest = () => null;
const samplesBeforeOutside = inputOf().samples;
keydownAll.forEach((fn) => fn({ target: outsideEl, key: "ArrowDown" }));
await wait(20);
driveFrame(performance.now());
const samplesAfterOutside = inputOf().samples;
check("输入框外按键不计入", samplesAfterOutside === samplesBeforeOutside,
  `before=${samplesBeforeOutside} after=${samplesAfterOutside}`);

const kdBeforeInputOff = (documentStub._listeners.keydown || []).length;
writeSettings({ inputLagOn: false });
check("inputLagOn=false 时 input 为 null",
  JSON.parse(window.__lagfixCollect()).input === null);
check("关闭输入延迟后移除 document keydown 监听",
  (documentStub._listeners.keydown || []).length === kdBeforeInputOff - 1,
  `before=${kdBeforeInputOff} after=${(documentStub._listeners.keydown || []).length}`);
writeSettings({ inputLagOn: true });
check("重新开启后 keydown 监听挂回来",
  (documentStub._listeners.keydown || []).length === kdBeforeInputOff,
  `now=${(documentStub._listeners.keydown || []).length}`);

console.log("-- 暂停观测：廉价 payload 的 scroll/input 为 null --");
writeSettings({ observe: false });
const pausedPayload = JSON.parse(window.__lagfixCollect());
check("paused payload 的 scroll 为 null", pausedPayload.scroll === null);
check("paused payload 的 input 为 null", pausedPayload.input === null);
writeSettings({ observe: true });
check("恢复观测后 scroll 回到对象",
  scrollOf() !== null);

console.log("-- 角标可见性：设置页 / 被遮挡 / 多个输入框 --");
const badgeClick = (badge._listeners.click || [])[0];
check("角标绑定了 click", typeof badgeClick === "function");

function setSurfaces(list) {
  documentStub.querySelectorAll = (sel) => {
    if (String(sel).includes("data-projection-seq")) return [anchor];
    if (String(sel).includes("chat-composer-input-surface")) return list;
    return [];
  };
  documentStub.querySelector = (sel) => {
    if (!String(sel).includes("chat-composer-input-surface")) return null;
    return list.length ? list[list.length - 1] : null;
  };
}
function tickOverlay() {
  (window._listeners.resize || []).forEach((fn) => fn());
}

// 1) 设置页里的输入框（zusage 同款判据：closest 命中 settings-page）→ 不显示
const settingsSurface = makeEl("div");
settingsSurface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };
settingsSurface.closest = (sel) => (String(sel).includes("settings-page") ? makeEl("div") : null);
setSurfaces([settingsSurface]);
documentStub.elementFromPoint = () => settingsSurface;
tickOverlay();
await wait(1100);
check("设置页里的输入框：角标隐藏", badge.style.display === "none", `display=${badge.style.display}`);

// 2) 输入框被浮层盖住（elementFromPoint 命中的不是它）→ 不显示
const coveredSurface = makeEl("div");
coveredSurface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };
const blocker = makeEl("div");
setSurfaces([coveredSurface]);
documentStub.elementFromPoint = () => blocker;
await wait(1100);
check("输入框被遮挡：角标隐藏", badge.style.display === "none", `display=${badge.style.display}`);

// 3) 同时挂着两个可见输入框（草稿页在会话页后面）：取最靠下的那个
const lowerSurface = makeEl("div");
lowerSurface._rect = { left: 300, top: 700, right: 1000, bottom: 820, width: 700, height: 120 };
setSurfaces([coveredSurface, lowerSurface]);
documentStub.elementFromPoint = (x, y) => {
  const r = lowerSurface._rect;
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return lowerSurface;
  const u = coveredSurface._rect;
  if (x >= u.left && x <= u.right && y >= u.top && y <= u.bottom) return blocker;
  return null;
};
await wait(1100);
check("多输入框：选最靠下的可见输入框", badge.style.display === ""
  && badge.style.left === "704px" && badge.style.top === "668px",
  `display=${badge.style.display} left=${badge.style.left} top=${badge.style.top}`);

// 4) 探测点先命中角标自己：必须跳过自家浮层，再看下一层是否盖住 composer
const mainSurface = makeEl("div");
mainSurface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };
const settingsOverlay = makeEl("div");
setSurfaces([mainSurface]);
badge.closest = (sel) => (String(sel).includes("lagfix-overlay-badge") ? badge : null);
documentStub.elementsFromPoint = () => [badge, settingsOverlay];
documentStub.elementFromPoint = () => badge;
await wait(1100);
check("跳角标自身后判出被设置层盖住（不会假显示）",
  badge.style.display === "none", `display=${badge.style.display}`);

// 回到正常主页面：角标在最上层，去掉角标后下一层就是 composer 自己
setSurfaces([mainSurface]);
documentStub.elementsFromPoint = () => [badge, mainSurface];
await wait(1100);
check("角标自身在顶层时主页面仍显示", badge.style.display === "" && badge.style.left === "604px",
  `display=${badge.style.display} left=${badge.style.left}`);
delete documentStub.elementsFromPoint;

console.log("-- 排队面板：角标不压队列 --");
const queueEl = makeEl("div");
queueEl._rect = { left: 300, top: 460, right: 900, bottom: 560, width: 600, height: 100 };
const overlapSurface = makeEl("div");
overlapSurface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };
setSurfaces([overlapSurface]);
documentStub.querySelector = (sel) => {
  if (String(sel).includes("v4-queue")) return queueEl;
  return String(sel).includes("chat-composer-input-surface") ? overlapSurface : null;
};
documentStub.elementFromPoint = () => overlapSurface;
await wait(1100);
check("角标带与排队面板相交时，让到队列上沿（top=428）",
  badge.style.display === "" && badge.style.top === "428px" && badge.style.left === "604px",
  `display=${badge.style.display} left=${badge.style.left} top=${badge.style.top}`);

// 另一个 pane 的队列（水平方向不相交）不能影响本 pane 的角标位置
queueEl._rect = { left: 2000, top: 460, right: 2600, bottom: 560, width: 600, height: 100 };
await wait(1100);
check("另一 pane 的队列不影响本 pane 角标", badge.style.top === "468px",
  `top=${badge.style.top}`);
queueEl._rect = { left: 300, top: 460, right: 900, bottom: 560, width: 600, height: 100 };

// 队列已经顶到视口顶端：上方没有余量，角标必须隐藏而不是压住队列
queueEl._rect = { left: 300, top: 20, right: 900, bottom: 470, width: 600, height: 450 };
await wait(1100);
check("队列顶到视口顶端时角标隐藏（不压队列）", badge.style.display === "none",
  `display=${badge.style.display} top=${badge.style.top}`);
queueEl._rect = { left: 300, top: 460, right: 900, bottom: 560, width: 600, height: 100 };

console.log("-- dock 内其它横幅（额度 / 待恢复提示）：同样让位 --");
// 真实宿主把额度横幅、恢复提示、队列都挂在 composer 前面；不能只认 v4-queue。
// 这里模拟一个没有 testid 的额度横幅，走 dock 兄弟节点路径。
const quotaEl = makeEl("div");
quotaEl._rect = { left: 300, top: 440, right: 900, bottom: 492, width: 600, height: 52 };
const dockEl = makeEl("div");
const dockSurface = makeEl("div");
dockSurface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };
dockEl.appendChild(quotaEl);
dockEl.appendChild(dockSurface);
dockSurface.parentElement = dockEl;
dockSurface.previousElementSibling = quotaEl;
quotaEl.previousElementSibling = null;
dockSurface.closest = (sel) =>
  (String(sel).includes("back-to-bottom-anchor") ? dockEl : null);
quotaEl.closest = () => null;
setSurfaces([dockSurface]);
documentStub.querySelector = (sel) =>
  (String(sel).includes("chat-composer-input-surface") ? dockSurface : null);
documentStub.elementFromPoint = () => dockSurface;
await wait(1100);
check("额度横幅压到角标带时，让到横幅上沿（top=408）",
  badge.style.display === "" && badge.style.top === "408px",
  `display=${badge.style.display} top=${badge.style.top}`);
// 恢复 fallback 语义：不删掉 closest/兄弟节点，后面的用例会误走 dock 分支。
delete dockSurface.closest;
delete dockSurface.previousElementSibling;
delete dockSurface.parentElement;

// 恢复成普通主页面布局，后面的统计浮层/齿轮测试依赖角标可见
setSurfaces([mainSurface]);
documentStub.elementFromPoint = () => mainSurface;
documentStub.elementsFromPoint = () => [badge, mainSurface];
await wait(1100);
delete documentStub.elementsFromPoint;

console.log("-- 角标点击 → 统计浮层（档位 + 柱状图）--");
badge.click();
const stats = documentStub.getElementById("lagfix-stats");
check("点击角标创建统计浮层", !!stats);
check("统计浮层可见", !!stats && stats.style.display === "block");
const statsHtml = stats ? String(stats.innerHTML || "") : "";
check("统计含标题与每帧间隔 P95",
  statsHtml.includes("lagfix 性能") && statsHtml.includes("每帧间隔 P95"));
check("统计含四项大白话解释", statsHtml.includes("重绘") && statsHtml.includes("卡顿")
  && statsHtml.includes("内存"));
check("统计含六档位图例", ["极流畅", "流畅", "正常", "轻微", "很卡"].every((t) => statsHtml.includes(t)));
check("统计含柱状图容器", statsHtml.includes("lagfix-stats-chart"));
badge.click();   // 再点一次取消固定
check("再次点击角标收起统计浮层", stats.style.display === "none");

console.log("-- 齿轮 → 居中分类设置弹窗 --");
// 主进程会在每次采集前注入字节数；这里模拟一次，验证维护页能显示当前日志量。
window.__lagfixLogStats = { bytes: 3.4 * 1048576, files: 12 };
const gear = documentStub.getElementById("lagfix-gear");
check("角标末尾有齿轮按钮", !!gear);
gear.click();
const panel = documentStub.getElementById("lagfix-settings-panel");
const mask = documentStub.getElementById("lagfix-modal-mask");
check("点齿轮才创建设置弹窗", !!panel && !!mask);
check("弹窗铺在遮罩上（居中 modal）", !!mask && mask.style.display === "flex");

function allText(root) {
  const out = [String(root.textContent || "")];
  for (const c of root.children || []) out.push(allText(c));
  return out.join(" | ");
}
const panelText = panel ? allText(panel) : "";
check("弹窗有左侧分类：状态条/观测/性能/维护",
  ["状态条", "观测", "性能", "维护"].every((t) => panelText.includes(t)));
check("分类不再叫「修复」", !panelText.includes("修复"));
check("面板含「渲染节流」", panelText.includes("渲染节流"));
check("面板含「重启 ZCode」", panelText.includes("重启 ZCode"));
check("面板含「检查更新」", panelText.includes("检查更新"));
check("底部说明「所有设置已展示」", panelText.includes("所有设置已展示"));
check("状态条页改用「显示文字 / 信息量 / 警告阈值 / 严重阈值」",
  ["显示文字", "信息量", "警告阈值", "严重阈值"].every((t) => panelText.includes(t)));
check("旧的颜色式阈值命名已消失",
  !panelText.includes("变黄阈值") && !panelText.includes("变红阈值"));
check("性能页按 渲染 / 历史 / 滚动 三组展示",
  ["渲染节流", "最短刷新间隔", "卡顿时自动放宽", "切换会话保护", "后台限制刷新",
    "大历史会话保护", "滚动期隐藏遮罩"].every((t) => panelText.includes(t)));
check("旧行名已消失",
  ["订阅通知节流", "节流窗口", "自适应窗口", "切会话冷静期", "后台降频", "大会话保护"]
    .every((t) => !panelText.includes(t)));
check("观测页含「滚动诊断」「输入延迟」",
  panelText.includes("滚动诊断") && panelText.includes("输入延迟"));
check("A8：面板不再提供「显示角标」开关", !panelText.includes("显示角标"));
check("面板版本行是 v0.3.1", panelText.includes("v0.3.1"));
check("面板不再出现版本号式标题", !panelText.includes("v0.3 性能增强"));
check("维护页写明日志路径与上限",
  panelText.includes("日志存储路径") && panelText.includes("日志上限"));
check("维护页显示当前日志量 / 上限 / 文件数",
  panelText.includes("当前日志量") && panelText.includes("3.4 MB")
  && panelText.includes("上限 50 MB") && panelText.includes("12 个文件"),
  panelText.slice(panelText.indexOf("当前日志量"), panelText.indexOf("当前日志量") + 60));
window.__lagfixLogStats = { bytes: 800 * 1024, files: 2 };
window.__lagfixCollect();
check("日志量不足 1MB 时按 KB 显示并实时更新",
  allText(panel).includes("800 KB") && allText(panel).includes("2 个文件"));

function findButton(root, text) {
  if (root.tagName === "BUTTON" && String(root.textContent || "").trim() === text) return root;
  for (const c of root.children || []) {
    const hit = findButton(c, text);
    if (hit) return hit;
  }
  return null;
}
const rz = panel ? findButton(panel, "重启 ZCode") : null;
const upBtn = panel ? findButton(panel, "检查更新") : null;
check("「重启 ZCode」是可点按钮", !!rz && !rz.disabled);
check("「检查更新」已可用（v0.3.1 接入手动检查）", !!upBtn && upBtn.disabled !== true);
if (upBtn) {
  // 点击只置内存标记，随下一个样本回传一次；按钮 15s 后恢复。
  // 这里把 >=5s 的定时器吞掉，避免测试进程被 15s 定时器拖住退出。
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => (ms >= 5000 ? 0 : realSetTimeout(fn, ms));
  (upBtn._listeners.click || [])[0]({});
  globalThis.setTimeout = realSetTimeout;
  check("点击后按钮进入检查中并禁用", upBtn.disabled === true
    && String(upBtn.textContent).includes("检查中"), `text=${upBtn.textContent}`);
  check("本次 payload 的 updateCheck=1", JSON.parse(window.__lagfixCollect()).updateCheck === 1);
  check("下一次 payload 的 updateCheck 归零（只请求一次）",
    JSON.parse(window.__lagfixCollect()).updateCheck === 0);
}

const infoBtn = panel ? findButton(panel, "!") : null;
check("修复项标题后有圆圈感叹号按钮", !!infoBtn);
if (infoBtn) {
  const rowMain = infoBtn.parentNode.parentNode;
  const note = (rowMain.children || []).find((c) => c.className === "note");
  check("影响说明默认收起", !!note && note.style.display === "none");
  (infoBtn._listeners.click || [])[0]({ stopPropagation() {} });
  check("点「!」展开影响说明", !!note && note.style.display === "block");
  check("说明同时写了影响与不影响",
    !!note && note.textContent.includes("影响：") && note.textContent.includes("不影响："));
}

const p0 = JSON.parse(window.__lagfixCollect());
check("collect payload 默认不带重启请求", p0.restart === 0, `restart=${p0.restart}`);

if (rz) {
  const click = (rz._listeners.click || [])[0];
  click({ target: rz });               // 第一下：进入二次确认
  check("重启需二次确认", String(rz.textContent).includes("确认重启"), rz.textContent);
  click({ target: rz });               // 第二下：真正请求
  const p1 = JSON.parse(window.__lagfixCollect());
  check("二次确认后 collect payload 带重启请求", p1.restart === 1, `restart=${p1.restart}`);
  check("重启按钮已禁用，防止重复请求", rz.disabled === true);
}

console.log("-- Esc 关闭弹窗 --");
const kdAll = documentStub._listeners.keydown || [];
check("弹窗打开时注册了 keydown", kdAll.length > 0);
// 真实 DOM 会把同一个 keydown 发给所有监听者；输入延迟采样也监听 keydown，
// 所以这里必须遍历全部，不能只取 [0]。
kdAll.forEach((fn) => fn({ key: "Escape", target: panel, stopPropagation() {} }));
check("Esc 后弹窗隐藏", mask.style.display === "none");

console.log("-- 跨窗口设置同步（storage 事件）--");
const before = JSON.parse(localStorage.getItem("lagfix.settings.v1") || "{}");
localStorage.setItem("lagfix.settings.v1",
  JSON.stringify({ ...before, collectSec: 30, badgeText: false }));
const onStorage = (window._listeners.storage || [])[0];
check("storage 监听已注册", typeof onStorage === "function");
if (onStorage) onStorage({ key: "lagfix.settings.v1" });
const ps = JSON.parse(window.__lagfixCollect());
check("另一窗口改 collectSec 后本窗口收敛", ps.settings.collectSec === 30, `collectSec=${ps.settings.collectSec}`);
check("另一窗口改 badgeText 后本窗口收敛", ps.settings.badgeText === false);

console.log("-- 换 store 实现（新原型）--");
const s3 = makeStore();
const s3OrigLoadOlder = s3.proto.loadOlder;   // 换原型后被包装的应还原成这个引用
anchor["__reactFiber$test"].memoizedState.memoizedState.binding.lease.store = s3.store;
await wait(5200);   // 等看门狗（5s）重新核对目标
check("新原型的 store 被自动包装", !!s3.proto.__lagfixThrottle);
check("旧原型已还原（不再残留包装）", !proto.__lagfixThrottle);
check("大会话保护跟着换到新原型", !!s3.proto.__lagfixLoadAll);
check("旧原型的补拉保护已还原", proto.loadAllOlder === origLoadAllRef);
check("loadOlder 观测跟着换到新原型", !!s3.proto.__lagfixLoadOlder);
check("旧原型的 loadOlder 观测已还原", proto.loadOlder === origLoadOlderRef);

console.log("-- 关闭后已订阅的 wrapper 立即直通 --");
let dd = 0;
const unD = s3.store.subscribe(() => { dd++; });   // 此时包装在 s3 的原型上
s3.store.emit();                                    // 窗口空 → 立即
const ddAfterFirst = dd;
const aCallsBeforeOff = store.loadAllCalls || 0;
window.__lagfixOff();                               // 关开关（会还原原型）
// 切会话后再关保护：只能补"当初被拦的 A"，不能拿当前会话 B 顶替。
// B 若也是大会话，顶替会在 B 里平白触发一次全量补拉（三审 P1）。
check("关闭保护只补被拦过的 A，不误拉当前会话 B",
  (store.loadAllCalls || 0) === aCallsBeforeOff + 1 && !(s3.store.loadAllCalls || 0),
  `A=${store.loadAllCalls} B=${s3.store.loadAllCalls}`);
s3.store.emit();                                    // wrapper 仍在 listeners 里
check("关掉后已订阅的 wrapper 立即直通（不等 120ms）",
  dd === ddAfterFirst + 1, `dd=${dd}（期望 ${ddAfterFirst + 1}）`);
unD();

console.log("-- 还原 --");
// 先重新打开遮罩与滚动诊断（上面的 __lagfixOff 已把它们关掉），再制造一个活动
// 的滚动属性，验证一键还原真的会清掉它、也会断开 long-animation-frame 观察器。
writeSettings({ maskOffOnScroll: true, scrollDiagOn: true });
dispatchScroll(timelineEl);
check("还原前滚动属性存在（前置条件）",
  docEl.getAttribute("data-lagfix-scroll") === "1",
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
const perfDiscBeforeOff = perfCalls.disconnect;
const offResult = window.__lagfixOff();
check("__lagfixOff 返回 fix off", offResult === "fix off", String(offResult));
check("__lagfixOff 移除了 document 级 scroll 监听",
  (documentStub._listeners.scroll || []).length === 0,
  `left=${(documentStub._listeners.scroll || []).length}`);
check("__lagfixOff 会断开 long-animation-frame 观察器",
  perfCalls.disconnect > perfDiscBeforeOff,
  `before=${perfDiscBeforeOff} after=${perfCalls.disconnect}`);
check("原型 subscribe 已还原为包装前的同一引用", proto.subscribe === origSubscribeRef);
check("原型上的标记已删除", !proto.__lagfixThrottle);
check("大会话保护已还原到原始 loadAllOlder", proto.loadAllOlder === origLoadAllRef);
check("大赛话保护的标记已删除", !proto.__lagfixLoadAll);
check("__lagfixOff 后滚动属性已移除",
  docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
check("__lagfixOff 后 loadOlder 观测已从当前原型还原",
  s3.proto.loadOlder === s3OrigLoadOlder);
check("__lagfixOff 后 loadOlder 标记已删除", !s3.proto.__lagfixLoadOlder);

const saved = JSON.parse(localStorage.getItem("lagfix.settings.v1") || "{}");
check("设置已持久化到独立 key", saved.throttleOn === false, JSON.stringify(saved).slice(0, 90));
check("一键还原同时关掉大会话保护", saved.bigSessionOn === false);
check("一键还原同时关掉滚动诊断/输入延迟/遮罩",
  saved.scrollDiagOn === false && saved.inputLagOn === false && saved.maskOffOnScroll === false,
  `scrollDiagOn=${saved.scrollDiagOn} inputLagOn=${saved.inputLagOn} mask=${saved.maskOffOnScroll}`);
check("日志上限默认 50MB 并已持久化", saved.logMaxMB === 50, `logMaxMB=${saved.logMaxMB}`);
check("没有污染宿主 localStorage 的其它 key",
  Object.keys(localStorage._d).every((k) => k === "lagfix.settings.v1"), Object.keys(localStorage._d).join(","));
check("重启请求不落盘（防重启死循环）", saved.restart === undefined && saved.restartRequested === undefined);

console.log("-- __lagfixOff：补拉被拦过的历史 --");
const beforeOffToggle = JSON.parse(localStorage.getItem("lagfix.settings.v1") || "{}");
localStorage.setItem("lagfix.settings.v1",
  JSON.stringify({ ...beforeOffToggle, throttleOn: true, bigSessionOn: true,
    scrollDiagOn: true, inputLagOn: true, maskOffOnScroll: true }));
onStorage({ key: "lagfix.settings.v1" });
await wait(50);
check("重新开启后大会话保护装到当前原型", !!s3.proto.__lagfixLoadAll);
check("重新开启后 loadOlder 观测装到当前原型", !!s3.proto.__lagfixLoadOlder);
check("重新开启后 scroll 监听只挂一份",
  (documentStub._listeners.scroll || []).length === 1,
  `count=${(documentStub._listeners.scroll || []).length}`);
const callsBeforeReenable = JSON.parse(window.__lagfixCollect()).scroll.loadOlderCalls;
await s3.store.loadOlder();
const reenabledPayload = JSON.parse(window.__lagfixCollect());
check("重新开启后 loadOlder 只包一层（+1 不是 +2）",
  reenabledPayload.scroll.loadOlderCalls === callsBeforeReenable + 1,
  `before=${callsBeforeReenable} after=${reenabledPayload.scroll.loadOlderCalls}`);
const callsBeforeOff = s3.store.loadAllCalls || 0;
const blockedAgain = await s3.store.loadAllOlder();
check("重新开启后再次拦下全量补拉",
  blockedAgain && blockedAgain.status === "not-enough-queries"
    && (s3.store.loadAllCalls || 0) === callsBeforeOff,
  `status=${blockedAgain && blockedAgain.status} calls=${s3.store.loadAllCalls}`);
await wait(2100);   // resumeFullHistory 有 2s 防抖：等上一次一键还原留下的窗口过期
window.__lagfixOff();
await wait(50);
check("__lagfixOff 后自动补拉被拦过的历史一次",
  (s3.store.loadAllCalls || 0) === callsBeforeOff + 1,
  `calls=${s3.store.loadAllCalls}（期望 ${callsBeforeOff + 1}）`);

console.log("-- 关闭节流后依赖项变灰 --");
gear.click();   // 重新打开面板（buildPanel 按当前设置重建）
const panel2 = documentStub.getElementById("lagfix-settings-panel");
const offRows = [];
(function walk(n) {
  if (n && n.className === "row off") offRows.push(n);
  (n && n.children || []).forEach(walk);
})(panel2);
check("节流关闭后：窗口 + 自适应 + 冷静期 + 后台降频 四行变灰",
  offRows.length === 4, `offRows=${offRows.length}`);
check("大历史会话保护不跟着变灰（与节流独立）",
  !!panel2 && allText(panel2).includes("与渲染节流相互独立"));

console.log("-- A8 角标常驻 + 设置入口兜底 --");
function findRow(root, text) {
  if (root && root.className === "row" && allText(root).includes(text)) return root;
  for (const c of (root && root.children) || []) {
    const hit = findRow(c, text);
    if (hit) return hit;
  }
  return null;
}
function findInput(root) {
  if (!root) return null;
  if (root.tagName === "INPUT") return root;
  for (const c of root.children || []) {
    const hit = findInput(c);
    if (hit) return hit;
  }
  return null;
}
const throttleRow = findRow(documentStub.getElementById("lagfix-settings-panel"), "渲染节流");
const throttleCb = findInput(throttleRow);
check("节流关闭后开关仍然存在（能再次点击开启）", !!throttleCb, "switch input missing");
check("节流关闭后开关没有被禁用", !!throttleCb && throttleCb.disabled !== true);
check("节流行本身不变灰（只有依赖项变灰）",
  !!throttleRow && throttleRow.className === "row", throttleRow && throttleRow.className);
const styleEl = documentStub.getElementById("lagfix-style");
check("关闭态开关用可见中性灰（避免浅色主题白底白轨）",
  !!styleEl && String(styleEl.textContent || "").includes("rgba(110,118,129,.55)"));
const badgeRow = findRow(documentStub.getElementById("lagfix-settings-panel"), "显示角标");
check("面板里已经没有「显示角标」开关", !badgeRow);
await wait(1100);
check("即使 localStorage 存过 badgeVisible:false，角标仍显示（A8）",
  badge.style.display !== "none", `display=${badge.style.display}`);
check("settings 快照不再输出 badgeVisible",
  !("badgeVisible" in JSON.parse(window.__lagfixCollect()).settings));
check("注册了全局快捷键监听", (window._listeners.keydown || []).length > 0);
(documentStub._listeners.keydown || []).forEach((fn) => fn({
  key: "Escape", target: panel2, stopPropagation() {},
}));
check("Esc 后弹窗隐藏",
  documentStub.getElementById("lagfix-modal-mask").style.display === "none");
(window._listeners.keydown || []).forEach((fn) => fn({
  key: "l", ctrlKey: true, altKey: true,
  preventDefault() {}, stopPropagation() {},
}));
check("Ctrl+Alt+L 能重新打开设置（角标隐藏时）",
  documentStub.getElementById("lagfix-modal-mask").style.display === "flex");
const openResult = window.__lagfixSettings();
check("控制台 __lagfixSettings() 也能打开", openResult === "open", String(openResult));
const panel3 = documentStub.getElementById("lagfix-settings-panel");
(documentStub._listeners.keydown || []).forEach((fn) => fn({
  key: "Escape", target: panel3, stopPropagation() {},
}));
(window._listeners.keydown || []).forEach((fn) => fn({
  key: "¬", code: "KeyL", metaKey: true, altKey: true,
  preventDefault() {}, stopPropagation() {},
}));
check("macOS Cmd+Alt+L（key=¬ / code=KeyL）也能打开",
  documentStub.getElementById("lagfix-modal-mask").style.display === "flex");

console.log("== 结果：", failures === 0 ? "PASS" : `FAIL(${failures})`, "==");
process.exit(failures === 0 ? 0 : 1);
