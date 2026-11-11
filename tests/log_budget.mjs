// 主进程日志预算回归测试：用 vm + 假 fs 加载真实的 lagfix-main.cjs，
// 验证「超过上限自动删最旧」「不删今天活动文件」「非白名单文件不碰」
// 「14 天过期清理」「无权限时跳过继续删」「删除失败日志去重」。
// 不写磁盘、不需要 Electron。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readFile from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { EventEmitter } = require("events");
const vm = require("node:vm");

const SRC = path.resolve(__dirname, "../plugins/zcode-lagfix/lagfix-main.cjs");
const source = readFile.readFileSync(SRC, "utf8");

const MB = 1024 * 1024;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail === undefined ? "" : detail}`); }
}

function todayName() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `observe-${d.getFullYear()}${mm}${dd}.jsonl`;
}

// files: [{name, mb, ageMs, symlink?, dir?}]；deny: 删除会抛错的文件名集合
function createInstance(files, deny) {
  const map = new Map();
  for (const f of files) {
    map.set(f.name, {
      size: Math.round(f.mb * MB),
      mtimeMs: Date.now() - (f.ageMs || 0),
      symlink: !!f.symlink,
      dir: !!f.dir,
    });
  }
  const unlinked = [];
  const renamed = [];
  const logs = [];
  const appended = [];
  const settingsWrites = [];
  let pumpCb = null;

  const base = (p) => path.basename(String(p));
  const fsStub = {
    mkdirSync() {},
    readdirSync() { return Array.from(map.keys()); },
    statSync(p) {
      const f = map.get(base(p));
      if (!f) throw new Error("ENOENT " + p);
      return { size: f.size, mtimeMs: f.mtimeMs, isFile: () => !f.dir };
    },
    // 清理逻辑用 lstat + isFile/isSymbolicLink 做最后一道闸：符号链接、目录必须跳过。
    lstatSync(p) {
      const f = map.get(base(p));
      if (!f) throw new Error("ENOENT " + p);
      return {
        size: f.size,
        mtimeMs: f.mtimeMs,
        isFile: () => !f.dir && !f.symlink,
        isSymbolicLink: () => !!f.symlink,
      };
    },
    readFileSync() { throw new Error("not needed"); },
    renameSync(from, to) {
      const a = base(from), b = base(to);
      const f = map.get(a);
      if (!f) throw new Error("ENOENT " + from);
      map.delete(a);
      map.set(b, f);
      renamed.push([a, b]);
    },
    unlinkSync(p) {
      const n = base(p);
      if (deny && deny.has(n)) throw new Error("EPERM " + p);
      if (!map.delete(n)) throw new Error("ENOENT " + p);
      unlinked.push(n);
    },
    writeFileSync(p, text) { settingsWrites.push([base(p), String(text)]); },
    promises: {
      appendFile(p, text) {
        const n = base(p);
        appended.push([n, String(text)]);
        // 真实 appendFile 在文件不存在时会创建它；轮转测试依赖这一点。
        const f = map.get(n);
        if (f) f.size += String(text).length;
        else map.set(n, { size: String(text).length, mtimeMs: Date.now() });
        return Promise.resolve();
      },
      stat(p) {
        const f = map.get(base(p));
        return f ? Promise.resolve({ size: f.size }) : Promise.reject(new Error("ENOENT"));
      },
      rename(from, to) { fsStub.renameSync(from, to); return Promise.resolve(); },
    },
  };

  const httpsStub = { get() { throw new Error("本测试不应联网"); } };
  const wc = {
    id: 3,
    isDestroyed: () => false,
    getType: () => "window",
    executeJavaScript(code) {
      if (code.includes("__lagfixCollect")) {
        return Promise.resolve(JSON.stringify(instance.payload));
      }
      return Promise.resolve();
    },
  };
  const electronStub = {
    app: { on() {}, relaunch() {}, quit() {} },
    BrowserWindow: { getAllWindows: () => [{ webContents: wc }] },
    webContents: { getAllWebContents: () => [] },
  };

  const ctx = {
    require(name) {
      if (name === "fs") return fsStub;
      if (name === "path") return path;
      if (name === "https") return httpsStub;
      if (name === "electron") return electronStub;
      throw new Error("unexpected require " + name);
    },
    __dirname: "C:/temp/fake-lagfix-runtime",
    console: { error: (...a) => logs.push(a.join(" ")), log() {}, warn() {} },
    setInterval(fn) { pumpCb = fn; return { unref() {} }; },
    clearInterval() {},
    setTimeout() { return { unref() {} }; },
    clearTimeout() {},
    Buffer,
    URL,
    globalThis: null,
  };
  ctx.globalThis = ctx;

  vm.runInNewContext(source, ctx, { filename: SRC });
  if (!pumpCb) throw new Error("pump 未注册");

  const instance = {
    payload: { ver: "0.3.1", settings: { collectSec: 5 }, fix: {} },
    // 跑一个采集周期（同步触发 sweep，返回的 promise 由主进程异步写日志）
    collect(settings) {
      if (settings) instance.payload = Object.assign({}, instance.payload, { settings });
      pumpCb();
    },
    files: map,
    unlinked, renamed, logs, appended, settingsWrites,
    totalBytes() {
      let t = 0;
      for (const [, f] of map) t += f.size;
      return t;
    },
  };
  return instance;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const recent = 60 * 1000;              // 1 分钟前
const old = 3 * 86400000;              // 3 天前

(async () => {
  console.log("-- 超过预算：先删最旧，保留今天活动文件 --");
  {
    const today = todayName();
    const inst = createInstance([
      { name: "observe-20261101.jsonl", mb: 30, ageMs: old },
      { name: "observe-20261001.jsonl.1", mb: 25, ageMs: old - 1000 },
      { name: "main.log", mb: 10, ageMs: recent },
      { name: today, mb: 5, ageMs: 1000 },
      { name: "notes.txt", mb: 100, ageMs: old },   // 非白名单，永不动
    ]);
    inst.collect({ collectSec: 5, logMaxMB: 20 });
    await wait(20);
    check("预算 20MB：删掉最旧的两个（30MB + 25MB 归档）",
      inst.unlinked.length === 2
      && inst.unlinked[0] === "observe-20261101.jsonl"
      && inst.unlinked[1] === "observe-20261001.jsonl.1",
      JSON.stringify(inst.unlinked));
    check("今天正在写的 observe 文件保留", inst.files.has(today));
    check("删除后白名单总量 <= 上限", (() => {
      let t = 0;
      for (const [n, f] of inst.files) if (n.startsWith("observe-") || /\.log/.test(n)) t += f.size;
      return t <= 20 * MB;
    })(), `${(inst.totalBytes() / MB).toFixed(1)}MB`);
    check("非白名单文件从不删除", inst.files.has("notes.txt"));
    check("删除动作写了日志", inst.logs.some((l) => /日志超预算（20MB）/.test(l)),
      inst.logs.join(" | "));
  }

  console.log("-- 未超预算：一个都不删 --");
  {
    const inst = createInstance([
      { name: "observe-20261101.jsonl", mb: 10, ageMs: old },
      { name: "main.log", mb: 8, ageMs: recent },
    ]);
    inst.collect({ collectSec: 5, logMaxMB: 50 });
    await wait(20);
    check("20MB/50MB 以内不删除", inst.unlinked.length === 0, JSON.stringify(inst.unlinked));
  }

  console.log("-- 今天活动文件过大：只删旧的，不删活动文件 --");
  {
    const today = todayName();
    const inst = createInstance([
      { name: today, mb: 60, ageMs: 1000 },
      { name: "observe-20261101.jsonl", mb: 1, ageMs: old },
    ]);
    inst.collect({ collectSec: 5, logMaxMB: 20 });
    await wait(20);
    check("活动 observe 文件永远不进删除列表",
      !inst.unlinked.includes(today) && inst.files.has(today),
      `unlinked=${JSON.stringify(inst.unlinked)} hasToday=${inst.files.has(today)}`);
    // 活动文件超过 5MB 会轮转为 .1；轮转后由下一轮预算清理。
    const rotated = today + ".1";
    check("超大活动文件先轮转为 .1", inst.files.has(rotated),
      JSON.stringify(Array.from(inst.files.keys())));
    inst.collect({ collectSec: 5, logMaxMB: 21 });
    await wait(20);
    check("下一轮预算删掉 .1 归档，今天的文件仍在",
      !inst.files.has(rotated) && inst.files.has(today),
      `unlinked=${JSON.stringify(inst.unlinked)}`);
  }

  console.log("-- 14 天过期：启动时清理（即使没超预算）--");
  {
    const inst = createInstance([
      { name: "observe-20260101.jsonl", mb: 1, ageMs: 20 * 86400000 },
      { name: "observe-20261110.jsonl", mb: 1, ageMs: 2 * 86400000 },
    ]);
    await wait(20);   // start() 里的 sweepOldLogs(14)
    check("20 天前的 observe 被清理，2 天前保留",
      !inst.files.has("observe-20260101.jsonl") && inst.files.has("observe-20261110.jsonl"),
      JSON.stringify(Array.from(inst.files.keys())));
  }

  console.log("-- 删除失败（权限/占用）：跳过并继续删其它 --");
  {
    const deny = new Set(["elevated-finalize.log.1"]);
    const inst = createInstance([
      { name: "elevated-finalize.log.1", mb: 10, ageMs: old },
      { name: "observe-20261101.jsonl", mb: 8, ageMs: old - 1000 },
    ], deny);
    inst.collect({ collectSec: 5, logMaxMB: 5 });
    await wait(20);
    check("权限不足的文件没删掉", inst.files.has("elevated-finalize.log.1"));
    check("跳过后仍继续删其它文件", inst.unlinked.includes("observe-20261101.jsonl"),
      JSON.stringify(inst.unlinked));
    check("记录了一次无法删除的日志",
      inst.logs.filter((l) => /无法删除日志/.test(l)).length === 1,
      inst.logs.join(" | "));

    // 再触发一次：同一文件仍删不掉，不应重复刷同一条日志
    inst.collect({ collectSec: 5, logMaxMB: 6 });
    await wait(20);
    check("同一个删不掉的文件不重复刷日志",
      inst.logs.filter((l) => /无法删除日志/.test(l)).length === 1,
      inst.logs.join(" | "));
  }

  console.log("-- 不可删文件本身大于预算：后面的可删文件仍要删 --");
  {
    const inst = createInstance([
      { name: "elevated-finalize.log.1", mb: 10, ageMs: old },
      { name: "observe-20261101.jsonl", mb: 1, ageMs: old - 1000 },
    ], new Set(["elevated-finalize.log.1"]));
    inst.collect({ collectSec: 5, logMaxMB: 5 });
    await wait(20);
    check("不可删文件大于预算时仍继续删后面的小文件",
      inst.unlinked.includes("observe-20261101.jsonl"),
      JSON.stringify(inst.unlinked));
    check("剩余量按磁盘真实占用记录（10MB，不是 1MB）",
      inst.logs.some((l) => /剩余 10MB/.test(l)), inst.logs.join(" | "));
  }

  console.log("-- 清理安全闸：只删本插件自己的普通文件 --");
  {
    const today = todayName();
    const inst = createInstance([
      { name: "observe-20200101.jsonl", mb: 5, ageMs: old, symlink: true },
      { name: "observe-20200102.jsonl", mb: 5, ageMs: old, dir: true },
      { name: "main.log", mb: 30, ageMs: old },          // 活动日志，受保护
      { name: "observe-20200103.jsonl", mb: 30, ageMs: old },
      { name: "user-data.txt", mb: 100, ageMs: old },    // 非本插件文件
      { name: "settings.json", mb: 100, ageMs: old },    // 设置文件
      { name: today, mb: 5, ageMs: 1000 },               // 今天活动 observe
    ]);
    inst.collect({ collectSec: 5, logMaxMB: 5 });
    await wait(20);
    check("符号链接不删", inst.files.has("observe-20200101.jsonl"));
    check("目录不删", inst.files.has("observe-20200102.jsonl"));
    check("活动 main.log 不删", inst.files.has("main.log"));
    check("今天活动 observe 不删", inst.files.has(today));
    check("白名单里的旧 observe 才删", !inst.files.has("observe-20200103.jsonl"));
    check("用户文件 / 设置文件不动",
      inst.files.has("user-data.txt") && inst.files.has("settings.json"));
    check("只删白名单旧文件（旧 observe / 轮转归档），不误删其它",
      inst.unlinked.includes("observe-20200103.jsonl")
      && inst.unlinked.every((n) => n === "observe-20200103.jsonl" || n === "main.log.1")
      && !inst.unlinked.includes("main.log")
      && inst.files.has(today)
      && inst.files.has("user-data.txt") && inst.files.has("settings.json"),
      JSON.stringify(inst.unlinked));
  }

  console.log("-- 默认预算 50MB --");
  {
    const inst = createInstance([
      { name: "observe-20261001.jsonl", mb: 30, ageMs: old },
      { name: "observe-20261002.jsonl", mb: 30, ageMs: old - 1000 },
    ]);
    inst.collect({ collectSec: 5 });   // 不带 logMaxMB → 默认 50
    await wait(20);
    check("默认 50MB：60MB 只删到 <=50MB（删最旧 30MB）",
      inst.unlinked.length === 1 && inst.unlinked[0] === "observe-20261001.jsonl",
      JSON.stringify(inst.unlinked));
  }

  console.log(`== 结果： ${fail ? "FAIL(" + fail + ")" : "PASS"} (${pass} passed) ==`);
  process.exit(fail ? 1 : 0);
})();
