// 主进程「检查更新」回归测试：用 vm + 假模块加载真实的 lagfix-main.cjs，
// 验证 URL 白名单、重定向、draft/prerelease 过滤、语义化版本比较、
// 响应体上限与结果注入。不联网、不写磁盘、不需要 Electron。
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

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail === undefined ? "" : detail}`); }
}

function runOnce(plans, payloadObj) {
  const requests = [];
  const injected = [];
  const logs = [];
  let pumpCb = null;

  const httpsStub = {
    get(opts, cb) {
      requests.push(opts);
      const req = new EventEmitter();
      req.destroy = () => {};
      req.setTimeout = (ms, fn) => { req._timeoutMs = ms; };
      const plan = plans.shift();
      const res = new EventEmitter();
      res.resume = () => {};
      if (!plan) {
        process.nextTick(() => req.emit("error", new Error("no scripted response")));
        return req;
      }
      res.statusCode = plan.status || 200;
      res.headers = plan.headers || {};
      process.nextTick(() => {
        cb(res);
        if (plan.error) { req.emit("error", new Error(plan.error)); return; }
        if (plan.body !== undefined) {
          const buf = Buffer.from(plan.body);
          // 分两块发，覆盖累积逻辑
          const half = Math.ceil(buf.length / 2);
          if (half > 0 && buf.length > 1) {
            res.emit("data", buf.subarray(0, half));
            res.emit("data", buf.subarray(half));
          } else {
            res.emit("data", buf);
          }
          res.emit("end");
        }
      });
      return req;
    },
  };

  const fsStub = {
    mkdirSync() {},
    statSync() { return { size: 0, mtimeMs: 0 }; },
    readFileSync() { throw new Error("not needed"); },
    readdirSync() { return []; },
    renameSync() {},
    unlinkSync() {},
    writeFileSync() {},
    promises: {
      appendFile: () => Promise.resolve(),
      stat: () => Promise.reject(new Error("missing")),
      rename: () => Promise.resolve(),
    },
  };

  const wc = {
    id: 7,
    isDestroyed: () => false,
    getType: () => "window",
    executeJavaScript(code) {
      if (code.includes("__lagfixCollect")) {
        return Promise.resolve(JSON.stringify(payloadObj));
      }
      injected.push(code);
      return Promise.resolve();
    },
  };
  const win = { webContents: wc };

  const electronStub = {
    app: { on() {}, relaunch() {}, quit() {} },
    BrowserWindow: { getAllWindows: () => [win] },
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
  pumpCb();
  return new Promise((resolve) => {
    setTimeout(() => {
      let info = null;
      const code = injected.find((c) => c.includes("__lagfixUpdate"));
      if (code) {
        const json = code.replace(/^window\.__lagfixUpdate=/, "").replace(/;\s*$/, "");
        try { info = JSON.parse(json); } catch (e) { info = { parseError: e.message }; }
      }
      resolve({ info, requests, logs, injected });
    }, 60);
  });
}

function releases(list) {
  return { status: 200, body: JSON.stringify(list) };
}
function rel(tag, extra) {
  return Object.assign({ tag_name: tag, draft: false, prerelease: false,
    html_url: "https://github.com/ck-ys/zcode-lagfix/releases/tag/" + tag }, extra || {});
}
const base = (over) => Object.assign({ ver: "0.3.1", updateCheck: 1,
  settings: { collectSec: 5 }, fix: {} }, over || {});

(async () => {
  console.log("-- 发现新版本 --");
  {
    const r = await runOnce([releases([rel("v0.3.2"), rel("v0.3.0")])], base());
    check("请求打到 GitHub Releases", r.requests.length === 1
      && r.requests[0].hostname === "api.github.com"
      && /\/repos\/ck-ys\/zcode-lagfix\/releases$/.test(r.requests[0].path),
      JSON.stringify(r.requests[0]));
    check("带 Accept / API 版本 / UA，且没有 Authorization",
      r.requests[0].headers.Accept === "application/vnd.github+json"
      && r.requests[0].headers["X-GitHub-Api-Version"] === "2022-11-28"
      && !!r.requests[0].headers["User-Agent"]
      && !Object.keys(r.requests[0].headers).some((k) => /auth/i.test(k)),
      JSON.stringify(r.requests[0].headers));
    check("返回 ok + newer=true + latest=0.3.2",
      r.info && r.info.status === "ok" && r.info.newer === true
      && r.info.latest === "0.3.2" && r.info.current === "0.3.1",
      JSON.stringify(r.info));
    check("url 用 release 的 html_url", r.info && /\/tag\/v0\.3\.2$/.test(r.info.url), r.info && r.info.url);
  }

  console.log("-- 已是最新（按数值比较，不是字符串）--");
  {
    const r = await runOnce([releases([rel("v0.3.9")])], base({ ver: "0.3.10" }));
    check("0.3.10 比 0.3.9 新：newer=false", r.info && r.info.status === "ok"
      && r.info.newer === false && r.info.latest === "0.3.9", JSON.stringify(r.info));
  }
  {
    const r = await runOnce([releases([rel("v0.3.10")])], base({ ver: "0.3.9" }));
    check("0.3.9 比 0.3.10 旧：newer=true", r.info && r.info.newer === true, JSON.stringify(r.info));
  }

  console.log("-- 过滤 draft / prerelease --");
  {
    const r = await runOnce([releases([
      rel("v0.4.0", { draft: true }),
      rel("v0.3.9", { prerelease: true }),
      rel("v0.3.2"),
    ])], base());
    check("只看正式版：latest=0.3.2", r.info && r.info.latest === "0.3.2" && r.info.newer === true,
      JSON.stringify(r.info));
  }
  {
    const r = await runOnce([releases([rel("v0.4.0", { draft: true })])], base());
    check("全是 draft：明确报错而不是谎报已是最新",
      r.info && r.info.status === "error" && /还没有正式发布版本/.test(r.info.message),
      JSON.stringify(r.info));
  }
  {
    const r = await runOnce([releases([])], base());
    check("空 releases：报「还没有正式发布版本」",
      r.info && r.info.status === "error" && /还没有正式发布版本/.test(r.info.message),
      JSON.stringify(r.info));
  }

  console.log("-- 重定向白名单 --");
  {
    const r = await runOnce([
      { status: 301, headers: { location: "https://evil.example.com/steal" } },
    ], base());
    check("跳到非 api.github.com：拒绝且不再发请求",
      r.info && r.info.status === "error" && /拒绝非 GitHub API 地址/.test(r.info.message)
      && r.requests.length === 1, `${JSON.stringify(r.info)} req=${r.requests.length}`);
  }
  {
    const r = await runOnce([
      { status: 302, headers: { location: "https://api.github.com:8443/x" } },
    ], base());
    check("同主机但非 443 端口：拒绝",
      r.info && r.info.status === "error" && /拒绝非 GitHub API 地址/.test(r.info.message)
      && r.requests.length === 1, `${JSON.stringify(r.info)} req=${r.requests.length}`);
  }
  {
    const r = await runOnce([
      { status: 302, headers: { location: "https://api.github.com/repositories/1/releases" } },
      releases([rel("v0.3.2")]),
    ], base());
    check("同主机重定向：跟随后成功", r.info && r.info.status === "ok" && r.info.newer === true
      && r.requests.length === 2, `${JSON.stringify(r.info)} req=${r.requests.length}`);
  }
  {
    const r = await runOnce([
      { status: 302, headers: { location: "https://api.github.com/a" } },
      { status: 302, headers: { location: "https://api.github.com/b" } },
      { status: 302, headers: { location: "https://api.github.com/c" } },
    ], base());
    check("重定向超过 2 跳：报错", r.info && r.info.status === "error"
      && /重定向次数过多/.test(r.info.message), JSON.stringify(r.info));
  }

  console.log("-- 响应体上限与错误码 --");
  {
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    const r = await runOnce([{ status: 200, body: big }], base());
    check("超过 2MB：报错而不是继续读", r.info && r.info.status === "error"
      && /超过 2MB/.test(r.info.message), JSON.stringify(r.info));
  }
  {
    const r = await runOnce([{ status: 403, body: "{}" }], base());
    check("403：提示限流", r.info && r.info.status === "error"
      && /限流/.test(r.info.message), JSON.stringify(r.info));
  }
  {
    const r = await runOnce([{ status: 500, body: "oops" }], base());
    check("500：提示 HTTP 500", r.info && r.info.status === "error"
      && /HTTP 500/.test(r.info.message), JSON.stringify(r.info));
  }
  {
    const r = await runOnce([{ status: 200, body: "not json" }], base());
    check("非 JSON：报错", r.info && r.info.status === "error"
      && /不是有效 JSON/.test(r.info.message), JSON.stringify(r.info));
  }

  console.log("-- 不触发 --");
  {
    const r = await runOnce([], base({ updateCheck: 0 }));
    check("updateCheck=0 时不发请求", r.requests.length === 0
      && !r.injected.some((c) => c.includes("__lagfixUpdate")), `req=${r.requests.length}`);
  }
  {
    const r = await runOnce([], base({ dead: true }));
    check("dead 样本不触发更新检查", r.requests.length === 0, `req=${r.requests.length}`);
  }

  console.log(`== 结果： ${fail ? "FAIL(" + fail + ")" : "PASS"} (${pass} passed) ==`);
  process.exit(fail ? 1 : 0);
})();
