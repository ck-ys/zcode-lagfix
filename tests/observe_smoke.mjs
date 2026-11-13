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
    // v0.3.2：按会话统计子树节点/挂载 turn 时用；真实 DOM 是 HTMLCollection，
    // 这里只要 length 与逐项 getAttribute 可用即可。
    getElementsByTagName() { return el._all || []; },
    querySelectorAll(sel) {
      return String(sel).includes("data-v4-turn-unit") ? (el._turns || []) : [];
    },
    checkVisibility() { return el._visible !== false; },
    focus() { try { documentStub.activeElement = el; } catch (e) {} },
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
  activeElement: body,
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
      this.loadOlderArgs = Array.from(arguments);
      this.loadOlderHits = (this.loadOlderHits || 0) + 1;
      if (this.loadOlderThrow) throw new Error("sync-boom");
      // v0.4.3：真实的 loadOlder 有网络/后端耗时（不是同步 resolve），
      // 需要在断言里验证「耗时确实被记到切换归因」时显式开一个短延迟。
      if (this.loadOlderDelayMs) {
        const delay = this.loadOlderDelayMs;
        this.loadOlderDelayMs = 0;
        const p = new Promise((resolve) => setTimeout(
          () => resolve({ status: "hydrated", who: this.marker || "", n: this.loadOlderHits }),
          delay));
        this.lastLoadOlderPromise = p;
        return p;
      }
      // v0.3.2：模拟宿主 loadOlder 往 rows.window 追加一页，用于验证
      // rowsBefore/rowsAfter 只读长度、不读内容。
      if (this.loadOlderGrow) {
        const w = this.state.snapshot.rows.window;
        const n = this.loadOlderGrow;
        this.loadOlderGrow = 0;
        for (let i = 0; i < n; i++) w.push({ rowId: "g" + i });
      }
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

// ---------- v0.3.2：第二个会话 pane（默认不挂进 DOM 列表，测试中再 push） ----------
function makeSubtree(n, turns) {
  return Array.from({ length: n }, (_, i) => {
    const e = makeEl("span");
    if (i < turns) e.setAttribute("data-v4-turn-unit", "true");
    return e;
  });
}
anchor._all = makeSubtree(80, 2);
anchor._visible = true;
const paneB = makeEl("div");
paneB.setAttribute("data-session-id", "sess_b");
paneB._rect = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
paneB._all = makeSubtree(120, 3);
paneB._visible = true;
const sessionPaneList = [anchor];
let sessionQueryCount = 0;
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
documentStub.querySelectorAll = (sel) => {
  if (String(sel).includes("data-projection-seq")) return [anchor];
  if (String(sel).includes("data-session-id")) { sessionQueryCount++; return sessionPaneList; }
  return [];
};

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
// v0.3.2：MutationObserver 要能手动触发，验证按 sid 的提交归因。
// 同一 target 重复 observe 只保留一份（与浏览器语义一致），避免测试把
// "重复观察"误判成两次提交。
const moInstances = [];
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; this.targets = []; moInstances.push(this); }
  observe(target, opts) {
    const hit = this.targets.find((t) => t.target === target);
    if (hit) hit.opts = opts || {};
    else this.targets.push({ target, opts: opts || {} });
  }
  disconnect() { this.targets = []; }
};
function fireMutation(target, name, oldValue) {
  for (const inst of moInstances) {
    if (!inst.targets.some((t) => t.target === target)) continue;
    inst.cb([{ type: "attributes", target, attributeName: name, oldValue }], inst);
  }
}
// 真实宿主的 seq 每次提交都会变成新值；测试默认模拟“真的变化”，
// 另留 fireMutation 给“同值重写”这类回归用例。
function fireAttr(target, name) {
  if (name === "data-projection-seq") {
    const cur = Number(target.getAttribute(name) || 0);
    target.setAttribute(name, String((Number.isFinite(cur) ? cur : 0) + 1));
  }
  fireMutation(target, name);
}
// long-animation-frame 也是 PerformanceObserver：记录 observe/disconnect 次数，
// 验证「关掉滚动诊断 / 一键还原」真的断开了观察器，而不是只把输出字段置 null。
const perfCalls = { observe: 0, disconnect: 0 };
// v0.3.4：要能向 LoAF 观察器投递假条目（P0 归因用），实例记录 cb 与观察类型。
const perfInstances = [];
globalThis.PerformanceObserver = class {
  constructor(cb) { this.cb = cb; this.observing = null; perfInstances.push(this); }
  observe(opts) {
    perfCalls.observe++;
    this.observing = opts && (opts.type || (opts.entryTypes && opts.entryTypes[0])) || null;
  }
  disconnect() { perfCalls.disconnect++; this.observing = null; }
};
function fireLoAF(entries) {
  const inst = perfInstances.filter((i) => i.observing === "long-animation-frame").pop();
  if (!inst) throw new Error("no active long-animation-frame observer");
  inst.cb({ getEntries: () => entries });
}
window.innerWidth = 1440;
window.innerHeight = 900;
window.addEventListener = (t, fn) => {
  const bag = (window._listeners = window._listeners || {});
  const arr = (bag[t] = bag[t] || []);
  if (arr.indexOf(fn) < 0) arr.push(fn);   // 与真实 DOM 一致：同函数同阶段只挂一次
};
window.removeEventListener = (t, fn) => {
  const arr = (window._listeners || {})[t];
  if (!arr) return;
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
};

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

// v0.3.4：在任何人 writeSettings 之前抓一份初始设置快照——后面的「默认值」断言
// 必须读它，否则读到的可能是被前面用例改过的持久化值，DEFAULTS 改错也能过。
const initialSettings = JSON.parse(window.__lagfixCollect()).settings;

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
  if (String(sel).includes("data-session-id")) { sessionQueryCount++; return sessionPaneList; }
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
check("loadOlder 已被包装（主 store 实例上有 __lagfixLoadOlder）", !!store.__lagfixLoadOlder);
check("包装保存了原始 loadOlder",
  (store.__lagfixLoadOlder || {}).orig === origLoadOlderRef);
check("共享原型没有被改动（隐藏会话的 loadOlder 不受影响）",
  proto.__lagfixLoadOlder === undefined && proto.loadOlder === origLoadOlderRef);

const callsBefore = scrollOf().loadOlderCalls;
store.marker = "A";
const pRet = store.loadOlder();
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
try { await store.loadOlder(); } catch (e) { rejected = true; }
store.loadOlderFail = false;
const afterFail = scrollOf();
check("reject 原样抛给调用方（没被吞掉）", rejected);
check("失败计数 +1", afterFail.loadOlderErrors === 1, `errors=${afterFail.loadOlderErrors}`);

store.loadOlderThrow = true;
let threw = false;
try { store.loadOlder(); } catch (e) { threw = true; }
store.loadOlderThrow = false;
const afterThrow = scrollOf();
check("同步异常原样抛出", threw);
check("同步异常也计入失败", afterThrow.loadOlderErrors === 2, `errors=${afterThrow.loadOlderErrors}`);

// 重复 attach（storage 事件会重跑 applyThrottle）后不能套两层：
// 若套了两层，一次调用会让观测计数 +2 而真实命中也 +2 —— 用两组增量对不上就能抓到。
(window._listeners.storage || []).forEach((fn) => fn({ key: "lagfix.settings.v1" }));
const beforeDbl = scrollOf().loadOlderCalls;
const hitsBeforeDbl = store.loadOlderHits || 0;
await store.loadOlder();
await store.loadOlder();
const afterDbl = scrollOf();
check("重复 attach 不套两层（2 次调用 = 观测 +2 = 真实执行 +2）",
  afterDbl.loadOlderCalls === beforeDbl + 2 && (store.loadOlderHits || 0) === hitsBeforeDbl + 2,
  `观测 +${afterDbl.loadOlderCalls - beforeDbl} 真实 +${(store.loadOlderHits || 0) - hitsBeforeDbl}`);

// 解构调用会丢 this：wrapper 必须让原实现的行为原样发生（不吞、不换成自己的错误）。
// 原方法是严格函数，`this === undefined` 时读 this.loadOlderHits 会抛 TypeError；
// 关键是 wrapper 与未包装时的**结果一致**——同样抛、同样的错误文案。
const detached = store.loadOlder;
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
// 读实时列表：后面的用例会按开关摘/挂 scroll 监听，快照可能是旧的。
const dispatchScroll = (target) =>
  (documentStub._listeners.scroll || []).forEach((fn) => fn({ target }));

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

// 会话 pane 外的宿主区域（设置页、侧栏）滚动不是「宿主改版」信号，不计数。
const outsidePaneEl = makeEl("div");
outsidePaneEl.closest = () => null;
dispatchScroll(outsidePaneEl);
const mmOutside = scrollOf();
check("会话 pane 外的滚动不计入 anyEvents",
  mmOutside.anyEvents === 0 && mmOutside.mismatch === false,
  `any=${mmOutside.anyEvents} mismatch=${mmOutside.mismatch}`);

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
check("关闭后 loadOlder 恢复原方法",
  store.loadOlder === origLoadOlderRef && !Object.prototype.hasOwnProperty.call(store, "loadOlder"));
check("关闭后主 store 上的包装标记已删除", !store.__lagfixLoadOlder);
check("关闭后 __lagfixLoadOlder 标记已删除", !proto.__lagfixLoadOlder);
// v0.3.4：LoAF 观察器同时服务滚动诊断与卡顿归因；lafDiagOn 默认开，
// 只关 scrollDiagOn 不得断开观察器（归因还在用），两个都关才断。
check("只关滚动诊断时 LoAF 观察器仍保留（lafDiagOn 还开着）",
  perfCalls.disconnect === perfDisconnectsBeforeDiagOff,
  `before=${perfDisconnectsBeforeDiagOff} after=${perfCalls.disconnect}`);
const perfDisconnectsBeforeLafOff = perfCalls.disconnect;
writeSettings({ lafDiagOn: false });
check("lafDiagOn 也关掉后 LoAF 观察器断开",
  perfCalls.disconnect > perfDisconnectsBeforeLafOff,
  `before=${perfDisconnectsBeforeLafOff} after=${perfCalls.disconnect}`);
check("lafDiagOn=false 时样本 laf 为 null", JSON.parse(window.__lagfixCollect()).laf === null);
writeSettings({ lafDiagOn: true });
check("关闭滚动诊断不影响遮罩开关", offDiag.settings.maskOffOnScroll === true);
dispatchScroll(timelineEl);
check("只关诊断时遮罩仍然工作", docEl.getAttribute("data-lagfix-scroll") === "1");
await wait(220);

writeSettings({ scrollDiagOn: true });
check("重新开启后 loadOlder 再次被包装", !!store.__lagfixLoadOlder);

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

console.log("-- v0.3.4 O3：翻页降频 --");
// 必须在 loadOlderTarget 仍是 store A 的段落测：后面的多会话用例会把包装
// 指到别的 store 实例（applyLoadOlderProbe 换目标时释放旧包装）。
// v0.3.4 终审修复：只对**滚动触发**降频——宿主 SessionPane 对首 turn 缺 header
// 的自动补拉是 cursor 去重的，跳过就不会重试，绝不能碰。所以每个「预期被降频」
// 的调用前都要先 dispatchScroll 刷新滚动信号。
// v0.4.3：首调/挂载窗口（5 秒）内一律放行以保护宿主冷快照修复补拉；测试跑到
// 这里通常还在挂载窗口内，先等过去，否则整段降频都会被豁免。
await wait(5200);
check("O3 前置：loadOlder 已包装", !!store.__lagfixLoadOlder);
const winRows = store.state.snapshot.rows.window;
const paceScroll = () => dispatchScroll(timelineEl);
writeSettings({ loadOlderPaceOn: true });
const pace0 = JSON.parse(window.__lagfixCollect()).pace;
check("pace 快照带拍板参数", pace0 && pace0.minRows === 3000 && pace0.intervalMs === 600,
  JSON.stringify(pace0));
// 小窗口（远小于 3000 行）：连发不计时
const smallHitsBefore = store.loadOlderHits || 0;
paceScroll();
await store.loadOlder();
paceScroll();
await store.loadOlder();
check("小窗口连发两次都放行", (store.loadOlderHits || 0) === smallHitsBefore + 2,
  `hits=${store.loadOlderHits}`);
// 大窗口：第一次放行，600ms 内的第二次跳过
for (let i = 0; i < 3200; i++) winRows.push({ rowId: "pace" + i });
const bigHitsBefore = store.loadOlderHits || 0;
const loCallsBefore = scrollOf().loadOlderCalls;
const detailRingBefore = window.__lagfixDiag().loadOlderDetail;
paceScroll();
const p1 = store.loadOlder();   // 放行（lastAllowedAt 初值 -1e9）
paceScroll();
const p2 = store.loadOlder();   // 距上次 <600ms → 跳过
check("大窗口第一次放行、第二次跳过（原方法只执行一次）",
  (store.loadOlderHits || 0) === bigHitsBefore + 1, `hits=${store.loadOlderHits}`);
check("跳过的调用返回 promise", typeof p2.then === "function");
// 真正验证「已结算」：0ms 竞速，未结算会落到 timeout 分支。
const p2Race = await Promise.race([p2.then(() => "settled"), wait(0).then(() => "pending")]);
check("跳过的调用返回的是已结算 promise（不会悬挂）", p2Race === "settled", `race=${p2Race}`);
await Promise.all([p1, p2]);
check("跳过的调用不进明细环（只有放行的那次被记录）",
  window.__lagfixDiag().loadOlderDetail === detailRingBefore + 1,
  `before=${detailRingBefore} after=${window.__lagfixDiag().loadOlderDetail}`);
const pace1 = JSON.parse(window.__lagfixCollect()).pace;
check("pace 计数：allowed 含小窗口放行，skipped 只计跳过",
  pace1.allowed === 3 && pace1.skipped === 1,
  JSON.stringify(pace1));
check("跳过的调用不计入 loadOlderCalls（没发生的调用不能记账）",
  scrollOf().loadOlderCalls === loCallsBefore + 1,
  `calls=${scrollOf().loadOlderCalls}`);
await wait(650);                 // 超过 600ms 间隔
paceScroll();
await store.loadOlder();
check("间隔超过 600ms 后再次放行", (store.loadOlderHits || 0) === bigHitsBefore + 2,
  `hits=${store.loadOlderHits}`);
// v0.4.3：触发口径改为时间窗（距最近时间线滚动 ≤2s，与明细分类同源）。
// 非滚动触发 = 距上次滚动超过 2s：不受 600ms 间隔约束，永不跳过——
// 宿主非滚动补拉（首 turn 缺 header 的自动补齐）被跳过后不会重试。
await wait(650);
paceScroll();
await store.loadOlder();        // 放行并刷新 lastAllowedAt
const nonScrollBefore = store.loadOlderHits || 0;
await wait(2100);               // 超过 2s 滚动识别窗口 → 非滚动触发
await store.loadOlder();
check("距滚动超过 2s 的补页永不跳过（首 turn header 不会被吞）",
  (store.loadOlderHits || 0) === nonScrollBefore + 1,
  `hits=${store.loadOlderHits}`);
// v0.4.3 首调豁免：新 store（重装包装）的第一次调用即使带着新鲜滚动信号、
// 距上次放行不足 600ms 也放行。旧的 P1-1「合成 scroll 后 effect 补拉不跳过」
// 口径已废除：3.18.2 上宿主全部滚动补页都经 rAF 异步触发，旧同步门控永不
// 命中（见 docs/specs/v0.4.3-session-switch-and-pace.md §1.2），由首调豁免兜底。
const firstCallHits = store.loadOlderHits || 0;
writeSettings({ scrollDiagOn: false, loadOlderPaceOn: false });   // 卸载包装
writeSettings({ scrollDiagOn: true, loadOlderPaceOn: true });     // 重装：callsInWrap 归零
paceScroll();                     // 新鲜滚动信号
await store.loadOlder();          // 新包装首调：豁免，必须放行（不刷新 lastAllowedAt）
check("新包装首调豁免：带滚动信号也放行（SessionPane 修复补拉）",
  (store.loadOlderHits || 0) === firstCallHits + 1, `hits=${store.loadOlderHits}`);
paceScroll();
await store.loadOlder();          // 首调后的滚动触发：距上次放行 >600ms → 放行并计时
check("首调之后恢复降频计时（本次放行）",
  (store.loadOlderHits || 0) === firstCallHits + 2, `hits=${store.loadOlderHits}`);
paceScroll();
const pFirst2 = store.loadOlder();  // 600ms 内的第二次滚动触发 → 跳过
await pFirst2;
check("600ms 内的第二次滚动触发被跳过",
  (store.loadOlderHits || 0) === firstCallHits + 2, `hits=${store.loadOlderHits}`);
writeSettings({ loadOlderPaceOn: false });
paceScroll();
await store.loadOlder();
paceScroll();
await store.loadOlder();
check("开关关闭后连发全部放行", (store.loadOlderHits || 0) === nonScrollBefore + 5,
  `hits=${store.loadOlderHits}`);
check("关闭后样本 pace 为 null", JSON.parse(window.__lagfixCollect()).pace === null);
// 观测（scrollDiagOn）与降频独立：只关诊断时包装保留、降频继续
writeSettings({ scrollDiagOn: false, loadOlderPaceOn: true });
check("只关滚动诊断时降频包装保留", !!store.__lagfixLoadOlder);
await wait(650);                // 上次放行就在几个微任务之前：先真正等过间隔
paceScroll();                   // pace 开时滚动监听仍在（scrollWatchNeeded 含 loadOlderPaceOn）
await store.loadOlder();        // 放行
paceScroll();
await store.loadOlder();        // <600ms → 跳过
check("scrollDiagOn 关但 pace 开：大窗口仍降频", (store.loadOlderHits || 0) === nonScrollBefore + 6,
  `hits=${store.loadOlderHits}`);
writeSettings({ scrollDiagOn: true, loadOlderPaceOn: false });
check("恢复后 wrapper 仍可用（观测语义）", !!store.__lagfixLoadOlder);
// P1-2（终审）：诊断关闭会清环，但降频开着时包装不卸载。关闭前发出的调用
// 在关闭后 resolve，不能把数据写回已清空的环（否则「关→开」后会被当成新明细）。
// v0.4.3：先等过 2s 滚动窗口，让这次调用走非滚动路径真正执行（否则会被新
// 口径判成滚动触发而跳过，P1-2 就没有在途调用了）。
writeSettings({ loadOlderPaceOn: true });
check("P1-2 前置：pace 开时包装在", !!store.__lagfixLoadOlder);
await wait(2100);
store.loadOlderGrow = 1;
const inFlight = store.loadOlder();          // 在途
writeSettings({ scrollDiagOn: false });      // 关闭诊断：清环但不卸载包装
writeSettings({ scrollDiagOn: true });       // 立刻重开：不能带回关闭前那次
await inFlight;
const revived = collect();
check("关闭前在途的补页不写回重开后的环（P1-2）",
  window.__lagfixDiag().loadOlderDetail === 0
    && (revived.scroll === null || (revived.scroll && revived.scroll.loadOlderCalls === 0)),
  `detail=${window.__lagfixDiag().loadOlderDetail} calls=${revived.scroll && revived.scroll.loadOlderCalls}`);
writeSettings({ loadOlderPaceOn: false });
// 包装被卸载再重装后 pace 计数归零（换主 store 重建包装同此口径）
writeSettings({ scrollDiagOn: false, loadOlderPaceOn: false });
check("两开关同关后包装卸载", !store.__lagfixLoadOlder);
writeSettings({ scrollDiagOn: false, loadOlderPaceOn: true });
const paceFresh = JSON.parse(window.__lagfixCollect()).pace;
check("包装重装后 pace 计数归零",
  paceFresh && paceFresh.allowed === 0 && paceFresh.skipped === 0,
  JSON.stringify(paceFresh));
check("pace 全天累计跨包装重装保留（v0.4.3 双口径）",
  paceFresh && paceFresh.totalAllowed > 0 && paceFresh.totalSkipped > 0,
  JSON.stringify(paceFresh));
// v0.4.3 三审 P1-1 回归：包装在 scrollDiagOn=false 下冷装时，调用计数也必须
// 递增（旧实现把 callsInWrap++ 放在滚动诊断分支里，关诊断就永久首调豁免，
// 降频静默失效）——并且要模拟宿主 rAF 异步派发：滚动与调用之间隔一个宏任务。
const coldBase = store.loadOlderHits || 0;
paceScroll();
await store.loadOlder();        // 冷装首调：豁免（保护 SessionPane 修复补拉）
paceScroll();
await store.loadOlder();        // 首调后的滚动触发：放行并开始计时
paceScroll();
await wait(0);                  // 宿主异步派生 scroll → 下一任务才调 loadOlder
const pColdSkip = store.loadOlder();   // 600ms 内的第二次滚动触发 → 跳过
await pColdSkip;
const paceCold = JSON.parse(window.__lagfixCollect()).pace;
check("scrollDiagOn=false 冷装后首调不吞、随后仍能降频（P1-1）",
  (store.loadOlderHits || 0) === coldBase + 2,
  `hits=${store.loadOlderHits}`);
check("冷装后的降频计数：2 放行 / 1 跳过",
  paceCold && paceCold.allowed === 2 && paceCold.skipped === 1,
  JSON.stringify(paceCold));
// v0.4.3 三审 P2：无关开关触发 applyScrollSettings 时，不能把正在累计的
// 「关→开」误判出来清零（lastPaceOn 已按当前设置播种）。
writeSettings({ inputLagOn: false });
writeSettings({ inputLagOn: true });
const paceAfterUnrelated = JSON.parse(window.__lagfixCollect()).pace;
check("无关开关切换不清零本轮降频计数",
  paceAfterUnrelated && paceAfterUnrelated.allowed === 2
    && paceAfterUnrelated.skipped === 1,
  JSON.stringify(paceAfterUnrelated));
writeSettings({ scrollDiagOn: true, loadOlderPaceOn: false });
winRows.length = 1;             // 还原小窗口，不影响后续用例

console.log("-- v0.4.3 O8b：补页批量退役 --");
// v0.4.3 退役：loadOlderPageLimitOn 不再有行为实现；旧设置键读取时忽略。
check("新样本 settings 不含已退役键", collect().settings.loadOlderPageLimitOn === undefined);
check("新样本无 page 字段", collect().page === undefined, JSON.stringify(collect().page));
// 旧 localStorage 残留 loadOlderPageLimitOn=true：读入忽略、不报错、不装包装。
writeSettings({ scrollDiagOn: false, loadOlderPaceOn: false, loadOlderPageLimitOn: true });
check("旧键残留时两有效开关同关仍卸载包装", !store.__lagfixLoadOlder);
await store.loadOlder();
check("退役后无参调用回到宿主默认（不传 limit）",
  JSON.stringify(store.loadOlderArgs) === "[]", JSON.stringify(store.loadOlderArgs));
check("退役后样本仍无 page 字段", collect().page === undefined);
// 有效开关恢复后包装回来，残留旧键不产生任何行为。
writeSettings({ scrollDiagOn: true, loadOlderPaceOn: false });
check("滚动诊断恢复后包装回来", !!store.__lagfixLoadOlder);
await store.loadOlder();
check("残留旧键不改变页大小语义",
  JSON.stringify(store.loadOlderArgs) === "[]", JSON.stringify(store.loadOlderArgs));
winRows.length = 1;
writeSettings({ loadOlderPageLimitOn: false });   // 写回 false 不报错（清理残留键）

console.log("-- v0.4.3 P0：会话切换归因（只读） --");
// 这一段必须在多会话用例之前：后面会把 paneB 挂进 DOM 并断言 A 桶 sid 仍是
// sess_test_123，所以结尾必须把锚点 sid 还原。
const switchOf = () => collect().switch;
const switchRingLen = () => window.__lagfixDiag().switchDiag.records;
check("默认 switchDiagOn=true（读加载时快照）", initialSettings.switchDiagOn === true,
  `snapshot=${initialSettings.switchDiagOn}`);
const swInit = switchOf();
check("样本 switch 结构为 {on:1, items:[...]}",
  !!swInit && swInit.on === 1 && Array.isArray(swInit.items), JSON.stringify(swInit));

// A1：原地切会话（宿主只改 data-session-id，seq 不变）→ MO 必须记一条。
// 先把帧基线对齐：否则跨用例的长间隔会当成一帧落进 2s 切片。
const swBase = switchRingLen();
driveFrame(performance.now());
anchor.setAttribute("data-session-id", "sess_alpha_1");
fireMutation(anchor, "data-session-id");
const sw1 = switchOf();
check("切会话后立刻采样带 items（不是 []）",
  Array.isArray(sw1.items) && sw1.items.length === swBase + 1,
  `base=${swBase} now=${sw1.items && sw1.items.length}`);
const rec1 = sw1.items[sw1.items.length - 1];
check("from/to 只留 sid 前 8 字符，空串原样",
  rec1.from === "sess_tes" && rec1.to === "sess_alp", JSON.stringify([rec1.from, rec1.to]));
check("首挂载记录仍在环里（from=\"\"，供首屏归因）",
  sw1.items.some((r) => r.from === ""), JSON.stringify(sw1.items.map((r) => r.from)));
check("未满 30 秒不冻结：settled=0，after 值占位 null",
  rec1.settled === 0 && rec1.afterMax2s === null && rec1.domAfter === null
    && rec1.turnsAfter === null && rec1.blockedLoadAll === null,
  JSON.stringify({ settled: rec1.settled, max: rec1.afterMax2s, dom: rec1.domAfter }));

// A2：150ms 内第二次 sid 抖动只算同一次切换，to 取最后值、from 保持首次。
anchor.setAttribute("data-session-id", "sess_beta_2");
fireMutation(anchor, "data-session-id");
const sw2 = switchOf();
check("150ms 内二次 sid 抖动不新增记录",
  sw2.items.length === swBase + 1, `n=${sw2.items.length}`);
const rec2 = sw2.items[sw2.items.length - 1];
check("去重后 to 取最后值、from 保持首次",
  rec2.from === "sess_tes" && rec2.to === "sess_bet", JSON.stringify([rec2.from, rec2.to]));

// 2s 帧切片：再驱动两帧（120ms / 180ms）+ 一条 220ms 长帧（forced layout 90ms）。
const swT = performance.now();
driveFrame(swT + 120);
driveFrame(swT + 300);
fireLoAF([{ duration: 220, scripts: [{ sourceURL: "https://x/a.js", invoker: "f",
  duration: 200, forcedStyleAndLayoutDuration: 90 }] }]);
// v0.4.3 三审：真实补页有耗时，不能只用「>= 0」这种永真断言。
store.loadOlderDelayMs = 40;
await store.loadOlder();          // 成功补页（≈40ms）→ 30s 窗口计一次
const sw3 = switchOf();
const rec3 = sw3.items[sw3.items.length - 1];
check("2s 帧切片产出 afterMax2s/afterP95",
  rec3.afterMax2s >= 120 && typeof rec3.afterP95 === "number",
  `max=${rec3.afterMax2s} p95=${rec3.afterP95}`);
check("2s 内长帧进 lafN2s/styleMs2s",
  rec3.lafN2s === 1 && rec3.styleMs2s === 90, `n=${rec3.lafN2s} style=${rec3.styleMs2s}`);
check("30s 窗口同步累加长帧",
  rec3.lafN30s >= 1 && rec3.styleMs30s >= 90, `n=${rec3.lafN30s} style=${rec3.styleMs30s}`);
check("30s 窗口记到成功补页次数与真实耗时",
  rec3.loadOlderN30s >= 1 && rec3.loadOlderMs30s >= 20,
  `n=${rec3.loadOlderN30s} ms=${rec3.loadOlderMs30s}`);

// 指纹只靠帧切片也要重发：切到 rec3 后没有新长帧/补页，只驱动一帧。
switchOf();                        // 消费当前指纹（上一断言已取过一次）
driveFrame(swT + 480);             // 距上一帧 180ms，仍在 rec3 的 2s 切片窗口内
const swFrameOnly = switchOf();
check("只有帧切片变化时样本也会重发（帧已进指纹）",
  Array.isArray(swFrameOnly.items) && swFrameOnly.items.length > 0
    && swFrameOnly.items[swFrameOnly.items.length - 1].afterMax2s >= 180,
  JSON.stringify(swFrameOnly.items && swFrameOnly.items.slice(-1)));

// v0.4.3 三审 P2：A→B→A 的 150ms 内往返不能留下 from===to 的伪切换。
await wait(160);                 // 越过与上一条的去重窗口
anchor.setAttribute("data-session-id", "sess_round_1");
fireMutation(anchor, "data-session-id");
const swRoundOut = switchOf();
const roundLen = swRoundOut.items.length;
anchor.setAttribute("data-session-id", "sess_beta_2");
fireMutation(anchor, "data-session-id");   // 150ms 内回到 from
fireMutation(anchor, "data-session-id");   // 同一次切换的重复信号：必须被吞掉
const swRoundBack = switchOf();
check("150ms 内 A→B→A 往返不新增 from===to 的伪切换",
  swRoundBack.items.length === roundLen - 1
    && !swRoundBack.items.some((r) => r.from === r.to && r.from !== ""),
  JSON.stringify(swRoundBack.items.map((r) => r.from + ">" + r.to)));

// A5 + 环上限：连续切换跨过 5 个会话桶上限与 10 条环上限，from/to 仍是短串。
for (let i = 0; i < 11; i++) {
  await wait(160);               // 越过 150ms 去重窗口
  anchor.setAttribute("data-session-id", "sess_c" + i + "_x");
  fireMutation(anchor, "data-session-id");
}
const swRing = switchOf();
check("切换环最多 10 条", swRing.items.length === 10, `n=${swRing.items.length}`);
check("淘汰会话桶后 from/to 仍是短串（不依赖桶存活）",
  swRing.items.every((r) => typeof r.from === "string" && r.from.length <= 8
    && typeof r.to === "string" && r.to.length <= 8),
  JSON.stringify(swRing.items.map((r) => r.from + ">" + r.to)));
// v0.4.3 三审：新切换到来时必须截断上一条的 30 秒窗口，否则第二次切换的
// 补页潮/长帧会被算到第一条头上；被截断的要标 settledEarly。
check("下一次切换会冻结并截断上一条（settledEarly=1）",
  swRing.items.slice(0, -1).every((r) => r.settled === 1 && r.settledEarly === 1),
  JSON.stringify(swRing.items.map((r) => [r.settled, r.settledEarly])));
check("最新一条仍在自己的 30 秒窗口内（settled=0）",
  swRing.items[swRing.items.length - 1].settled === 0
    && swRing.items[swRing.items.length - 1].settledEarly === 0,
  JSON.stringify(swRing.items[swRing.items.length - 1]));

// A3：30 秒冻结（用测试钩子前移时间戳，不真等 30 秒）。
window.__lagfixTest.ageSwitchRecords(31000);
const swFrozen = switchOf();
// 前 9 条在循环里已被下一次切换截断（early=1），最后一条在这里自然到期（early=0）。
check("过 30 秒后条目冻结并补齐 after 值",
  swFrozen.items.length === 10 && swFrozen.items.every((r) => r.settled === 1)
    && swFrozen.items.slice(0, -1).every((r) => r.settledEarly === 1)
    && swFrozen.items[swFrozen.items.length - 1].settledEarly === 0
    && swFrozen.items.every((r) => typeof r.domAfter === "number"
      && typeof r.turnsAfter === "number" && typeof r.blockedLoadAll === "number"),
  JSON.stringify(swFrozen.items.map((r) => [r.settled, r.settledEarly, r.domAfter, r.turnsAfter, r.blockedLoadAll])));

// A4：关闭开关 → switch=null、不记录；重开后环仍在、不补录空白期。
const swBeforeOff = switchRingLen();
writeSettings({ switchDiagOn: false });
check("switchDiagOn=false 时样本 switch 为 null", collect().switch === null);
await wait(160);
anchor.setAttribute("data-session-id", "sess_off_1");
fireMutation(anchor, "data-session-id");
check("关闭期间不记录新切换", switchRingLen() === swBeforeOff,
  `before=${swBeforeOff} after=${switchRingLen()}`);
writeSettings({ switchDiagOn: true });
await wait(160);
anchor.setAttribute("data-session-id", "sess_on_1");
fireMutation(anchor, "data-session-id");
const swRe = switchOf();
check("重开后继续记录，环里没有空白期的 sid",
  swRe.items.length === Math.min(swBeforeOff + 1, 10)
    && !swRe.items.some((r) => r.to === "sess_off"),
  JSON.stringify(swRe.items.map((r) => r.from + ">" + r.to)));

// v0.4.3 三审：采集间隔可调到 30/60/120 秒，自然结算可能晚于记录 30 秒很久。
// 容差必须按 collectSec 放大，否则 after 值会被静默判过期（settled=1 但全 null）。
writeSettings({ collectSec: 30 });
await wait(160);
anchor.setAttribute("data-session-id", "sess_late_1");
fireMutation(anchor, "data-session-id");
window.__lagfixTest.ageSwitchRecords(31000);   // 记录已过 30 秒，但本轮采集还没跑
const swLate = switchOf();                      // 采集周期内自然结算
const lateRec = swLate.items.find((r) => r.to === "sess_lat");
check("collectSec=30 时 31 秒后的自然结算仍补齐 after 值",
  !!lateRec && lateRec.settled === 1 && lateRec.settledEarly === 0
    && typeof lateRec.domAfter === "number",
  JSON.stringify(lateRec));
writeSettings({ collectSec: 5 });

// 还原锚点 sid：后面的多会话用例按 sess_test_123 建桶。必须先还原再重建桶，
// 否则重建时会把临时的 sess_on_* 也建成桶，多会话用例就多出一个。
await wait(160);
anchor.setAttribute("data-session-id", "sess_test_123");
fireMutation(anchor, "data-session-id");

// 本段的连续切换会把 5 个会话桶占满；关→开按当前锚点重建，清掉临时桶。
writeSettings({ sessionDiagOn: false });
writeSettings({ sessionDiagOn: true });

// 清掉本段投入的长帧明细：后面的 LoAF 用例按空环断言（关→开会清环）。
writeSettings({ lafDiagOn: false });
writeSettings({ lafDiagOn: true });

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

// 超过 60s 的待处理按键不是有效输入延迟（启动期/页面冻结），必须丢弃。
const realDateNow = Date.now;
let fakeNow = realDateNow();
Date.now = () => fakeNow;
keydownAll.forEach((fn) => fn({ target: keySurface, key: "ArrowDown" }));
fakeNow += 61000;
driveFrame(fakeNow);
Date.now = realDateNow;
driveFrame(realDateNow());   // 把 rafLast 从假时间轴拉回真实时间
const samplesAfterStale = inputOf().samples;
check("超过 60s 的待处理按键被丢弃",
  samplesAfterStale === samplesBeforeOutside,
  `before=${samplesBeforeOutside} after=${samplesAfterStale}`);

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
const rafBeforePause = rafCb;
writeSettings({ observe: false });
const pausedPayload = JSON.parse(window.__lagfixCollect());
check("paused payload 的 scroll 为 null", pausedPayload.scroll === null);
check("paused payload 的 input 为 null", pausedPayload.input === null);
check("paused payload 的 sessions 为 null", pausedPayload.sessions === null,
  `sessions=${JSON.stringify(pausedPayload.sessions)}`);
check("paused payload 的 loadOlderDetail 为 null", pausedPayload.loadOlderDetail === null,
  `detail=${JSON.stringify(pausedPayload.loadOlderDetail)}`);
check("paused payload 的 pane/refocus 为 null",
  pausedPayload.pane === null && pausedPayload.refocus === null,
  `pane=${JSON.stringify(pausedPayload.pane)} refocus=${JSON.stringify(pausedPayload.refocus)}`);
check("暂停时移除 visibility/focus/blur 监听",
  (documentStub._listeners.visibilitychange || []).length === 0
    && (window._listeners.focus || []).length === 0
    && (window._listeners.blur || []).length === 0);
writeSettings({ observe: true });
check("恢复观测后 visibility/focus/blur 监听回来",
  (documentStub._listeners.visibilitychange || []).length === 1
    && (window._listeners.focus || []).length === 1
    && (window._listeners.blur || []).length === 1);
const resumedScroll = JSON.parse(window.__lagfixCollect()).scroll;
check("恢复观测后 scroll 回到对象",
  resumedScroll && typeof resumedScroll === "object", JSON.stringify(resumedScroll));
check("恢复观测后 sessions 回到数组",
  Array.isArray(JSON.parse(window.__lagfixCollect()).sessions));
// 暂停前挂起的旧 rAF 回调在恢复后不能再记账（否则隐藏窗口会留下两条自续链）。
const framesBeforeOldChain = window.__lagfixDiag().frameSamples;
rafBeforePause(performance.now() + 16);
check("暂停/恢复后旧的 rAF 链不再记账",
  window.__lagfixDiag().frameSamples === framesBeforeOldChain,
  `before=${framesBeforeOldChain} after=${window.__lagfixDiag().frameSamples}`);
driveFrame(performance.now() + 16);   // 新链先建基线
driveFrame(performance.now() + 32);   // 再记一帧
check("恢复后新 rAF 链继续采样",
  window.__lagfixDiag().frameSamples === framesBeforeOldChain + 1,
  `frames=${window.__lagfixDiag().frameSamples}`);

console.log("-- v0.3.2 多会话归因：按 sid 分桶 --");
const sessionsOf = () => {
  const v = collect().sessions;
  return Array.isArray(v) ? v : [];
};
const detailOf = () => {
  const v = collect().loadOlderDetail;
  return Array.isArray(v) ? v : [];
};
const bySid = (list, sid) => list.find((b) => b && b.sid === sid) || {};

// 让第二个会话 pane 出现在 DOM；下一次 collect 会触发 pane 发现。
sessionPaneList.push(paneB);
let sess = sessionsOf();
check("sessionDiagOn 默认开，sessions 是数组", Array.isArray(collect().sessions),
  `type=${typeof collect().sessions}`);
check("发现两个会话桶", sess.length === 2, `n=${sess.length}`);
const a0 = bySid(sess, "sess_test_123");
const b0 = bySid(sess, "sess_b");
check("A 桶存在且可见", a0.sid === "sess_test_123" && a0.visible === true, JSON.stringify(a0));
check("B 桶存在且可见", b0.sid === "sess_b" && b0.visible === true, JSON.stringify(b0));
check("A/B 的 DOM 计数独立（含 pane 根）", a0.dom === 81 && b0.dom === 121,
  `A=${a0.dom} B=${b0.dom}`);
check("A/B 的挂载 turn 独立", a0.mountedTurns === 2 && b0.mountedTurns === 3,
  `A=${a0.mountedTurns} B=${b0.mountedTurns}`);

// 可见性翻转：隐藏 pane 仍保留桶，但 visible=false。
anchor._visible = false;
sess = sessionsOf();
check("隐藏 pane 标记 visible=false", bySid(sess, "sess_test_123").visible === false,
  JSON.stringify(bySid(sess, "sess_test_123")));
check("另一个 pane 仍 visible=true", bySid(sess, "sess_b").visible === true);
anchor._visible = true;

// 提交归因：一次 seq 变化只进对应 sid 的桶。
collect();   // 清掉启动以来的 frames（采样间隔通常已 >1s）
fireAttr(anchor, "data-projection-seq");
fireAttr(anchor, "data-projection-seq");
fireAttr(paneB, "data-projection-seq");
let sess1 = sessionsOf();
check("A 的提交只进 A 桶", bySid(sess1, "sess_test_123").frames === 2,
  `A=${bySid(sess1, "sess_test_123").frames}`);
check("B 的提交只进 B 桶", bySid(sess1, "sess_b").frames === 1,
  `B=${bySid(sess1, "sess_b").frames}`);
await wait(1100);
let sess2 = sessionsOf();
check("采样间隔 >=1s 时给出 commitRate",
  typeof bySid(sess2, "sess_test_123").commitRate === "number",
  `rate=${bySid(sess2, "sess_test_123").commitRate}`);
check("commitRate 数值合理（>0）", bySid(sess2, "sess_test_123").commitRate > 0,
  `rate=${bySid(sess2, "sess_test_123").commitRate}`);

// 隐藏 pane 的提交仍然计数（这正是“谁在后台拖”的证据）。
paneB._visible = false;
fireAttr(paneB, "data-projection-seq");
let sess3 = sessionsOf();
check("隐藏 pane 的提交仍进入该桶", bySid(sess3, "sess_b").frames >= 1,
  `B=${bySid(sess3, "sess_b").frames}`);
check("隐藏 pane 的 visible 仍为 false", bySid(sess3, "sess_b").visible === false);
paneB._visible = true;

// 按会话滚动 P95：只有发生滚动的 pane 有值。
const timelineB = makeEl("div");
timelineB.setAttribute("data-v4-timeline-scroll", "true");
timelineB.closest = (sel) => (String(sel).includes("data-session-id") ? paneB : null);
const scrollLive = () => (documentStub._listeners.scroll || []);
scrollLive().forEach((fn) => fn({ target: timelineB }));
await wait(10);
driveFrame(performance.now());
let sess4 = sessionsOf();
check("B 的时间线滚动进入 B 的 scrollP95",
  typeof bySid(sess4, "sess_b").scrollP95 === "number",
  `B=${bySid(sess4, "sess_b").scrollP95}`);
check("没有滚动的 A 不产生 scrollP95",
  bySid(sess4, "sess_test_123").scrollP95 === null,
  `A=${bySid(sess4, "sess_test_123").scrollP95}`);

// 只开多会话归因（滚动诊断关闭）时，会话滚动仍要记录。
writeSettings({ scrollDiagOn: false });
scrollLive().forEach((fn) => fn({ target: timelineB }));
await wait(10);
driveFrame(performance.now());
const sessOnly = sessionsOf();
check("只开多会话归因时仍记录会话滚动",
  typeof bySid(sessOnly, "sess_b").scrollP95 === "number",
  `B=${bySid(sessOnly, "sess_b").scrollP95}`);
writeSettings({ scrollDiagOn: true });

// 关闭开关：sessions=null，且不再遍历会话 pane。
const qBeforeOff = sessionQueryCount;
writeSettings({ sessionDiagOn: false });
let offSess = collect();
check("sessionDiagOn=false 时 sessions 为 null", offSess.sessions === null,
  `sessions=${JSON.stringify(offSess.sessions)}`);
check("关闭后不再遍历会话 pane", sessionQueryCount === qBeforeOff,
  `${qBeforeOff} -> ${sessionQueryCount}`);
check("关闭后桶与观察目标已释放", window.__lagfixDiag().sessionBuckets === 0
  && window.__lagfixDiag().sessionPanes === 0,
  JSON.stringify(window.__lagfixDiag()));

// 重新开启：桶重建，且一次提交只 +1（没有重复观察）。
writeSettings({ sessionDiagOn: true });
let onSess = sessionsOf();
check("重新开启后桶重建", onSess.length >= 2, `n=${onSess.length}`);
const framesABefore = bySid(onSess, "sess_test_123").frames || 0;
fireAttr(anchor, "data-projection-seq");
let onSess2 = sessionsOf();
check("重新开启后一次提交只 +1（没有重复观察）",
  (bySid(onSess2, "sess_test_123").frames || 0) === framesABefore + 1,
  `before=${framesABefore} after=${bySid(onSess2, "sess_test_123").frames}`);

// 同值 seq 重写不能计提交（与全局 frames 口径一致）。
const sameBefore = bySid(sessionsOf(), "sess_test_123").frames || 0;
fireMutation(anchor, "data-projection-seq");
const sameAfter = bySid(sessionsOf(), "sess_test_123").frames || 0;
check("同值 data-projection-seq 重写不计提交", sameAfter === sameBefore,
  `before=${sameBefore} after=${sameAfter}`);

// pane 卸载后桶保留但归零；重新挂回后恢复。
sessionsOf();   // 确保 B 桶已建立
sessionPaneList.splice(sessionPaneList.indexOf(paneB), 1);
const unloaded = bySid(sessionsOf(), "sess_b");
check("pane 卸载后桶保留但 visible=false、dom=0",
  unloaded.sid === "sess_b" && unloaded.visible === false && unloaded.dom === 0,
  JSON.stringify(unloaded));
sessionPaneList.push(paneB);
const remounted = bySid(sessionsOf(), "sess_b");
check("pane 重新挂回后 DOM/turn 立即补采",
  remounted.visible === true && remounted.dom > 0,
  JSON.stringify(remounted));

// 6 个常驻 pane：只保留 5 个桶，且不能在每轮 collect 时轮换。
const extraPanes = ["sess_c", "sess_d", "sess_e", "sess_f"].map((sid) => {
  const p = makeEl("div");
  p.setAttribute("data-session-id", sid);
  p._visible = true;
  p._rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  p._all = makeSubtree(4, 1);
  return p;
});
extraPanes.forEach((p) => sessionPaneList.push(p));
const sidSet = (list) => list.map((b) => b.sid).sort().join(",");
const cap1 = sessionsOf();
const capSids1 = sidSet(cap1);
const capSids2 = sidSet(sessionsOf());
check("6 个 pane 时最多 5 个桶", cap1.length === 5, `n=${cap1.length}`);
check("连续 collect 的桶集合稳定（不周期性轮换）",
  capSids1 === capSids2, `${capSids1} -> ${capSids2}`);
const cappedSids = capSids1.split(",");
const missingSid = extraPanes
  .map((p) => p.getAttribute("data-session-id"))
  .find((sid) => !cappedSids.includes(sid));
const missingPane = extraPanes
  .find((p) => p.getAttribute("data-session-id") === missingSid);
check("第六个空闲 pane 先不建桶", !!missingSid && !!missingPane, `missing=${missingSid}`);
fireAttr(missingPane, "data-projection-seq");
const cap3 = sessionsOf();
check("第六个 pane 有真实提交后接管名额",
  cap3.length === 5 && cap3.some((b) => b.sid === missingSid),
  `sids=${sidSet(cap3)}`);

// 同值 sid 重写既不是切换也不是活跃；满 5 桶时不能借此给额外 pane 抢名额。
const paneExtra = makeEl("div");
paneExtra.setAttribute("data-session-id", "sess_extra");
paneExtra._visible = true;
paneExtra._rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
paneExtra._all = makeSubtree(2, 1);
sessionPaneList.push(paneExtra);
sessionsOf();   // 满 5 桶，额外 pane 只观察不建桶
const extraBefore = sidSet(sessionsOf());
fireMutation(paneExtra, "data-session-id", "sess_extra");
check("同值 data-session-id 重写不建桶、不淘汰",
  sidSet(sessionsOf()) === extraBefore && !sidSet(sessionsOf()).includes("sess_extra"),
  `${extraBefore} -> ${sidSet(sessionsOf())}`);
// 切成 draft 也不是真实活动：满 5 桶时不能把真实会话挤掉。
paneExtra.setAttribute("data-session-id", "draft");
fireMutation(paneExtra, "data-session-id", "sess_extra");
check("满 5 桶时 SID→draft 不淘汰真实桶",
  sidSet(sessionsOf()) === extraBefore,
  `${extraBefore} -> ${sidSet(sessionsOf())}`);

// 未入桶的额外 pane 同值 seq 重写：不能建桶、计帧或淘汰真实桶。
const paneSeqExtra = makeEl("div");
paneSeqExtra.setAttribute("data-session-id", "sess_seq_extra");
paneSeqExtra.setAttribute("data-projection-seq", "5");
paneSeqExtra._visible = true;
paneSeqExtra._rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
paneSeqExtra._all = makeSubtree(2, 1);
sessionPaneList.push(paneSeqExtra);
sessionsOf();
const seqExtraBefore = sidSet(sessionsOf());
fireMutation(paneSeqExtra, "data-projection-seq", "5");
check("未入桶 pane 的同值 seq 不建桶、不淘汰",
  sidSet(sessionsOf()) === seqExtraBefore
    && !sidSet(sessionsOf()).includes("sess_seq_extra"),
  `${seqExtraBefore} -> ${sidSet(sessionsOf())}`);

// 已跟踪的真实会话切到另一个真实会话：即使满 5 桶也要换桶（当前主 pane 不能缺席）。
missingPane.setAttribute("data-session-id", "sess_switched");
fireMutation(missingPane, "data-session-id", missingSid);
const switchedSids = sidSet(sessionsOf());
check("满 5 桶时已跟踪 pane 切到真实会话仍建桶",
  switchedSids.split(",").includes("sess_switched") && switchedSids.split(",").length === 5,
  `sids=${switchedSids}`);

// 占位 draft → 真实 sid：旧占位桶必须删除，不能占名额。
sessionPaneList.length = 0;
sessionPaneList.push(anchor, paneB);
const paneDraft = makeEl("div");
paneDraft.setAttribute("data-session-id", "draft");
paneDraft._visible = true;
paneDraft._rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
paneDraft._all = makeSubtree(2, 1);
sessionPaneList.push(paneDraft);
writeSettings({ sessionDiagOn: false });
writeSettings({ sessionDiagOn: true });
sessionsOf();
check("draft pane 有独立占位桶",
  sessionsOf().some((b) => b.sid === "draft"), `sids=${sidSet(sessionsOf())}`);
paneDraft.setAttribute("data-session-id", "sess_real");
fireMutation(paneDraft, "data-session-id");
const draftAfter = sessionsOf();
check("draft→真实 sid 后占位桶被删除",
  !draftAfter.some((b) => b.sid === "draft"), `sids=${sidSet(draftAfter)}`);
check("真实 sid 接管同一 pane",
  draftAfter.some((b) => b.sid === "sess_real" && b.visible === true),
  `sids=${sidSet(draftAfter)}`);
sessionPaneList.splice(sessionPaneList.indexOf(paneDraft), 1);

console.log("-- v0.3.2 loadOlder 明细：耗时/行数/触发来源 --");
// 清空明细并重置触发判定：关/开滚动诊断。
writeSettings({ scrollDiagOn: false });
check("scrollDiagOn=false 时 loadOlderDetail 为 null",
  collect().loadOlderDetail === null,
  `detail=${JSON.stringify(collect().loadOlderDetail)}`);
writeSettings({ scrollDiagOn: true });
collect();
check("重新开启后明细是空数组",
  Array.isArray(collect().loadOlderDetail) && detailOf().length === 0,
  `n=${detailOf().length}`);

// 暂停期间不累计 loadOlder 明细/calls；lastActive 不被暂停时刻改写。
const pauseDetailBefore = window.__lagfixDiag().loadOlderDetail;
const pauseCallsBefore = window.__lagfixDiag().loadOlderCalls;
const pauseActiveBefore = bySid(sessionsOf(), "sess_b").lastActive;
writeSettings({ observe: false });
await store.loadOlder();
await store.loadOlder();
check("暂停期间 loadOlder 不累计明细",
  window.__lagfixDiag().loadOlderDetail === pauseDetailBefore,
  `before=${pauseDetailBefore} after=${window.__lagfixDiag().loadOlderDetail}`);
check("暂停期间 loadOlder 不累计 calls",
  window.__lagfixDiag().loadOlderCalls === pauseCallsBefore,
  `before=${pauseCallsBefore} after=${window.__lagfixDiag().loadOlderCalls}`);
writeSettings({ observe: true });
check("暂停不改写 lastActive（暂停不是活跃）",
  bySid(sessionsOf(), "sess_b").lastActive === pauseActiveBefore,
  `before=${pauseActiveBefore} after=${bySid(sessionsOf(), "sess_b").lastActive}`);

// 行数变化 + initial：无滚动、包装后第一次调用。
store.state.snapshot.rows.window = new Array(60).fill(0);
store.loadOlderGrow = 60;
await store.loadOlder();
store.loadOlderGrow = 0;
let d1 = detailOf();
const e1 = d1[d1.length - 1] || {};
check("成功调用写入明细", e1.ok === true, JSON.stringify(e1));
check("明细记录 rowsBefore/rowsAfter", e1.rowsBefore === 60 && e1.rowsAfter === 120,
  `before=${e1.rowsBefore} after=${e1.rowsAfter}`);
check("无滚动、首次调用判为 initial", e1.trigger === "initial", `trigger=${e1.trigger}`);
check("明细不记录正文/消息 id/sid",
  !("text" in e1) && !("messages" in e1) && !("sid" in e1), JSON.stringify(e1));
check("明细未变化时样本只带空数组（避免日志膨胀）",
  Array.isArray(collect().loadOlderDetail) && collect().loadOlderDetail.length === 0,
  `detail=${JSON.stringify(collect().loadOlderDetail)}`);

// scroll 触发：滚动后 2s 内调用。
const timelineA = makeEl("div");
timelineA.setAttribute("data-v4-timeline-scroll", "true");
timelineA.closest = (sel) => (String(sel).includes("data-session-id") ? anchor : null);
scrollLive().forEach((fn) => fn({ target: timelineA }));
await wait(5);
await store.loadOlder();
let e2 = detailOf().slice(-1)[0] || {};
check("滚动后 2s 内调用判为 scroll", e2.trigger === "scroll", `trigger=${e2.trigger}`);

// unknown：无近期滚动、非首次、距挂载 >5s。
// 用 performance.now 偏移模拟 5.1s，不拖慢测试；调用后立即还原。
const realPerfNow = performance.now;
performance.now = () => realPerfNow() + 5100;
try {
  await store.loadOlder();
} finally {
  performance.now = realPerfNow;
}
let e3 = detailOf().slice(-1)[0] || {};
check("无近期滚动、非首次、距挂载 >5s 判为 unknown",
  e3.trigger === "unknown", `trigger=${e3.trigger}`);

// reject / 同步抛错也要留下 ok=false 明细，且原异常对象/原因不能被替换。
store.loadOlderFail = true;
let failErr = null;
try { await store.loadOlder(); } catch (e) { failErr = e; }
store.loadOlderFail = false;
let eFail = detailOf().slice(-1)[0] || {};
check("reject 写入 ok=false 明细", eFail.ok === false, JSON.stringify(eFail));
check("reject 原因原样保留", !!failErr && failErr.message === "async-boom",
  String(failErr && failErr.message));
store.loadOlderThrow = true;
let throwErr = null;
try { store.loadOlder(); } catch (e) { throwErr = e; }
store.loadOlderThrow = false;
let eThrow = detailOf().slice(-1)[0] || {};
check("同步抛错写入 ok=false 明细", eThrow.ok === false, JSON.stringify(eThrow));
check("同步抛错对象原样保留", !!throwErr && throwErr.message === "sync-boom",
  String(throwErr && throwErr.message));

// 环形窗口上限 10，且淘汰的是最旧记录。
writeSettings({ scrollDiagOn: false });
writeSettings({ scrollDiagOn: true });
collect();
const capBase = Date.now() + 60000;
const capRealDateNow = Date.now;
let capTick = capBase;
Date.now = () => capTick;
try {
  for (let i = 0; i < 12; i++) {
    capTick += 1000;
    await store.loadOlder();
  }
} finally {
  Date.now = capRealDateNow;
}
let dcap = detailOf();
check("明细最多保留最近 10 次", dcap.length === 10, `n=${dcap.length}`);
check("明细上限淘汰最旧两条", dcap[0].t === capBase + 3000 && dcap[9].t === capBase + 12000,
  `first=${dcap[0].t} last=${dcap[9].t} base=${capBase}`);
store.state.snapshot.rows.window = [{ rowId: 1 }];   // 还原，避免影响后续断言

console.log("-- 角标可见性：设置页 / 被遮挡 / 多个输入框 --");const badgeClick = (badge._listeners.click || [])[0];
check("角标绑定了 click", typeof badgeClick === "function");

let hostPopovers = [];
function setSurfaces(list) {
  documentStub.querySelectorAll = (sel) => {
    if (String(sel).includes("data-projection-seq")) return [anchor];
    if (String(sel).includes("data-session-id")) { sessionQueryCount++; return sessionPaneList; }
    if (String(sel).includes("chat-composer-input-surface")) return list;
    if (String(sel).includes("hover-card-content")) return hostPopovers;
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

console.log("-- 宿主浮层（上下文容量等）：角标不压面板 --");
// 上下文容量是 Radix HoverCard 的 body 级 portal，不在 composer 兄弟链里；
// 之前的 dock 扫描看不到它，角标会直接盖在面板上。
const hostPopover = makeEl("div");
hostPopover._rect = { left: 550, top: 300, right: 920, bottom: 490, width: 370, height: 190 };
hostPopovers = [hostPopover];
setSurfaces([mainSurface]);
documentStub.elementFromPoint = () => mainSurface;
await wait(1100);
check("宿主浮层压到角标带时让到浮层上沿（top=268）",
  badge.style.display === "" && badge.style.top === "268px",
  `display=${badge.style.display} top=${badge.style.top}`);
hostPopover._rect = { left: 550, top: 20, right: 920, bottom: 490, width: 370, height: 190 };
await wait(1100);
check("宿主浮层顶到视口顶端时角标隐藏", badge.style.display === "none",
  `display=${badge.style.display} top=${badge.style.top}`);
hostPopovers = [];
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
check("统计含标题与每帧耗时说明",
  statsHtml.includes("lagfix 性能") && statsHtml.includes("每帧耗时：95% 的帧不超过这个数"));
check("统计含四项大白话解释", statsHtml.includes("刷新") && statsHtml.includes("卡顿")
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
let panel = documentStub.getElementById("lagfix-settings-panel");
const mask = documentStub.getElementById("lagfix-modal-mask");
check("点齿轮才创建设置弹窗", !!panel && !!mask);
check("弹窗铺在遮罩上（居中 modal）", !!mask && mask.style.display === "flex");

function allText(root) {
  const out = [String(root.textContent || "")];
  for (const c of root.children || []) out.push(allText(c));
  return out.join(" | ");
}
function findCheckbox(root) {
  if (root.tagName === "INPUT" && root.type === "checkbox"
    && (root._listeners.change || []).length) return root;
  for (const c of root.children || []) {
    const hit = findCheckbox(c);
    if (hit) return hit;
  }
  return null;
}
function findLab(root, text) {
  if (root.className === "lab" && String(root.textContent || "") === text) return root;
  for (const c of root.children || []) {
    const hit = findLab(c, text);
    if (hit) return hit;
  }
  return null;
}
function findRowCheckbox(root, label) {
  const lab = findLab(root, label);
  return lab && lab.parentNode && lab.parentNode.parentNode
    ? findCheckbox(lab.parentNode.parentNode) : null;
}
const panelText = panel ? allText(panel) : "";
check("弹窗有左侧分类：状态条/观测/性能/维护",
  ["状态条", "观测", "性能", "维护"].every((t) => panelText.includes(t)));
check("分类不再叫「修复」", !panelText.includes("修复"));
check("面板含「合并刷新」", panelText.includes("合并刷新"));
check("面板含「重启 ZCode」", panelText.includes("重启 ZCode"));
check("面板含「检查更新」", panelText.includes("检查更新"));
check("底部说明「设置修改后自动保存」", panelText.includes("设置修改后自动保存"));
check("维护页有正式版本行",
  panelText.includes("版本") && panelText.includes("只在本机记录和缓解卡顿"));
check("面板不再出现控制台 __lagfixOff 提示", !panelText.includes("__lagfixOff"));
check("状态条页改用「显示文字 / 信息量 / 警告阈值 / 严重阈值」",
  ["显示文字", "信息量", "警告阈值", "严重阈值"].every((t) => panelText.includes(t)));
check("旧的颜色式阈值命名已消失",
  !panelText.includes("变黄阈值") && !panelText.includes("变红阈值"));
check("性能页按 刷新 / 历史 / 滚动 三组展示",
  ["合并刷新", "最短刷新间隔", "卡顿时自动放慢", "切换会话时放慢", "后台时减少刷新",
    "大历史会话保护", "滚动时去掉渐隐"].every((t) => panelText.includes(t)));
check("旧行名已消失",
  ["订阅通知节流", "节流窗口", "自适应窗口", "切会话冷静期", "后台降频", "大会话保护"]
    .every((t) => !panelText.includes(t)));
check("观测页含「滚动诊断」「输入延迟」「多会话分别统计」",
  panelText.includes("滚动诊断") && panelText.includes("输入延迟")
  && panelText.includes("多会话分别统计"));
check("A8：面板不再提供「显示角标」开关", !panelText.includes("显示角标"));
check("性能页含「侧栏与回前台」四项",
  ["侧栏与回前台统计", "侧栏开合保护", "面板常开保护", "回前台保护"]
    .every((t) => panelText.includes(t)));
check("面板版本行是 v0.4.3", panelText.includes("v0.4.3"));
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

console.log("-- v0.3.8 自动检查更新与小红点 --");
const UPDATE_KEY = "lagfix.update.v1";
localStorage.removeItem(UPDATE_KEY);
check("自动检查默认关闭", collect().settings.autoUpdateCheckOn === false);
const idleUpdate = collect();
check("默认关闭时不主动请求更新",
  idleUpdate.updateCheck === 0 && idleUpdate.updateAuto === 0,
  `updateCheck=${idleUpdate.updateCheck} updateAuto=${idleUpdate.updateAuto}`);
let badgeDot = documentStub.getElementById("lagfix-overlay-badge-update-dot");
let panelDot = documentStub.getElementById("lagfix-settings-panel-updatedot");
const badgeGear = documentStub.getElementById("lagfix-gear");
check("角标有更新小红点且默认隐藏", !!badgeDot && badgeDot.style.display === "none");
check("维护页「检查更新」行有小红点且默认隐藏", !!panelDot && panelDot.style.display === "none");
// v0.4.1：红点改成齿轮右上角角标，不再是文字与齿轮之间的行内点。
check("角标红点挂在齿轮按钮内（右上角角标）",
  !!badgeGear && badgeDot.parentNode === badgeGear && badgeGear.contains(badgeDot),
  `parent=${badgeDot && badgeDot.parentNode && badgeDot.parentNode.id}`);
check("红点对读屏隐藏且不自带重复提示",
  badgeDot.getAttribute("aria-hidden") === "true" && !badgeDot.title,
  `aria=${badgeDot.getAttribute("aria-hidden")} title=${badgeDot.title}`);
const badgeStyleText = String((documentStub.getElementById("lagfix-style") || {}).textContent || "");
check("红点样式为齿轮右上角绝对定位且不挡点击",
  /#lagfix-overlay-badge \.lg-update-dot\{[^}]*position:absolute/.test(badgeStyleText)
    && /#lagfix-overlay-badge \.lg-update-dot\{[^}]*top:-2px/.test(badgeStyleText)
    && /#lagfix-overlay-badge \.lg-update-dot\{[^}]*right:-2px/.test(badgeStyleText)
    && /#lagfix-overlay-badge \.lg-update-dot\{[^}]*pointer-events:none/.test(badgeStyleText)
    && /#lagfix-overlay-badge \.lg-gear\{[^}]*position:relative/.test(badgeStyleText),
  badgeStyleText.match(/#lagfix-overlay-badge \.lg-update-dot\{[^}]*\}/));
check("维护页含「自动检查更新」并说明 24 小时一次",
  allText(panel).includes("自动检查更新") && allText(panel).includes("24 小时"));

writeSettings({ autoUpdateCheckOn: true });
panel = documentStub.getElementById("lagfix-settings-panel");
panelDot = documentStub.getElementById("lagfix-settings-panel-updatedot");
localStorage.setItem(UPDATE_KEY, JSON.stringify({ checkedAt: Date.now() }));
const autoRecent = collect();
check("开启后设置快照同步 autoUpdateCheckOn=true", autoRecent.settings.autoUpdateCheckOn === true);
check("24 小时内到期判断为假", autoRecent.updateCheck === 0,
  `updateCheck=${autoRecent.updateCheck}`);
localStorage.setItem(UPDATE_KEY, JSON.stringify({ checkedAt: Date.now() - 25 * 60 * 60 * 1000 }));
const autoFirst = collect();
check("超过 24 小时后自动检查随样本请求一次",
  autoFirst.updateCheck === 1 && autoFirst.updateAuto === 1,
  `updateCheck=${autoFirst.updateCheck} updateAuto=${autoFirst.updateAuto}`);
const autoSecond = collect();
check("自动检查发出后本周期不重复", autoSecond.updateCheck === 0 && autoSecond.updateAuto === 0,
  `updateCheck=${autoSecond.updateCheck} updateAuto=${autoSecond.updateAuto}`);
const autoKey = JSON.parse(localStorage.getItem(UPDATE_KEY) || "{}");
check("自动检查把 checkedAt 写入独立 key",
  typeof autoKey.checkedAt === "number" && typeof autoKey.resultAt === "undefined",
  JSON.stringify(autoKey));

// 模拟主进程注入结果：写入缓存、跨窗口可读，并画出红点。
window.__lagfixUpdate = { status: "ok", current: "0.4.3", latest: "9.9.9", newer: true,
  url: "https://example.invalid/releases", at: Date.now() };
window.__lagfixSettings();   // 重建面板 → renderPanelStatus 同步缓存
panel = documentStub.getElementById("lagfix-settings-panel");
panelDot = documentStub.getElementById("lagfix-settings-panel-updatedot");
badgeDot = documentStub.getElementById("lagfix-overlay-badge-update-dot");
check("有新版本时角标红点显示", !!badgeDot && badgeDot.style.display === "inline-block",
  `display=${badgeDot && badgeDot.style.display}`);
check("有新版本时齿轮提示包含「有新版本」",
  badgeGear.title === "打开设置（有新版本）", badgeGear.title);
check("有新版本时维护页红点显示", !!panelDot && panelDot.style.display === "inline-block",
  `display=${panelDot && panelDot.style.display}`);
check("维护页显示发现新版本", allText(panel).includes("发现新版本 v9.9.9"));
check("更新缓存写入独立 key 且含 latest/newer",
  (() => {
    const st = JSON.parse(localStorage.getItem(UPDATE_KEY) || "{}");
    return st.current === "0.4.3" && st.latest === "9.9.9" && st.newer === true
      && typeof st.resultAt === "number";
  })(), localStorage.getItem(UPDATE_KEY));

// 另一个窗口写入缓存：storage 事件应即时更新红点，不需要重建面板。
const onUpdateStorage = (window._listeners.storage || [])[0];
localStorage.setItem(UPDATE_KEY, JSON.stringify({
  current: "0.4.3", latest: "10.0.0", newer: true, resultAt: Date.now(),
}));
if (onUpdateStorage) onUpdateStorage({ key: UPDATE_KEY });
check("跨窗口缓存显示红点", badgeDot.style.display === "inline-block" && panelDot.style.display === "inline-block");
localStorage.setItem(UPDATE_KEY, JSON.stringify({
  current: "0.4.3", latest: "10.0.0", newer: false, resultAt: Date.now(),
}));
if (onUpdateStorage) onUpdateStorage({ key: UPDATE_KEY });
check("明确无新版本时红点隐藏", badgeDot.style.display === "none" && panelDot.style.display === "none");
check("无新版本时齿轮提示恢复为打开设置", badgeGear.title === "打开设置", badgeGear.title);

// 版本不匹配 / 同版本 / newer=false 三种脏数据都不能亮红点。
const dotCases = [
  ["缓存版本与当前版本不一致", { current: "0.3.6", latest: "9.9.9", newer: true }],
  ["latest 与当前版本相同", { current: "0.4.3", latest: "0.4.3", newer: true }],
  ["newer 为 false", { current: "0.4.3", latest: "9.9.9", newer: false }],
];
for (const [name, st] of dotCases) {
  localStorage.setItem(UPDATE_KEY, JSON.stringify({ ...st, resultAt: Date.now() }));
  if (onUpdateStorage) onUpdateStorage({ key: UPDATE_KEY });
  check(name + "时红点隐藏",
    badgeDot.style.display === "none" && panelDot.style.display === "none",
    `badge=${badgeDot.style.display} panel=${panelDot.style.display}`);
}

// 关闭自动检查：即使 checkedAt 过期也不再自动请求。
writeSettings({ autoUpdateCheckOn: false });
panel = documentStub.getElementById("lagfix-settings-panel");
badgeDot = documentStub.getElementById("lagfix-overlay-badge-update-dot");
panelDot = documentStub.getElementById("lagfix-settings-panel-updatedot");
const manualOnlyKey = JSON.parse(localStorage.getItem(UPDATE_KEY) || "{}");
manualOnlyKey.checkedAt = 0;
localStorage.setItem(UPDATE_KEY, JSON.stringify(manualOnlyKey));
check("关闭自动检查后不再自动请求", collect().updateCheck === 0);
// 留一份“有新版本”的缓存给 __lagfixOff 清理用例。
localStorage.setItem(UPDATE_KEY, JSON.stringify({
  current: "0.4.3", latest: "9.9.9", newer: true, resultAt: Date.now(),
}));
if (onUpdateStorage) onUpdateStorage({ key: UPDATE_KEY });
check("恢复新版本缓存后红点重新显示",
  badgeDot.style.display === "inline-block" && panelDot.style.display === "inline-block");

console.log("-- v0.3.9 面板重建保留滚动位置 --");
let contentEl = documentStub.getElementById("lagfix-settings-panel-content");
check("设置面板内容区有固定 id（滚动容器）", !!contentEl);
contentEl.scrollTop = 240;
const panelBeforeToggle = panel;
const scrollCb = findRowCheckbox(panel, "自动检查更新");
check("面板内找到会触发重建的开关", !!scrollCb);
scrollCb.checked = !scrollCb.checked;
(scrollCb._listeners.change || [])[0]();
panel = documentStub.getElementById("lagfix-settings-panel");
const contentAfterToggle = documentStub.getElementById("lagfix-settings-panel-content");
check("开关重建后面板是新 DOM", !!panel && panel !== panelBeforeToggle);
check("开关重建后滚动位置保持",
  !!contentAfterToggle && contentAfterToggle.scrollTop === 240,
  `scrollTop=${contentAfterToggle && contentAfterToggle.scrollTop}`);
// 把刚才切换的开关拨回原值，避免影响后续用例；第二次重建仍应保持滚动位置。
const scrollCbBack = findRowCheckbox(panel, "自动检查更新");
scrollCbBack.checked = !scrollCbBack.checked;
(scrollCbBack._listeners.change || [])[0]();
panel = documentStub.getElementById("lagfix-settings-panel");
contentEl = documentStub.getElementById("lagfix-settings-panel-content");
check("第二次重建仍保持滚动位置",
  !!contentEl && contentEl.scrollTop === 240,
  `scrollTop=${contentEl && contentEl.scrollTop}`);

console.log("-- v0.3.9 打开/关闭面板的焦点接管与回报 --");
// 用真实关窗路径（点遮罩）先关掉，再把焦点交给齿轮后重开。
let maskNow = documentStub.getElementById("lagfix-modal-mask");
(maskNow._listeners.mousedown || [])[0]({ target: maskNow });
documentStub.activeElement = gear;
window.__lagfixSettings();
panel = documentStub.getElementById("lagfix-settings-panel");
check("打开面板后焦点进面板容器", documentStub.activeElement === panel,
  `active=${documentStub.activeElement && documentStub.activeElement.tagName}`);

// Tab 循环：临时给面板两个可聚焦控件（假 DOM 不解析选择器）。
const panelQsaOrig = panel.querySelectorAll;
const tabA = makeEl("button");
const tabB = makeEl("button");
panel.appendChild(tabA);
panel.appendChild(tabB);
panel.querySelectorAll = () => [tabA, tabB];
const pressTab = (shift) => {
  const ev = {
    key: "Tab",
    shiftKey: !!shift,
    target: documentStub.activeElement,
    defaultPrevented: false,
    preventDefault() { ev.defaultPrevented = true; },
  };
  (documentStub._listeners.keydown || []).forEach((fn) => fn(ev));
  return ev;
};
documentStub.activeElement = tabB;
let tabEv = pressTab(false);
check("Tab 在最后一个控件时回到第一个",
  tabEv.defaultPrevented === true && documentStub.activeElement === tabA);
documentStub.activeElement = tabA;
tabEv = pressTab(true);
check("Shift+Tab 在第一个控件时回到最后一个",
  tabEv.defaultPrevented === true && documentStub.activeElement === tabB);
documentStub.activeElement = body;
tabEv = pressTab(false);
check("焦点不在面板时 Tab 拉回面板第一个控件",
  tabEv.defaultPrevented === true && documentStub.activeElement === tabA);
panel.querySelectorAll = panelQsaOrig;

maskNow = documentStub.getElementById("lagfix-modal-mask");
(maskNow._listeners.mousedown || [])[0]({ target: maskNow });
check("关闭面板后焦点回到打开前元素", documentStub.activeElement === gear,
  `active=${documentStub.activeElement && documentStub.activeElement.tagName}`);
window.__lagfixSettings();   // 给后面的 Esc 用例保留打开现场
panel = documentStub.getElementById("lagfix-settings-panel");


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
const fbBtn = panel ? findButton(panel, "反馈问题") : null;
check("维护页有「反馈问题」入口", !!fbBtn);
if (fbBtn) {
  let openedIssue = "";
  const prevZc = window.zcode;
  window.zcode = { openExternal(u) { openedIssue = u; } };
  (fbBtn._listeners.click || [])[0]({});
  if (prevZc === undefined) delete window.zcode; else window.zcode = prevZc;
  check("反馈入口打开 GitHub issue 模板",
    openedIssue === "https://github.com/ck-ys/zcode-lagfix/issues/new?template=bug_report.yml",
    openedIssue);
}
if (upBtn) {
  // 点击只置内存标记，随下一个样本回传一次；按钮 15s 后恢复。
  // 这里把 >=5s 的定时器吞掉，避免测试进程被 15s 定时器拖住退出。
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => (ms >= 5000 ? 0 : realSetTimeout(fn, ms));
  (upBtn._listeners.click || [])[0]({});
  globalThis.setTimeout = realSetTimeout;
  check("点击后按钮进入检查中并禁用", upBtn.disabled === true
    && String(upBtn.textContent).includes("检查中"), `text=${upBtn.textContent}`);
  const manualPayload = JSON.parse(window.__lagfixCollect());
  check("本次 payload 的 updateCheck=1", manualPayload.updateCheck === 1);
  check("手动检查 payload 的 updateAuto=0", manualPayload.updateAuto === 0,
    `updateAuto=${manualPayload.updateAuto}`);
  check("下一次 payload 的 updateCheck 归零（只请求一次）",
    JSON.parse(window.__lagfixCollect()).updateCheck === 0);
  // 标记清零后、主进程结果注入前，面板不能回落到「尚未检查」。
  window.__lagfixSettings();
  const upStatus = documentStub.getElementById("lagfix-settings-panel-updatestatus");
  check("请求发出后仍显示「正在检查」",
    !!upStatus && String(upStatus.textContent).includes("正在检查"),
    `text=${upStatus && upStatus.textContent}`);
}

console.log("-- v0.3.9 更新状态：当前版本高于最新发布 --");
window.__lagfixUpdate = { status: "ok", current: "0.4.3", latest: "0.3.4", newer: false,
  url: "https://example.invalid/releases", at: Date.now() + 5 };
window.__lagfixSettings();
panel = documentStub.getElementById("lagfix-settings-panel");
badgeDot = documentStub.getElementById("lagfix-overlay-badge-update-dot");
panelDot = documentStub.getElementById("lagfix-settings-panel-updatedot");
const gtStatus = documentStub.getElementById("lagfix-settings-panel-updatestatus");
check("当前版本高于最新 Release 时说明发布通道尚未更新",
  !!gtStatus && String(gtStatus.textContent).includes("高于最新发布")
  && String(gtStatus.textContent).includes("0.3.4"),
  `text=${gtStatus && gtStatus.textContent}`);
check("当前版本高于最新 Release 时不显示红点",
  badgeDot.style.display === "none" && panelDot.style.display === "none",
  `badge=${badgeDot.style.display} panel=${panelDot.style.display}`);

const infoBtn = panel ? findButton(panel, "!") : null;
check("修复项标题后有圆圈感叹号按钮", !!infoBtn);
if (infoBtn) {
  const rowMain = infoBtn.parentNode.parentNode;
  const note = (rowMain.children || []).find((c) => c.className === "note");
  check("影响说明默认收起", !!note && note.style.display === "none");
  (infoBtn._listeners.click || [])[0]({ stopPropagation() {} });
  check("点「!」展开影响说明", !!note && note.style.display === "block");
  check("说明同时写了会做什么与不会做什么",
    !!note && note.textContent.includes("会做什么：") && note.textContent.includes("不会做什么："));
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
check("Esc 后弹窗隐藏",
  documentStub.getElementById("lagfix-modal-mask").style.display === "none");

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
const detailBeforeSwitch = window.__lagfixDiag().loadOlderDetail;
check("换 store 前明细环非空（前置条件）", detailBeforeSwitch > 0,
  `n=${detailBeforeSwitch}`);
anchor["__reactFiber$test"].memoizedState.memoizedState.binding.lease.store = s3.store;
await wait(5200);   // 等看门狗（5s）重新核对目标
check("新原型的 store 被自动包装", !!s3.proto.__lagfixThrottle);
check("旧原型已还原（不再残留包装）", !proto.__lagfixThrottle);
check("大会话保护跟着换到新原型", !!s3.proto.__lagfixLoadAll);
check("旧原型的补拉保护已还原", proto.loadAllOlder === origLoadAllRef);
check("loadOlder 观测跟着换到当前 store 实例", !!s3.store.__lagfixLoadOlder);
check("loadOlder 不再写共享原型", s3.proto.__lagfixLoadOlder === undefined
  && s3.proto.loadOlder === s3OrigLoadOlder);
check("旧 store 实例的 loadOlder 观测已还原",
  store.loadOlder === origLoadOlderRef
    && !Object.prototype.hasOwnProperty.call(store, "loadOlder"));
check("换 store 后旧会话补页明细不混入新会话",
  window.__lagfixDiag().loadOlderDetail === 0,
  `n=${window.__lagfixDiag().loadOlderDetail}`);

console.log("-- v0.3.9 restoreTarget 只还原自己装的那一层 --");
const s3Rec = s3.proto.__lagfixThrottle;
check("前置：s3 原型上的包装记录完整",
  !!s3Rec && typeof s3Rec.orig === "function" && typeof s3Rec.wrapped === "function");
const hostOwnSubscribe = function hostOwnSubscribe() { return function () {}; };
s3.proto.subscribe = hostOwnSubscribe;
writeSettings({ throttleOn: false });
check("宿主替换 subscribe 后关闭合并刷新不覆盖宿主实现",
  s3.proto.subscribe === hostOwnSubscribe && !s3.proto.__lagfixThrottle,
  `same=${s3.proto.subscribe === hostOwnSubscribe} marker=${!!s3.proto.__lagfixThrottle}`);
s3.proto.subscribe = s3Rec.orig;
writeSettings({ throttleOn: true });
const s3Rec2 = s3.proto.__lagfixThrottle;
check("重新开启后包装的是恢复后的原实现",
  !!s3Rec2 && s3Rec2.orig === s3Rec.orig && s3.proto.subscribe === s3Rec2.wrapped);
writeSettings({ throttleOn: false });
check("仍是我们包装时正常还原为原实现",
  s3.proto.subscribe === s3Rec.orig && !s3.proto.__lagfixThrottle,
  `same=${s3.proto.subscribe === s3Rec.orig} marker=${!!s3.proto.__lagfixThrottle}`);
writeSettings({ throttleOn: true });
check("恢复开启供后续用例", !!s3.proto.__lagfixThrottle);

console.log("-- v0.3.9 订阅回调异常只留痕一次 --");
const listenerErrs = [];
const realConsoleError = console.error;
let throwHits = 0;
let unThrow = null;
console.error = (...args) => { listenerErrs.push(args.map((x) => String(x)).join(" ")); };
try {
  unThrow = s3.store.subscribe(() => { throwHits++; throw new Error("listener-boom"); });
  s3.store.emit();
  s3.store.emit();
  await wait(220);
} finally {
  console.error = realConsoleError;
  if (unThrow) unThrow();
}
check("抛错的 listener 两次都被调用（不影响后续通知）", throwHits === 2, `hits=${throwHits}`);
const listenerErrLines = listenerErrs.filter((s) => s.includes("订阅回调异常"));
check("订阅回调异常只打印一次", listenerErrLines.length === 1,
  `lines=${listenerErrLines.length}`);

console.log("-- v0.3.3 侧栏：默认值、检测与 420ms 保护 --");
// 宿主形状：frame 始终挂载，aria-hidden 表示开合；外层是 react-resizable-panels
// 的 [data-panel]，显式开合时 class 会短暂加 transition-[flex-grow]。
const paneFrame = makeEl("div");
paneFrame.setAttribute("data-workspace-side-frame", "true");
paneFrame.setAttribute("aria-hidden", "true");
paneFrame._rect = { left: 900, top: 0, right: 1440, bottom: 900, width: 540, height: 900 };
const panePanel = makeEl("div");
panePanel.setAttribute("data-panel", "");
panePanel.setAttribute("class", "");
paneFrame.closest = (sel) => (String(sel).includes("data-panel") ? panePanel : null);
let sidePaneFrame = paneFrame;

// 只在本段包一层查询：不重写前面已有的 querySelector 链，避免影响角标/会话用例。
const prevQS = documentStub.querySelector;
const prevQSA = documentStub.querySelectorAll;
documentStub.querySelector = (sel) => {
  if (String(sel).includes("data-workspace-side-frame")) return sidePaneFrame;
  return prevQS ? prevQS(sel) : null;
};
documentStub.querySelectorAll = (sel) => {
  if (String(sel).includes("data-workspace-side-frame")) return sidePaneFrame ? [sidePaneFrame] : [];
  return prevQSA ? prevQSA(sel) : [];
};
const paneOf = () => collect().pane || {};
const refocusOf = () => collect().refocus || {};

const paneDefaults = collect();
check("v0.3.3 四个开关默认开",
  paneDefaults.settings.paneDiagOn === true
    && paneDefaults.settings.paneSwitchGuardOn === true
    && paneDefaults.settings.paneHoldOn === true
    && paneDefaults.settings.refocusGuardOn === true,
  JSON.stringify({
    paneDiagOn: paneDefaults.settings.paneDiagOn,
    paneSwitchGuardOn: paneDefaults.settings.paneSwitchGuardOn,
    paneHoldOn: paneDefaults.settings.paneHoldOn,
    refocusGuardOn: paneDefaults.settings.refocusGuardOn,
  }));
check("检测到侧栏并读到收起状态",
  paneOf() && paneOf().detected === true && paneOf().open === false,
  JSON.stringify(paneOf()));
check("panelPx 取 frame 宽度", paneOf() && paneOf().panelPx === 540, `panelPx=${paneOf() && paneOf().panelPx}`);
check("未开合时 switchP95/switchMax 为 null",
  paneOf() && paneOf().switchP95 === null && paneOf().switchMax === null);
check("未回前台时 refocus 为稳定空结构",
  refocusOf() && refocusOf().hiddenMs === null && refocusOf().sinceVisibleMs === null
    && refocusOf().p95 === null && refocusOf().flushes === 0 && refocusOf().guardHits === 0,
  JSON.stringify(refocusOf()));

const paneStyleText = String((documentStub.getElementById("lagfix-style") || {}).textContent || "");
check("样式包含开合期停 [data-panel] 过渡的规则",
  paneStyleText.includes('[data-lagfix-pane-switch="1"] [data-panel]:has([data-workspace-side-frame="true"])'));
check("样式包含常开期关 mask 的规则",
  paneStyleText.includes('[data-lagfix-pane-open="1"] [data-v4-timeline-message-layer="true"]'));

// 打开：aria-hidden true → false，应同时触发开关计数、420ms 保护和常开期属性。
const badgeLeftBeforeSwitch = badge.style.left;
mainSurface._rect = { left: 400, top: 500, right: 1000, bottom: 620, width: 600, height: 120 };
paneFrame.setAttribute("aria-hidden", "false");
fireMutation(paneFrame, "aria-hidden", "true");
const paneOpenSnap = paneOf();
check("打开侧栏后 pane.open=true", paneOpenSnap && paneOpenSnap.open === true,
  JSON.stringify(paneOpenSnap));
check("打开侧栏记一次 switch", paneOpenSnap && paneOpenSnap.switches === 1,
  `switches=${paneOpenSnap && paneOpenSnap.switches}`);
check("打开侧栏加 data-lagfix-pane-switch",
  docEl.getAttribute("data-lagfix-pane-switch") === "1",
  `attr=${docEl.getAttribute("data-lagfix-pane-switch")}`);
check("打开侧栏加 data-lagfix-pane-open",
  docEl.getAttribute("data-lagfix-pane-open") === "1",
  `attr=${docEl.getAttribute("data-lagfix-pane-open")}`);
check("P1 guardHits 随真实开合递增", paneOf() && paneOf().guardHits === 1,
  `guardHits=${paneOf() && paneOf().guardHits}`);

// 保护窗口内角标不能再定位：否则 surfaceRO 会在动画每一帧做强制布局。
tickOverlay();
check("420ms 保护窗口内 positionBadge 不更新角标",
  badge.style.left === badgeLeftBeforeSwitch,
  `before=${badgeLeftBeforeSwitch} now=${badge.style.left}`);
await wait(460);
check("420ms 后移除 data-lagfix-pane-switch",
  docEl.getAttribute("data-lagfix-pane-switch") === null,
  `attr=${docEl.getAttribute("data-lagfix-pane-switch")}`);
tickOverlay();
check("保护结束后角标恢复定位（right=1000 → left=704）",
  badge.style.left === "704px", `left=${badge.style.left}`);

// 常开期：角标定位最多 1 次 / 1.8s；消息层 mask 由常开期属性关闭。
const paneHoldLeft = badge.style.left;
mainSurface._rect = { left: 500, top: 500, right: 1100, bottom: 620, width: 600, height: 120 };
tickOverlay();
check("面板常开期 1.8s 内第二次定位被跳过",
  badge.style.left === paneHoldLeft, `before=${paneHoldLeft} now=${badge.style.left}`);
await wait(1900);
tickOverlay();
check("1.8s 后角标恢复定位（right=1100 → left=804）",
  badge.style.left === "804px", `left=${badge.style.left}`);

// 常开期节流下限：面板打开时至少 300ms。
let paneNotify = 0;
const unPaneNotify = s3.store.subscribe(() => { paneNotify++; });
s3.store.emit();
check("面板常开期 effectiveThrottleMs 至少 300ms",
  collect().fix.eff >= 300, `eff=${collect().fix.eff}`);

// P2 独立关闭：属性立即移除、下限回落。
writeSettings({ paneHoldOn: false });
check("paneHoldOn=false 立即移除 data-lagfix-pane-open",
  docEl.getAttribute("data-lagfix-pane-open") === null,
  `attr=${docEl.getAttribute("data-lagfix-pane-open")}`);
s3.store.emit();
check("paneHoldOn=false 时节流下限回落到 120ms",
  collect().fix.eff < 300, `eff=${collect().fix.eff}`);
writeSettings({ paneHoldOn: true });
check("重新开启 P2 属性回来",
  docEl.getAttribute("data-lagfix-pane-open") === "1",
  `attr=${docEl.getAttribute("data-lagfix-pane-open")}`);

console.log("-- v0.3.5 O5：面板期进一步合并 --");
check("默认 panelQuietOn=false（运行期快照）", collect().settings.panelQuietOn === false,
  `snapshot=${collect().settings.panelQuietOn}`);
s3.store.emit();
const effP2 = collect().fix.eff;
check("前置：P2 面板常开期 eff 在 300–399ms", effP2 >= 300 && effP2 < 400, `eff=${effP2}`);
writeSettings({ panelQuietOn: true });
s3.store.emit();
const quietSnap = collect();
check("O5 开：面板常开期 eff >= 400ms", quietSnap.fix.eff >= 400,
  `eff=${quietSnap.fix.eff}`);
check("O5 生效时样本 panelQuiet=1 且 paneOpen=true",
  quietSnap.panelQuiet === 1 && quietSnap.paneOpen === true,
  `panelQuiet=${quietSnap.panelQuiet} paneOpen=${quietSnap.paneOpen}`);
// 角标配额：重新开合一次拿到干净基准，再验证 3s 窗口。
paneFrame.setAttribute("aria-hidden", "true");
fireMutation(paneFrame, "aria-hidden", "false");
await wait(450);
mainSurface._rect = { left: 500, top: 500, right: 1100, bottom: 620, width: 600, height: 120 };
paneFrame.setAttribute("aria-hidden", "false");
fireMutation(paneFrame, "aria-hidden", "true");
await wait(460);   // 让 420ms 开合保护先结束
tickOverlay();
const quietBadgeBase = badge.style.left;
mainSurface._rect = { left: 600, top: 500, right: 1200, bottom: 620, width: 600, height: 120 };
await wait(1900);
tickOverlay();
check("O5 面板期 1.9s 内角标不移动（3s 配额）",
  badge.style.left === quietBadgeBase,
  `before=${quietBadgeBase} now=${badge.style.left}`);
await wait(1250);
tickOverlay();
check("O5 面板期 3.15s 后角标恢复定位（right=1200 → left=904）",
  badge.style.left === "904px", `left=${badge.style.left}`);
// O5 关闭立即回到 P2 的 300ms / 1.8s。
writeSettings({ panelQuietOn: false });
s3.store.emit();
const effBack = collect();
check("O5 关闭后 eff 回落到 P2 的 300ms 档（<400）",
  effBack.fix.eff >= 300 && effBack.fix.eff < 400,
  `eff=${effBack.fix.eff}`);
check("O5 关闭后 panelQuiet=0", effBack.panelQuiet === 0,
  `panelQuiet=${effBack.panelQuiet}`);
// O5 与 P0/P1/P2 独立：三项全关、O5 开时 pane 探针仍要活着（400ms + panelQuiet=1），
// 但不能加常开属性。
writeSettings({ paneDiagOn: false, paneSwitchGuardOn: false,
  paneHoldOn: false, panelQuietOn: true });
s3.store.emit();
const effIndep = collect();
check("P0/P1/P2 全关时 O5 仍独立生效（eff>=400、panelQuiet=1、paneOpen=true）",
  effIndep.fix.eff >= 400 && effIndep.panelQuiet === 1 && effIndep.paneOpen === true
    && docEl.getAttribute("data-lagfix-pane-open") === null,
  `eff=${effIndep.fix.eff} quiet=${effIndep.panelQuiet} open=${effIndep.paneOpen} attr=${docEl.getAttribute("data-lagfix-pane-open")}`);
writeSettings({ paneDiagOn: true, paneSwitchGuardOn: true,
  paneHoldOn: true, panelQuietOn: true });
// 面板关闭后 O5 的 400ms 下限必须当拍消失（回到 P2 的 300ms 档）。
paneFrame.setAttribute("aria-hidden", "true");
fireMutation(paneFrame, "aria-hidden", "false");
await wait(460);
s3.store.emit();
const effClosed = collect();
check("面板关闭后 O5 的 400ms 下限立即消失",
  effClosed.fix.eff < 400 && effClosed.panelQuiet === 0,
  `eff=${effClosed.fix.eff} quiet=${effClosed.panelQuiet}`);
writeSettings({ paneHoldOn: true, panelQuietOn: false });
s3.store.emit();
check("O5 关闭且面板收起时不再有 400ms 下限",
  collect().fix.eff < 400,
  `eff=${collect().fix.eff}`);
await wait(460);


// P1 独立关闭：不加 420ms 属性，但 P0/P2 仍然工作。
writeSettings({ paneSwitchGuardOn: false });
paneFrame.setAttribute("aria-hidden", "true");
fireMutation(paneFrame, "aria-hidden", "false");
await wait(160);
paneFrame.setAttribute("aria-hidden", "false");
fireMutation(paneFrame, "aria-hidden", "true");
check("paneSwitchGuardOn=false 不加 data-lagfix-pane-switch",
  docEl.getAttribute("data-lagfix-pane-switch") === null,
  `attr=${docEl.getAttribute("data-lagfix-pane-switch")}`);
check("关 P1 不影响 P2 常开期属性",
  docEl.getAttribute("data-lagfix-pane-open") === "1");
writeSettings({ paneSwitchGuardOn: true });
paneFrame.setAttribute("aria-hidden", "true");
fireMutation(paneFrame, "aria-hidden", "false");
await wait(160);
paneFrame.setAttribute("aria-hidden", "false");
fireMutation(paneFrame, "aria-hidden", "true");
check("重新开启 P1 后开合属性回来",
  docEl.getAttribute("data-lagfix-pane-switch") === "1",
  `attr=${docEl.getAttribute("data-lagfix-pane-switch")}`);

// class 信号：aria-hidden 未变时也必须单独记一次（超过 150ms 双信号去重窗口）。
await wait(200);
const switchesBeforeClass = (paneOf() || {}).switches;
panePanel.setAttribute("class", "transition-[flex-grow] duration-200 ease-out");
fireMutation(panePanel, "class", "");
check("class-only 信号也记一次 switch",
  (paneOf() || {}).switches === switchesBeforeClass + 1,
  `before=${switchesBeforeClass} after=${(paneOf() || {}).switches}`);

// 同一轮 aria-hidden + class 两个信号只记一次。
const switchesBeforeDual = (paneOf() || {}).switches;
paneFrame.setAttribute("aria-hidden", "true");
fireMutation(paneFrame, "aria-hidden", "false");
panePanel.setAttribute("class", "");
fireMutation(panePanel, "class", "transition-[flex-grow] duration-200 ease-out");
panePanel.setAttribute("class", "transition-[flex-grow] duration-200 ease-out");
fireMutation(panePanel, "class", "");
check("同一轮 aria-hidden + class 双信号只记一次 switch",
  (paneOf() || {}).switches === switchesBeforeDual + 1,
  `before=${switchesBeforeDual} after=${(paneOf() || {}).switches}`);

// P0 独立关闭：先保持面板打开，验证 P2 不受 P0 关闭影响。
paneFrame.setAttribute("aria-hidden", "false");
fireMutation(paneFrame, "aria-hidden", "true");
check("P0 关闭前常开属性存在（前置条件）",
  docEl.getAttribute("data-lagfix-pane-open") === "1");
writeSettings({ paneDiagOn: false });
const paneDiagOff = collect();
check("paneDiagOn=false 时 pane/refocus 为 null",
  paneDiagOff.pane === null && paneDiagOff.refocus === null,
  `pane=${JSON.stringify(paneDiagOff.pane)} refocus=${JSON.stringify(paneDiagOff.refocus)}`);
check("关 P0 不影响 P2 常开期属性",
  docEl.getAttribute("data-lagfix-pane-open") === "1");
writeSettings({ paneDiagOn: true });
check("重新开启 P0 后 pane 字段回来", !!paneOf() && paneOf().detected === true);

// 宿主标记缺失：detected=false，不猜、不加保护属性。
sidePaneFrame = null;
const paneMissing = collect();
const paneMissingData = paneMissing.pane || {};
check("侧栏标记缺失时 detected=false",
  paneMissingData.detected === false,
  JSON.stringify(paneMissingData));
check("侧栏标记缺失时 panelPx=null 且保护属性移除",
  paneMissingData.panelPx === null
    && docEl.getAttribute("data-lagfix-pane-open") === null
    && docEl.getAttribute("data-lagfix-pane-switch") === null,
  `panelPx=${paneMissingData.panelPx} open=${docEl.getAttribute("data-lagfix-pane-open")}`);
sidePaneFrame = paneFrame;
const paneBack = collect();
check("标记回来后重新检测到侧栏", (paneBack.pane || {}).detected === true);

// 收起面板，等保护窗口结束，给回前台用例一个干净基线。
paneFrame.setAttribute("aria-hidden", "true");
fireMutation(paneFrame, "aria-hidden", "false");
check("关闭面板立即移除常开期属性",
  docEl.getAttribute("data-lagfix-pane-open") === null,
  `attr=${docEl.getAttribute("data-lagfix-pane-open")}`);
await wait(460);

console.log("-- v0.3.3 回前台：合并补发、700ms 下限、角标跳过 --");
const visListeners = () => documentStub._listeners.visibilitychange || [];
check("注册了 visibilitychange / focus / blur",
  visListeners().length >= 1
    && (window._listeners.focus || []).length >= 1
    && (window._listeners.blur || []).length >= 1,
  `vis=${visListeners().length} focus=${(window._listeners.focus || []).length} blur=${(window._listeners.blur || []).length}`);

let refocusHits = 0;
const unRefocus = s3.store.subscribe(() => { refocusHits++; });
const guardsBeforeFocus = refocusOf().guardHits;
(window._listeners.focus || []).forEach((fn) => fn({}));
check("首次 window.focus（无前置 blur）不算回前台",
  refocusOf().guardHits === guardsBeforeFocus,
  `guardHits=${refocusOf().guardHits}`);

// 后台→前台：pending 通知不能在 visibilitychange 里同步补发。
documentStub.hidden = true;
visListeners().forEach((fn) => fn({}));
await wait(60);
s3.store.emit();   // hiddenSkipOn：挂起，1s 定时器
check("后台挂起期间不立即补发", refocusHits === 0, `hits=${refocusHits}`);
documentStub.hidden = false;
visListeners().forEach((fn) => fn({}));
check("回前台后 120ms 内不补发", refocusHits === 0, `hits=${refocusHits}`);
await wait(150);
check("回前台 120ms 后补发一次", refocusHits === 1, `hits=${refocusHits}`);
const afterVisible = refocusOf();
check("refocus.hiddenMs 记录后台时长", typeof afterVisible.hiddenMs === "number" && afterVisible.hiddenMs >= 50,
  `hiddenMs=${afterVisible.hiddenMs}`);
check("refocus.sinceVisibleMs 为数值", typeof afterVisible.sinceVisibleMs === "number",
  `sinceVisibleMs=${afterVisible.sinceVisibleMs}`);
check("refocus.flushes 只计有 pending 的订阅", afterVisible.flushes >= 1,
  `flushes=${afterVisible.flushes}`);
check("refocus.guardHits 递增", afterVisible.guardHits === guardsBeforeFocus + 1,
  `guardHits=${afterVisible.guardHits}`);

// 回前台 800ms 帧窗口。
const r0 = performance.now();
driveFrame(r0);
driveFrame(r0 + 16);
driveFrame(r0 + 48);
driveFrame(r0 + 90);
const afterFrames = refocusOf();
check("refocus.p95/max 来自回前台后帧窗口",
  typeof afterFrames.p95 === "number" && typeof afterFrames.max === "number" && afterFrames.max >= afterFrames.p95,
  `p95=${afterFrames.p95} max=${afterFrames.max}`);

// 700ms 内至少 400ms。
s3.store.emit();
check("回前台 700ms 内 effectiveThrottleMs 至少 400ms",
  collect().fix.eff >= 400, `eff=${collect().fix.eff}`);
await wait(1100);
s3.store.emit();
check("回前台保护结束后节流下限回落", collect().fix.eff < 400, `eff=${collect().fix.eff}`);
driveFrame(performance.now());

// blur→focus 路径（Alt-Tab 不一定改 document.hidden）。
await wait(520);
const guardsBeforeBlur = refocusOf().guardHits;
const badgeLeftBeforeRefocus = badge.style.left;
mainSurface._rect = { left: 600, top: 500, right: 1200, bottom: 620, width: 600, height: 120 };
(window._listeners.blur || []).forEach((fn) => fn({}));
(window._listeners.focus || []).forEach((fn) => fn({}));
tickOverlay();
check("回前台前 300ms 不更新角标",
  badge.style.left === badgeLeftBeforeRefocus,
  `before=${badgeLeftBeforeRefocus} now=${badge.style.left}`);
check("blur→focus 记一次回前台", refocusOf().guardHits === guardsBeforeBlur + 1,
  `guardHits=${refocusOf().guardHits}`);
(window._listeners.focus || []).forEach((fn) => fn({}));
check("没有新的 blur 时重复 focus 不再计数",
  refocusOf().guardHits === guardsBeforeBlur + 1,
  `guardHits=${refocusOf().guardHits}`);
await wait(340);
tickOverlay();
check("回前台 300ms 后角标恢复定位（right=1200 → left=904）",
  badge.style.left === "904px", `left=${badge.style.left}`);
mainSurface._rect = { left: 300, top: 500, right: 900, bottom: 620, width: 600, height: 120 };

// P3 独立关闭：同步补发、不抬下限、不跳过角标。
await wait(520);
writeSettings({ refocusGuardOn: false });
const hitsBeforeOff = refocusHits;
documentStub.hidden = true;
visListeners().forEach((fn) => fn({}));
await wait(20);
s3.store.emit();
documentStub.hidden = false;
visListeners().forEach((fn) => fn({}));
check("refocusGuardOn=false 时同步补发", refocusHits > hitsBeforeOff,
  `before=${hitsBeforeOff} after=${refocusHits}`);
check("refocusGuardOn=false 时 guardHits 归零", refocusOf().guardHits === 0,
  `guardHits=${refocusOf().guardHits}`);
s3.store.emit();
check("refocusGuardOn=false 时不抬 400ms 下限",
  collect().fix.eff < 400, `eff=${collect().fix.eff}`);
writeSettings({ refocusGuardOn: true });
unRefocus();
unPaneNotify();

// P0+P3 都关：visibilitychange 基线必须保留，回前台仍要立即补发。
writeSettings({ paneDiagOn: false, refocusGuardOn: false });
check("P0+P3 关闭后仍保留 visibilitychange 基线",
  visListeners().length === 1
    && (window._listeners.focus || []).length === 0
    && (window._listeners.blur || []).length === 0,
  `vis=${visListeners().length} focus=${(window._listeners.focus || []).length} blur=${(window._listeners.blur || []).length}`);
let baselineHits = 0;
const unBaseline = s3.store.subscribe(() => { baselineHits++; });
documentStub.hidden = true;
visListeners().forEach((fn) => fn({}));
await wait(20);
s3.store.emit();
documentStub.hidden = false;
visListeners().forEach((fn) => fn({}));
check("P0+P3 关闭后回前台仍同步补发", baselineHits === 1, `hits=${baselineHits}`);
unBaseline();
writeSettings({ paneDiagOn: true, refocusGuardOn: true });
check("重新开启后 visibility/focus/blur 都回来",
  visListeners().length === 1
    && (window._listeners.focus || []).length === 1
    && (window._listeners.blur || []).length === 1);

console.log("-- v0.3.4 P0：LoAF 卡顿归因 --");
const v034Defaults = JSON.parse(window.__lagfixCollect());
check("默认 lafDiagOn=true（读脚本加载时的快照）", initialSettings.lafDiagOn === true,
  `snapshot=${initialSettings.lafDiagOn}`);
check("默认 loadOlderPaceOn=false（实验默认关）", initialSettings.loadOlderPaceOn === false,
  `snapshot=${initialSettings.loadOlderPaceOn}`);
check("默认 turnContentVisOn=false（实验默认关）", initialSettings.turnContentVisOn === false,
  `snapshot=${initialSettings.turnContentVisOn}`);
check("laf 快照存在且浏览器支持标记为 1", v034Defaults.laf && v034Defaults.laf.supported === 1,
  JSON.stringify(v034Defaults.laf && v034Defaults.laf.supported));
// 真实 API 形状：forcedStyleAndLayoutDuration 在**脚本条目**（PerformanceScriptTiming）
// 上，帧对象（PerformanceLongAnimationFrameTiming）没有这个属性。
fireLoAF([
  {
    duration: 250.4,
    scripts: [
      { sourceURL: "https://example.com/assets/index-a1b2.js?v=9", invoker: "SCRIPT.getElementById:onclick",
        duration: 180.2, forcedStyleAndLayoutDuration: 100.4 },
      { sourceURL: "file:///D:/work/b.js#frag", invoker: "x".repeat(300),
        duration: 60.7, forcedStyleAndLayoutDuration: 43.2 },
    ],
  },
  { duration: 42, scripts: [] },   // <100ms：进计数、不进归因环
]);
const laf1 = JSON.parse(window.__lagfixCollect()).laf;
check("≥100ms 长帧进归因环，<100ms 只计数", laf1.detail.length === 1 && laf1.count === 2 && laf1.max === 250,
  `detail=${laf1.detail.length} count=${laf1.count} max=${laf1.max}`);
const ld0 = laf1.detail[0];
check("时长四舍五入", ld0.ms === 250, `ms=${ld0.ms}`);
check("styleMs = 各脚本强制布局时长之和（帧对象没有该字段）",
  ld0.styleMs === 144, `styleMs=${ld0.styleMs}（100.4+43.2≈144）`);
check("src 只留文件名（去查询串/去路径）",
  ld0.scripts[0].src === "index-a1b2.js" && ld0.scripts[1].src === "b.js",
  `src=[${ld0.scripts.map((s) => s.src)}]`);
check("scripts 按耗时降序", ld0.scripts[0].ms >= ld0.scripts[1].ms);
check("invoker 截断到 120 字符", ld0.scripts[1].invoker.length === 120,
  `len=${ld0.scripts[1].invoker.length}`);
const laf2 = JSON.parse(window.__lagfixCollect()).laf;
check("归因明细未变化时发 []（日志不膨胀）",
  Array.isArray(laf2.detail) && laf2.detail.length === 0);
for (let i = 0; i < 12; i++) fireLoAF([{ duration: 150, scripts: [] }]);
const laf3 = JSON.parse(window.__lagfixCollect()).laf;
check("归因环最多 10 条", laf3.detail.length === 10, `len=${laf3.detail.length}`);
// scripts >5 只留最贵的前 5
// 输入按耗时**升序**排列：若实现没排序，scripts[0] 会是 s0.js（最便宜的），
// 断言 scripts[0].src === "s6.js" 才能证明真的按耗时降序排过。
fireLoAF([{ duration: 210, scripts: Array.from({ length: 7 }, (_, i) => ({
  sourceURL: `s${i}.js`, invoker: "f", duration: 10 * (i + 1),
})) }]);
const laf4 = JSON.parse(window.__lagfixCollect()).laf;
check("scripts 按耗时降序只留前 5（最贵的 s6 在前，s0/s1 被截掉）",
  laf4.detail[laf4.detail.length - 1].scripts.length === 5
    && laf4.detail[laf4.detail.length - 1].scripts[0].src === "s6.js"
    && !laf4.detail[laf4.detail.length - 1].scripts.some((x) => x.src === "s0.js"),
  JSON.stringify(laf4.detail[laf4.detail.length - 1].scripts.map((x) => x.src)));
// lafDiagOn 关→开：环清空，不带旧数据（终审建议补）
writeSettings({ lafDiagOn: false });
writeSettings({ lafDiagOn: true });
fireLoAF([{ duration: 150, scripts: [] }]);
const laf5 = JSON.parse(window.__lagfixCollect()).laf;
check("lafDiagOn 重开后归因环从空开始（不带旧数据）",
  laf5.detail.length === 1, `len=${laf5.detail.length}`);
// lafMax 每周期清零（v0.3.4 对齐）：旧周期的 210/150 不留到本周期
fireLoAF([{ duration: 42, scripts: [] }]);
const laf6 = JSON.parse(window.__lagfixCollect()).laf;
check("lafMax 每周期清零（不拿陈旧最大值）", laf6.max === 42 && laf6.count === 1,
  `max=${laf6.max} count=${laf6.count}`);

// P2-3：Windows 反斜杠路径与 data:/blob: 也要按文件名处理
fireLoAF([{ duration: 120, scripts: [
  { sourceURL: String.raw`C:\Users\x\app.js`, invoker: "f", duration: 50 },
  { sourceURL: "data:text/javascript;base64,AAAA", invoker: "g", duration: 40 },
  { sourceURL: "blob:https://x/y", invoker: "h", duration: 30 },
] }]);
const lafWin = JSON.parse(window.__lagfixCollect()).laf;
const winScripts = lafWin.detail[lafWin.detail.length - 1].scripts;
check("Windows 反斜杠路径只留文件名",
  winScripts.some((x) => x.src === "app.js"), JSON.stringify(winScripts.map((x) => x.src)));
check("data:/blob: URL 不留原文（记为空）",
  winScripts.filter((x) => x.src === "").length === 2,
  JSON.stringify(winScripts.map((x) => x.src)));


console.log("-- v0.3.5 P0：长帧上下文归因 --");
check("默认 lafCtxOn=true（读脚本加载时的快照）", initialSettings.lafCtxOn === true,
  `snapshot=${initialSettings.lafCtxOn}`);
check("默认 panelQuietOn=false（实验默认关）", initialSettings.panelQuietOn === false,
  `snapshot=${initialSettings.panelQuietOn}`);
check("v0.4.3 已退役 loadOlderPageLimitOn：加载快照里没有这个键",
  initialSettings.loadOlderPageLimitOn === undefined,
  `snapshot=${initialSettings.loadOlderPageLimitOn}`);
check("默认 autoUpdateCheckOn=false（自动检查默认关）", initialSettings.autoUpdateCheckOn === false,
  `snapshot=${initialSettings.autoUpdateCheckOn}`);
check("默认 timerDiagOn=false（实验默认关）", initialSettings.timerDiagOn === false,
  `snapshot=${initialSettings.timerDiagOn}`);
documentStub.hidden = false;   // 后台窗口会走 hiddenSkipOn，通知不会立即 flush
writeSettings({ throttleOn: true, lafCtxOn: true });
check("P0 前置：合并刷新已启用并已装到当前 store",
  collect().fix.on === true && collect().fix.applied === true,
  `on=${collect().fix.on} applied=${collect().fix.applied}`);
// 先让节流窗口彻底空出来：滚动时间戳必须是最新的信号，否则会被更近的 flush 抢走。
await wait(150);
dispatchScroll(timelineEl);
// 真实 LoAF 顺序：entry.startTime 是帧起点，滚动回调的 performance.now()
// 发生在帧内（晚于 startTime）。用 startTime=now-2 建模，而不是 now+2。
fireLoAF([{ duration: 130, startTime: performance.now() - 2, scripts: [] }]);
// 冻结 performance.now：第一次通知立即放行（flush），50ms 后第二次通知进等待窗（notify）。
{
  const realPerfNow2 = performance.now;
  const base = realPerfNow2() + 1000;
  let fakeT = base;
  performance.now = () => fakeT;
  try {
    s3.store.subscribe(() => {});
    s3.store.emit();          // lastNotify=base, lastFlush=base（窗口空 → 立即）
    fireLoAF([{ duration: 135, startTime: base, scripts: [] }]);
    fakeT = base + 50;
    s3.store.emit();          // lastNotify=base+50；wait>0 → 只挂起，不 flush
    fireLoAF([{ duration: 140, startTime: base + 50, scripts: [] }]);
  } finally {
    performance.now = realPerfNow2;
  }
}
// 所有信号都超过 1000ms 之外：归到 other。
fireLoAF([{ duration: 150, startTime: performance.now() + 5000, scripts: [] }]);
const ctxSnap = JSON.parse(window.__lagfixCollect()).laf;
check("样本 laf.ctx 存在且四类计数非负",
  ctxSnap && ctxSnap.ctx && ["flush", "notify", "scroll", "other"]
    .every((k) => typeof ctxSnap.ctx[k] === "number" && ctxSnap.ctx[k] >= 0),
  JSON.stringify(ctxSnap && ctxSnap.ctx));
const ctxDetails = ctxSnap.detail.filter((d) => d && d.src);
check("明细带 src 与四个 since* 字段",
  ctxDetails.length >= 4
    && ctxDetails.every((d) => ["sinceNotify", "sinceFlush", "sinceScroll", "sinceCommit"]
      .every((k) => d[k] === null || typeof d[k] === "number")),
  JSON.stringify(ctxDetails.slice(-4)));
check("滚动后立刻投递的长帧归到 scroll",
  ctxDetails.some((d) => d.src === "scroll"),
  JSON.stringify(ctxDetails.map((d) => d.src)));
check("立即放行的通知归到 flush",
  ctxDetails.some((d) => d.src === "flush"),
  JSON.stringify({ srcs: ctxDetails.map((d) => d.src), diag: window.__lagfixDiag().lafCtx }));
check("等待窗内的通知归到 notify",
  ctxDetails.some((d) => d.src === "notify"),
  JSON.stringify(ctxDetails.map((d) => d.src)));
check("所有信号都超窗的长帧归到 other",
  ctxDetails.some((d) => d.src === "other"),
  JSON.stringify(ctxDetails.map((d) => d.src)));
check("本周期来源计数与明细一致（四类各至少 1 次）",
  ctxSnap.ctx.scroll >= 1 && ctxSnap.ctx.flush >= 1
    && ctxSnap.ctx.notify >= 1 && ctxSnap.ctx.other >= 1,
  JSON.stringify(ctxSnap.ctx));
// 关掉 P0：ctx 为 null、明细不带上下文字段；重开后从 0 起算。
writeSettings({ lafCtxOn: false });
fireLoAF([{ duration: 160, startTime: performance.now(), scripts: [] }]);
const ctxOff = JSON.parse(window.__lagfixCollect()).laf;
check("lafCtxOn=false 时 ctx=null 且所有明细都不带 src（旧环也被清理）",
  ctxOff.ctx === null && ctxOff.detail.every((d) => d.src === undefined),
  JSON.stringify({ ctx: ctxOff.ctx, srcs: ctxOff.detail.map((d) => d.src) }));
writeSettings({ lafCtxOn: true });
const ctxRe = JSON.parse(window.__lagfixCollect()).laf;
check("lafCtxOn 重开后来源计数从 0 起算",
  ctxRe.ctx && ["flush", "notify", "scroll", "other"].every((k) => ctxRe.ctx[k] === 0),
  JSON.stringify(ctxRe.ctx));
// 关掉滚动诊断、只留 P0：scroll 监听必须保留，滚动时间戳仍能归因。
writeSettings({ scrollDiagOn: false });
dispatchScroll(timelineEl);
fireLoAF([{ duration: 120, startTime: performance.now() - 2, scripts: [] }]);
const ctxNoScrollDiag = JSON.parse(window.__lagfixCollect()).laf;
check("关滚动诊断后 P0 仍保留滚动时间戳（来源=scroll）",
  ctxNoScrollDiag.detail.some((d) => d.src === "scroll"),
  JSON.stringify(ctxNoScrollDiag.detail.map((d) => d.src)));
writeSettings({ scrollDiagOn: true });
// 关闭合并刷新：旧 wrapper 可能还在，但 P0 不得再写 notify/flush，也不能归到 flush。
writeSettings({ throttleOn: false });
s3.store.emit();
const diagNoThrottle = window.__lagfixDiag().lafCtx;
check("关闭合并刷新后通知/补发时间戳被清零且不再更新",
  diagNoThrottle.notify === 0 && diagNoThrottle.flush === 0,
  JSON.stringify({ notify: diagNoThrottle.notify, flush: diagNoThrottle.flush }));
fireLoAF([{ duration: 120, startTime: performance.now() - 2, scripts: [] }]);
const ctxNoThrottle = JSON.parse(window.__lagfixCollect()).laf;
const ctxNoThrottleLast = ctxNoThrottle.detail[ctxNoThrottle.detail.length - 1] || {};
check("关闭合并刷新后长帧不会归到 flush",
  ctxNoThrottleLast.src !== "flush",
  JSON.stringify({ src: ctxNoThrottleLast.src, sinceFlush: ctxNoThrottleLast.sinceFlush }));
writeSettings({ throttleOn: true });
// 暂停：四个时间戳、周期计数与样本状态全部清零/复位。
s3.store.emit();
dispatchScroll(timelineEl);
writeSettings({ observe: false });
const pausedCtx = window.__lagfixDiag().lafCtx;
check("暂停后 lafCtx 时间戳与计数全部清零",
  pausedCtx.notify === 0 && pausedCtx.flush === 0
    && pausedCtx.scroll === 0 && pausedCtx.commit === 0
    && ["flush", "notify", "scroll", "other"].every((k) => pausedCtx.counts[k] === 0),
  JSON.stringify(pausedCtx));
const pausedSnapP0 = collect();
check("暂停样本 paneOpen=null、panelQuiet=0",
  pausedSnapP0.paneOpen === null && pausedSnapP0.panelQuiet === 0,
  `paneOpen=${pausedSnapP0.paneOpen} panelQuiet=${pausedSnapP0.panelQuiet}`);
writeSettings({ observe: true });



console.log("-- v0.3.4 O4：长回合渲染减负 --");
check("O4 前置：默认无 CV 属性", docEl.getAttribute("data-lagfix-cv") === null,
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
const cvStyleEl = documentStub.getElementById("lagfix-style");
check("CSS 含 turn 内行级 content-visibility 规则（排除 live tail）",
  !!cvStyleEl
  && String(cvStyleEl.textContent).includes('[data-lagfix-cv="1"] [data-v4-turn-unit="true"]:not([data-v4-running-live-tail]) [data-row-id]')
  && String(cvStyleEl.textContent).includes("content-visibility:auto")
  && String(cvStyleEl.textContent).includes("contain-intrinsic-size:auto 160px"));
writeSettings({ turnContentVisOn: true });
check("开启后 documentElement 带 data-lagfix-cv=1",
  docEl.getAttribute("data-lagfix-cv") === "1", `attr=${docEl.getAttribute("data-lagfix-cv")}`);
// 页面卸载（pagehide/beforeunload）也要移除 CV 属性（终审建议补；此时卸载监听仍在挂）
(window._listeners.pagehide || []).forEach((fn) => fn({}));
check("pagehide 移除 data-lagfix-cv", docEl.getAttribute("data-lagfix-cv") === null,
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
writeSettings({ turnContentVisOn: false });
check("关闭后属性移除", docEl.getAttribute("data-lagfix-cv") === null,
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);

// ---------- v0.4.0 T1：第三方定时器归因（默认关） ----------
console.log("-- v0.4.0 T1：第三方定时器归因（默认关） --");
const t1RealTimeout = globalThis.setTimeout;
const t1RealInterval = globalThis.setInterval;
check("T1 前置：默认关闭", collect().settings.timerDiagOn === false,
  `timerDiagOn=${collect().settings.timerDiagOn}`);
check("T1 前置：默认样本 timer=null", collect().timer === null,
  JSON.stringify(collect().timer));
writeSettings({ timerDiagOn: true });
check("T1 开启后 setTimeout/setInterval 被替换",
  globalThis.setTimeout !== t1RealTimeout && globalThis.setInterval !== t1RealInterval
    && typeof globalThis.setTimeout === "function"
    && typeof globalThis.setInterval === "function",
  `timeout=${globalThis.setTimeout === t1RealTimeout} interval=${globalThis.setInterval === t1RealInterval}`);
const t1On = collect().timer;
check("T1 开启后样本 supported=1、count=0、detail=[]",
  t1On && t1On.supported === 1 && t1On.count === 0 && Array.isArray(t1On.detail),
  JSON.stringify(t1On));

// <50ms 的回调不记录。
await new Promise((resolve) => {
  const id = window.setTimeout(() => resolve(), 1);
  check("T1 保留原始定时器 id", id !== undefined && id !== null, String(id));
});
check("T1 短回调不记录", collect().timer.count === 0, JSON.stringify(collect().timer));

// ≥50ms 的超时回调：参数、this、耗时、请求延迟、回调名与调用点都要对。
// this 由宿主原始实现决定：浏览器为 window，Node 测试环境为该定时器对象本身。
let t1ArgSum = 0;
let t1This = null;
let t1TimerId = null;
await new Promise((resolve) => {
  t1TimerId = window.setTimeout(function slowHeartbeat(a, b) {
    t1This = this;
    t1ArgSum = a + b;
    const t0 = performance.now();
    while (performance.now() - t0 < 60) { /* 占住主线程 */ }
    resolve();
  }, 10, 2, 3);
});
check("T1 保留回调参数", t1ArgSum === 5, `sum=${t1ArgSum}`);
check("T1 保留回调 this（宿主原始语义）",
  t1This === t1TimerId || t1This === globalThis,
  String(t1This));
const t1Slow = collect().timer;
check("T1 记录 ≥50ms 超时回调",
  t1Slow && t1Slow.count === 1 && t1Slow.max >= 50 && t1Slow.detail.length === 1,
  JSON.stringify(t1Slow));
const t1Rec = t1Slow.detail[0] || {};
check("T1 明细字段：ms/delay/kind/src/invoker",
  t1Rec.ms >= 50 && t1Rec.delay === 10 && t1Rec.kind === "timeout"
    && t1Rec.src === "slowHeartbeat"
    && typeof t1Rec.invoker === "string" && t1Rec.invoker.length > 0
    && t1Rec.invoker.length <= 120
    && typeof t1Rec.t === "number",
  JSON.stringify(t1Rec));
check("T1 明细未变化时发 []", JSON.stringify(collect().timer.detail) === "[]",
  JSON.stringify(collect().timer.detail));

// 周期计数：间隔回调按 interval 记录。
await new Promise((resolve) => {
  let n = 0;
  const id = window.setInterval(function slowTick() {
    const t0 = performance.now();
    while (performance.now() - t0 < 55) { /* 占住主线程 */ }
    n++;
    if (n >= 1) { clearInterval(id); resolve(); }
  }, 5);
});
const t1Int = collect().timer;
check("T1 记录 ≥50ms 间隔回调",
  t1Int && t1Int.count >= 1 && t1Int.detail.length >= 1
    && t1Int.detail[t1Int.detail.length - 1].kind === "interval",
  JSON.stringify(t1Int));

// 回调抛错：先照实记录，再把原异常抛给宿主（用 uncaughtException 接住，避免测试进程退出）。
const t1Boom = await new Promise((resolve) => {
  const onErr = (e) => { process.removeListener("uncaughtException", onErr); resolve(String(e && e.message)); };
  process.on("uncaughtException", onErr);
  window.setTimeout(function slowThrowTimer() {
    const t0 = performance.now();
    while (performance.now() - t0 < 55) { /* 占住主线程 */ }
    throw new Error("t1-boom");
  }, 0);
});
check("T1 回调异常仍抛给宿主", t1Boom === "t1-boom", t1Boom);
const t1ThrowDetail = collect().timer.detail;
check("T1 抛出前仍记录耗时",
  t1ThrowDetail.some((d) => d && d.src === "slowThrowTimer" && d.ms >= 50),
  JSON.stringify(t1ThrowDetail));

// 字符串 handler 原样放行：不包装、不记录，直接交给原方法。
writeSettings({ timerDiagOn: false });
check("T1 关闭后恢复原始 setTimeout/setInterval",
  globalThis.setTimeout === t1RealTimeout && globalThis.setInterval === t1RealInterval,
  `timeout=${globalThis.setTimeout === t1RealTimeout} interval=${globalThis.setInterval === t1RealInterval}`);
const t1Spy = { args: null };
const t1SpyFn = function (...a) { t1Spy.args = a; return 123; };
globalThis.setTimeout = t1SpyFn;
writeSettings({ timerDiagOn: true });   // 以 spy 为“原始方法”安装包装
t1Spy.args = null;
const t1StrId = window.setTimeout("globalThis.__t1x=1", 7);
check("T1 字符串 handler 原样放行",
  t1StrId === 123 && Array.isArray(t1Spy.args)
    && t1Spy.args[0] === "globalThis.__t1x=1" && t1Spy.args.length === 2
    && t1Spy.args[1] === 7,
  `id=${t1StrId} args=${JSON.stringify(t1Spy.args)}`);
writeSettings({ timerDiagOn: false });  // 先把 spy 还回来
globalThis.setTimeout = t1RealTimeout;
globalThis.setInterval = t1RealInterval;
check("T1 关闭后全局方法恢复为测试原引用",
  globalThis.setTimeout === t1RealTimeout && globalThis.setInterval === t1RealInterval);

// 明细环最多 10 条。
writeSettings({ timerDiagOn: true });
await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve) => {
  window.setTimeout(() => {
    const t0 = performance.now();
    while (performance.now() - t0 < 55) { /* 占住主线程 */ }
    resolve();
  }, 0);
})));
const t1Ring = collect().timer;
check("T1 明细环最多 10 条",
  t1Ring && t1Ring.detail.length === 10 && t1Ring.count >= 12,
  `detail=${t1Ring && t1Ring.detail.length} count=${t1Ring && t1Ring.count}`);

// 插件自己调度的定时器不进明细：用栈里带 lagfix-observe 的调度点模拟自测噪声。
collect();   // 清周期计数
const t1SelfScheduler = {
  "lagfix-observe": function (fn) { return window.setTimeout(fn, 0); },
};
await new Promise((resolve) => {
  t1SelfScheduler["lagfix-observe"](function selfSlow() {
    const t0 = performance.now();
    while (performance.now() - t0 < 60) { /* 占住主线程 */ }
    resolve();
  });
});
const t1Self = collect().timer;
check("T1 自己调度的定时器不进明细",
  t1Self && t1Self.count === 0 && t1Self.detail.length === 0,
  JSON.stringify(t1Self));

// 暂停观测：恢复原始定时器、样本 timer=null；恢复后按开关重新安装。
writeSettings({ observe: false });
check("T1 暂停观测后恢复原始定时器",
  globalThis.setTimeout === t1RealTimeout && globalThis.setInterval === t1RealInterval,
  `timeout=${globalThis.setTimeout === t1RealTimeout}`);
check("T1 暂停样本 timer=null", collect().timer === null, JSON.stringify(collect().timer));
writeSettings({ observe: true });
check("T1 恢复观测后按开关重新安装",
  globalThis.setTimeout !== t1RealTimeout && collect().timer
    && collect().timer.supported === 1,
  `timeout=${globalThis.setTimeout === t1RealTimeout}`);

// v0.4.2：宿主替换 setTimeout 后，probe 必须识别失配，停止抓栈/计数；
// 再次应用设置时以宿主新实现为 original 重装，关闭时不覆盖宿主。
const t1WrappedBeforeHost = globalThis.setTimeout;
const t1HostNewTimeout = function (...args) { return t1RealTimeout.apply(this, args); };
globalThis.setTimeout = t1HostNewTimeout;
const t1LostSample = collect().timer;
check("T1 宿主替换 setTimeout 后 supported=0/lost=1",
  t1LostSample && t1LostSample.supported === 0 && t1LostSample.lost === 1,
  JSON.stringify(t1LostSample));
const t1CountBeforeOld = t1LostSample ? t1LostSample.count : 0;
await new Promise((resolve) => {
  t1WrappedBeforeHost(function staleSlow() {
    const t0 = performance.now();
    while (performance.now() - t0 < 60) { /* 占住主线程 */ }
    resolve();
  }, 0);
});
const t1AfterOld = collect().timer;
check("T1 失配后旧 wrapper 不再计数",
  t1AfterOld && t1AfterOld.count === t1CountBeforeOld,
  JSON.stringify(t1AfterOld));
writeSettings({ timerDiagOn: false });
check("T1 关闭后恢复宿主替换实现，不覆盖",
  globalThis.setTimeout === t1HostNewTimeout
    && globalThis.setInterval === t1RealInterval,
  `timeoutHost=${globalThis.setTimeout === t1HostNewTimeout}`);
writeSettings({ timerDiagOn: true });
const t1Re = collect().timer;
check("T1 失配后重新应用以宿主实现为 original",
  t1Re && t1Re.supported === 1 && t1Re.lost === 0
    && globalThis.setTimeout !== t1HostNewTimeout
    && globalThis.setTimeout !== t1WrappedBeforeHost,
  JSON.stringify(t1Re));
writeSettings({ timerDiagOn: false });
check("T1 关闭后恢复宿主替换实现，不覆盖（二次）",
  globalThis.setTimeout === t1HostNewTimeout
    && globalThis.setInterval === t1RealInterval,
  `timeoutHost=${globalThis.setTimeout === t1HostNewTimeout}`);
globalThis.setTimeout = t1RealTimeout;
globalThis.setInterval = t1RealInterval;
check("T1 清理后全局引用恢复测试原值",
  globalThis.setTimeout === t1RealTimeout && globalThis.setInterval === t1RealInterval);

// 给下面的 __lagfixOff 清理用例留一个已打开、保护属性在身上的现场。
paneFrame.setAttribute("aria-hidden", "false");
fireMutation(paneFrame, "aria-hidden", "true");
check("__lagfixOff 前置：开合/常开属性都在",
  docEl.getAttribute("data-lagfix-pane-switch") === "1"
    && docEl.getAttribute("data-lagfix-pane-open") === "1",
  `switch=${docEl.getAttribute("data-lagfix-pane-switch")} open=${docEl.getAttribute("data-lagfix-pane-open")}`);

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
// 先重新打开遮罩、滚动诊断与 CV 实验（上面的 __lagfixOff 已把它们关掉），再制造一个
// 活动的滚动属性，验证一键还原真的会清掉它、也会断开 long-animation-frame 观察器。
writeSettings({ maskOffOnScroll: true, scrollDiagOn: true, lafDiagOn: true, turnContentVisOn: true });
check("还原前置：CV 属性在身上", docEl.getAttribute("data-lagfix-cv") === "1",
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
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
check("__lagfixOff 移除 pagehide/beforeunload 监听",
  (window._listeners.pagehide || []).length === 0
    && (window._listeners.beforeunload || []).length === 0,
  `pagehide=${(window._listeners.pagehide || []).length}`);
check("原型 subscribe 已还原为包装前的同一引用", proto.subscribe === origSubscribeRef);
check("原型上的标记已删除", !proto.__lagfixThrottle);
check("大会话保护已还原到原始 loadAllOlder", proto.loadAllOlder === origLoadAllRef);
check("大赛话保护的标记已删除", !proto.__lagfixLoadAll);
check("__lagfixOff 后滚动属性已移除",
  docEl.getAttribute("data-lagfix-scroll") === null,
  `attr=${docEl.getAttribute("data-lagfix-scroll")}`);
check("__lagfixOff 后 loadOlder 观测已从当前 store 实例还原",
  s3.store.loadOlder === s3OrigLoadOlder
    && !Object.prototype.hasOwnProperty.call(s3.store, "loadOlder"));
check("__lagfixOff 后 loadOlder 标记已删除", !s3.store.__lagfixLoadOlder);
check("__lagfixOff 后 sessions 为 null", collect().sessions === null,
  `sessions=${JSON.stringify(collect().sessions)}`);
check("__lagfixOff 后 loadOlderDetail 为 null", collect().loadOlderDetail === null,
  `detail=${JSON.stringify(collect().loadOlderDetail)}`);
check("__lagfixOff 清空会话桶与 pane 映射", window.__lagfixDiag().sessionBuckets === 0
  && window.__lagfixDiag().sessionPanes === 0,
  `buckets=${window.__lagfixDiag().sessionBuckets} panes=${window.__lagfixDiag().sessionPanes}`);
check("__lagfixOff 清空 loadOlder 明细", window.__lagfixDiag().loadOlderDetail === 0);
check("__lagfixOff 移除 CV 属性（v0.3.4）",
  docEl.getAttribute("data-lagfix-cv") === null,
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
check("__lagfixOff 后 laf/pace 为 null",
  collect().laf === null && collect().pace === null,
  `laf=${JSON.stringify(collect().laf)} pace=${JSON.stringify(collect().pace)}`);
check("__lagfixOff 移除侧栏保护属性",
  docEl.getAttribute("data-lagfix-pane-switch") === null
    && docEl.getAttribute("data-lagfix-pane-open") === null,
  `switch=${docEl.getAttribute("data-lagfix-pane-switch")} open=${docEl.getAttribute("data-lagfix-pane-open")}`);
check("__lagfixOff 移除 P3 focus/blur，保留 v0.3.2 回前台基线 visibility",
  (documentStub._listeners.visibilitychange || []).length === 1
    && (window._listeners.focus || []).length === 0
    && (window._listeners.blur || []).length === 0,
  `vis=${(documentStub._listeners.visibilitychange || []).length} focus=${(window._listeners.focus || []).length} blur=${(window._listeners.blur || []).length}`);
check("__lagfixOff 后 pane/refocus 为 null",
  collect().pane === null && collect().refocus === null,
  `pane=${JSON.stringify(collect().pane)} refocus=${JSON.stringify(collect().refocus)}`);
check("__lagfixOff 清空侧栏状态", window.__lagfixDiag().paneDetected === false
  && window.__lagfixDiag().paneSwitches === 0,
  JSON.stringify({ detected: window.__lagfixDiag().paneDetected,
    switches: window.__lagfixDiag().paneSwitches }));

const saved = JSON.parse(localStorage.getItem("lagfix.settings.v1") || "{}");
check("设置已持久化到独立 key", saved.throttleOn === false, JSON.stringify(saved).slice(0, 90));
check("一键还原同时关掉大会话保护", saved.bigSessionOn === false);
check("一键还原同时关掉滚动诊断/输入延迟/遮罩/多会话归因",
  saved.scrollDiagOn === false && saved.inputLagOn === false && saved.maskOffOnScroll === false
  && saved.sessionDiagOn === false,
  `scrollDiagOn=${saved.scrollDiagOn} inputLagOn=${saved.inputLagOn} mask=${saved.maskOffOnScroll} session=${saved.sessionDiagOn}`);
check("一键还原同时关掉侧栏/回前台四项",
  saved.paneDiagOn === false && saved.paneSwitchGuardOn === false
    && saved.paneHoldOn === false && saved.refocusGuardOn === false,
  `paneDiagOn=${saved.paneDiagOn} guard=${saved.paneSwitchGuardOn} hold=${saved.paneHoldOn} refocus=${saved.refocusGuardOn}`);
check("一键还原同时关掉 v0.3.4 三项",
  saved.lafDiagOn === false && saved.loadOlderPaceOn === false && saved.turnContentVisOn === false,
  `laf=${saved.lafDiagOn} pace=${saved.loadOlderPaceOn} cv=${saved.turnContentVisOn}`);
check("一键还原同时关掉 v0.3.5 两项",
  saved.lafCtxOn === false && saved.panelQuietOn === false,
  `ctx=${saved.lafCtxOn} quiet=${saved.panelQuietOn}`);
check("一键还原同时关掉会话切换归因（v0.4.3 P0）",
  saved.switchDiagOn === false, `switchDiagOn=${saved.switchDiagOn}`);
check("一键还原不再写已退役的补页批量键",
  saved.loadOlderPageLimitOn === undefined,
  `pageLimit=${saved.loadOlderPageLimitOn}`);
check("一键还原同时关掉自动检查更新", saved.autoUpdateCheckOn === false,
  `auto=${saved.autoUpdateCheckOn}`);
check("一键还原同时关掉定时器归因（v0.4.0 T1）", saved.timerDiagOn === false,
  `timerDiagOn=${saved.timerDiagOn}`);
check("__lagfixOff 恢复原始定时器并清空样本/明细",
  globalThis.setTimeout === t1RealTimeout && globalThis.setInterval === t1RealInterval
    && collect().timer === null && window.__lagfixDiag().timer.detail === 0,
  `timeout=${globalThis.setTimeout === t1RealTimeout} timer=${JSON.stringify(collect().timer)}`);
check("__lagfixOff 清掉更新缓存与两处红点",
  localStorage.getItem("lagfix.update.v1") === null
    && documentStub.getElementById("lagfix-overlay-badge-update-dot").style.display === "none"
    && documentStub.getElementById("lagfix-settings-panel-updatedot").style.display === "none",
  `key=${localStorage.getItem("lagfix.update.v1")}`);
check("__lagfixOff 后齿轮提示不再提有新版本",
  documentStub.getElementById("lagfix-gear").title === "打开设置",
  documentStub.getElementById("lagfix-gear").title);
// 还原前已发出的检查可能在还原后才回来：没有新的用户动作，不得写回缓存/红点/状态文案。
window.__lagfixUpdate = { status: "ok", current: "0.4.3", latest: "9.9.9", newer: true,
  url: "https://example.invalid/releases", at: Date.now() + 1 };
window.__lagfixSettings();
check("__lagfixOff 后到达的在途结果不写缓存/红点",
  localStorage.getItem("lagfix.update.v1") === null
    && documentStub.getElementById("lagfix-overlay-badge-update-dot").style.display === "none"
    && documentStub.getElementById("lagfix-settings-panel-updatedot").style.display === "none",
  `key=${localStorage.getItem("lagfix.update.v1")}`);
check("__lagfixOff 后到达的在途结果不显示新版本文案",
  !String(documentStub.getElementById("lagfix-settings-panel-updatestatus").textContent)
    .includes("发现新版本"));
check("__lagfixOff 后 switch 为 null、page 字段已不存在",
  collect().switch === null && collect().page === undefined
    && window.__lagfixDiag().page === undefined,
  `switch=${JSON.stringify(collect().switch)} page=${JSON.stringify(collect().page)}`);
check("__lagfixOff 后 paneOpen=null、panelQuiet=0",
  collect().paneOpen === null && collect().panelQuiet === 0,
  `paneOpen=${collect().paneOpen} panelQuiet=${collect().panelQuiet}`);
check("日志上限默认 50MB 并已持久化", saved.logMaxMB === 50, `logMaxMB=${saved.logMaxMB}`);
check("没有污染宿主 localStorage 的其它 key",
  Object.keys(localStorage._d).every((k) => k === "lagfix.settings.v1"), Object.keys(localStorage._d).join(","));
check("重启请求不落盘（防重启死循环）", saved.restart === undefined && saved.restartRequested === undefined);

console.log("-- __lagfixOff：补拉被拦过的历史 --");
const beforeOffToggle = JSON.parse(localStorage.getItem("lagfix.settings.v1") || "{}");
localStorage.setItem("lagfix.settings.v1",
  JSON.stringify({ ...beforeOffToggle, throttleOn: true, bigSessionOn: true,
    scrollDiagOn: true, inputLagOn: true, maskOffOnScroll: true, sessionDiagOn: true,
    paneDiagOn: true, paneSwitchGuardOn: true, paneHoldOn: true, refocusGuardOn: true }));
onStorage({ key: "lagfix.settings.v1" });
await wait(50);
check("重新开启后大会话保护装到当前原型", !!s3.proto.__lagfixLoadAll);
check("重新开启后 loadOlder 观测装到当前 store 实例", !!s3.store.__lagfixLoadOlder);
check("重新开启后 scroll 监听只挂一份",
  (documentStub._listeners.scroll || []).length === 1,
  `count=${(documentStub._listeners.scroll || []).length}`);
const reSess = JSON.parse(window.__lagfixCollect()).sessions;
check("重新开启后多会话归因回到数组",
  Array.isArray(reSess) && reSess.length >= 1, `sessions=${JSON.stringify(reSess)}`);
check("重新开启后 pagehide 监听挂回来",
  (window._listeners.pagehide || []).length === 1,
  `count=${(window._listeners.pagehide || []).length}`);
check("重新开启后 visibility/focus/blur 监听挂回来",
  (documentStub._listeners.visibilitychange || []).length === 1
    && (window._listeners.focus || []).length === 1
    && (window._listeners.blur || []).length === 1,
  `vis=${(documentStub._listeners.visibilitychange || []).length} focus=${(window._listeners.focus || []).length} blur=${(window._listeners.blur || []).length}`);
const rePane = JSON.parse(window.__lagfixCollect()).pane;
check("重新开启后侧栏检测回来", rePane && rePane.detected === true,
  `pane=${JSON.stringify(rePane)}`);
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
check("大历史会话保护不跟着变灰（与合并刷新独立）",
  !!panel2 && allText(panel2).includes("和「合并刷新」互不影响"));

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
const throttleRow = findRow(documentStub.getElementById("lagfix-settings-panel"), "合并刷新");
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
check("设置弹窗打开时角标自动隐藏（A8 布局让位）",
  badge.style.display === "none", `display=${badge.style.display}`);
check("settings 快照不再输出 badgeVisible",
  !("badgeVisible" in JSON.parse(window.__lagfixCollect()).settings));
check("注册了全局快捷键监听", (window._listeners.keydown || []).length > 0);
(documentStub._listeners.keydown || []).forEach((fn) => fn({
  key: "Escape", target: panel2, stopPropagation() {},
}));
check("Esc 后弹窗隐藏",
  documentStub.getElementById("lagfix-modal-mask").style.display === "none");
await wait(1100);
check("关闭设置后角标恢复显示（旧 badgeVisible:false 被忽略）",
  badge.style.display !== "none", `display=${badge.style.display}`);
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

console.log("-- v0.3.4 面板与暂停路径 --");
// 三个新开关行都在面板里（诊断组一个 + 实验组两个）
const panelRootV34 = documentStub.getElementById("lagfix-settings-panel");
check("面板有「卡顿来源定位」行", !!findRow(panelRootV34, "卡顿来源定位"));
check("面板有「大会话翻页降频 · 实验」行", !!findRow(panelRootV34, "大会话翻页降频 · 实验"));
check("v0.4.3 面板已无「补页批量 · 实验」行（退役）",
  !findRow(panelRootV34, "补页批量 · 实验"));
check("面板有「切换会话归因」行", !!findRow(panelRootV34, "切换会话归因"));
check("面板有「长回合渲染减负 · 实验」行", !!findRow(panelRootV34, "长回合渲染减负 · 实验"));
check("面板有「卡顿来源细分」行", !!findRow(panelRootV34, "卡顿来源细分"));
check("面板有「第三方定时器归因 · 实验」行",
  !!findRow(panelRootV34, "第三方定时器归因 · 实验"));
check("面板有「面板常开时进一步合并 · 实验」行",
  !!findRow(panelRootV34, "面板常开时进一步合并 · 实验"));
// 暂停观测时 CV 属性必须移除（want 条件含 observe），恢复后补回
writeSettings({ turnContentVisOn: true });
check("v0.3.4 尾段前置：CV 属性在", docEl.getAttribute("data-lagfix-cv") === "1",
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
writeSettings({ observe: false });
check("暂停观测时 CV 属性移除", docEl.getAttribute("data-lagfix-cv") === null,
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
check("暂停样本 laf=null 但 pace 照实上报",
  collect().laf === null && collect().pace !== undefined,
  `laf=${JSON.stringify(collect().laf)}`);
writeSettings({ observe: true, turnContentVisOn: false });
check("恢复观测且开关已关：属性不回来", docEl.getAttribute("data-lagfix-cv") === null,
  `attr=${docEl.getAttribute("data-lagfix-cv")}`);
// P2-4（终审）：__lagfixOff 会摘掉 pagehide/beforeunload 但不会让 observer 死掉。
// 之后只重新打开「观测」（不碰滚动/输入/归因开关）时，卸载清理必须挂回来。
window.__lagfixOff();
check("P2-4 前置：__lagfixOff 后卸载监听已移除",
  (window._listeners.pagehide || []).length === 0);
// A6：__lagfixOff() 必须清空切换环与全天 pace 累计。
check("__lagfixOff 清空切换环", window.__lagfixDiag().switchDiag.records === 0,
  `records=${window.__lagfixDiag().switchDiag.records}`);
check("__lagfixOff 后样本 switch 为 null", collect().switch === null);
check("__lagfixOff 后样本 pace 为 null（实验开关一并关）", collect().pace === null);
// 重开实验开关验证全天累计确实清零（否则只是字段被隐藏）
writeSettings({ loadOlderPaceOn: true });
const paceOff = collect().pace;
check("__lagfixOff 清零 pace 全天累计",
  !!paceOff && paceOff.totalAllowed === 0 && paceOff.totalSkipped === 0,
  JSON.stringify(paceOff));
writeSettings({ loadOlderPaceOn: false });
writeSettings({ observe: false });
writeSettings({ observe: true });          // 只走 setObserving 路径
check("只重开观测时 pagehide 监听挂回来（P2-4）",
  (window._listeners.pagehide || []).length === 1,
  `pagehide=${(window._listeners.pagehide || []).length}`);

console.log("-- v0.4.2 帧窗口与最大值 --");
const v42RealNow = Date.now;
let v42Now = v42RealNow() + 3600000;
Date.now = () => v42Now;
const v42Base = v42Now;
// 先注入一条 39 秒前的 816ms 历史尖峰，再注入 2500 帧近期帧，
// 然后注入一条 10 秒前的 300ms 尖峰和 625 帧近期帧。
// 旧 RING_MAX=300 会把 10 秒前的尖峰挤掉；新环保留，窗口最大值为 300，
// 历史最大值为 816。
driveFrame(v42Base - 40016);          // 建基线，跨 1 小时的旧间隔被忽略
driveFrame(v42Base - 39200);          // 816ms，窗口外
let v42T = v42Base - 50300;
for (let i = 0; i < 2500; i++) { driveFrame(v42T); v42T += 16; }
driveFrame(v42Base - 10300);
driveFrame(v42Base - 10000);          // 300ms，10 秒前
for (let i = 0; i < 625; i++) driveFrame(v42Base - 9984 + i * 16);
const v42Diag = window.__lagfixDiag();
const v42Sample = JSON.parse(window.__lagfixCollect());
check("v0.4.2 frameRing 保留超过 300 帧（30s 窗口）",
  v42Diag.frameSamples > 3000,
  `frameSamples=${v42Diag.frameSamples}`);
check("v0.4.2 窗口最大值只看最近 30 秒",
  v42Sample.frameMaxWindow === 300,
  `window=${v42Sample.frameMaxWindow}`);
check("v0.4.2 历史最大值保留窗口外尖峰",
  v42Sample.frameMaxAll === 816 && v42Sample.frameMax === 816,
  `all=${v42Sample.frameMaxAll} legacy=${v42Sample.frameMax}`);
check("v0.4.2 frameMaxWindow 与 frameMaxAll 不等",
  v42Sample.frameMaxWindow !== v42Sample.frameMaxAll,
  `window=${v42Sample.frameMaxWindow} all=${v42Sample.frameMaxAll}`);
Date.now = v42RealNow;

console.log("-- v0.4.2 包装器身份校验 --");
// 前面最后一次 __lagfixOff 已把包装还原，这里等看门狗重新拿到 store 再测。
writeSettings({ throttleOn: true, bigSessionOn: true });
await wait(5200);
const v42Target = s3.proto;
const v42SubRec = v42Target.__lagfixThrottle;
const v42LoadRec = v42Target.__lagfixLoadAll;
check("v0.4.2 前置：subscribe/loadAll 都装上了",
  !!v42SubRec && typeof v42SubRec.wrapped === "function"
    && !!v42LoadRec && typeof v42LoadRec.wrapped === "function",
  `sub=${!!v42SubRec} load=${!!v42LoadRec}`);
const v42HostSub = function hostNewSubscribe(l) {
  this._listeners.add(l);
  return () => { this._listeners.delete(l); };
};
const v42HostLoad = function hostNewLoadAll() {
  this.loadAllCalls = (this.loadAllCalls || 0) + 1;
  return Promise.resolve({ status: "host-new" });
};
v42Target.subscribe = v42HostSub;
v42Target.loadAllOlder = v42HostLoad;
await wait(5200);   // 等看门狗（5s）重新核对目标
check("v0.4.2 宿主替换 subscribe 后重新包装宿主实现",
  v42Target.subscribe !== v42HostSub
    && v42Target.__lagfixThrottle
    && v42Target.__lagfixThrottle.orig === v42HostSub
    && v42Target.__lagfixThrottle.wrapped === v42Target.subscribe,
  `sameHost=${v42Target.subscribe === v42HostSub}`);
check("v0.4.2 宿主替换 loadAllOlder 后重新包装宿主实现",
  v42Target.loadAllOlder !== v42HostLoad
    && v42Target.__lagfixLoadAll
    && v42Target.__lagfixLoadAll.orig === v42HostLoad
    && v42Target.__lagfixLoadAll.wrapped === v42Target.loadAllOlder,
  `sameHost=${v42Target.loadAllOlder === v42HostLoad}`);
writeSettings({ throttleOn: false, bigSessionOn: false });
check("v0.4.2 关闭后只还原自己那层，subscribe 宿主实现保留",
  v42Target.subscribe === v42HostSub && !v42Target.__lagfixThrottle,
  `same=${v42Target.subscribe === v42HostSub} marker=${!!v42Target.__lagfixThrottle}`);
check("v0.4.2 关闭后只还原自己那层，loadAllOlder 宿主实现保留",
  v42Target.loadAllOlder === v42HostLoad && !v42Target.__lagfixLoadAll,
  `same=${v42Target.loadAllOlder === v42HostLoad} marker=${!!v42Target.__lagfixLoadAll}`);

console.log("== 结果：", failures === 0 ? "PASS" : `FAIL(${failures})`, "==");
process.exit(failures === 0 ? 0 : 1);
