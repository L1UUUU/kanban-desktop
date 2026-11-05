// 用途：受限网络下的本地 npm registry 代理 —— 元数据经 unpkg.com 逐版本解析（支持 semver range），tarball 从 cdn.npmmirror.com 回填本地缓存并计算 integrity，供 pnpm --registry 安装使用（端点与环境均可用环境变量覆盖；解析结果持久化到缓存目录，重启免重放）
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// 配置：端口 / 元数据源 / tarball CDN / 缓存目录 / 预热根（name@range 逗号分隔）
const PORT = Number(process.env.PORT || 4781);
const UNPKG_BASE = process.env.UNPKG_BASE || "https://unpkg.com";
const TARBALL_CDN = process.env.TARBALL_CDN || "https://cdn.npmmirror.com/packages";
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, ".registry-cache");
const ROOT_SPECS = (process.env.ROOTS || "electron-builder@latest")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 工作区 lockfile：其中的 name@version 全部作为种子解析（保证 pnpm 对既有依赖的 range 都能命中已锁版本）
const LOCKFILE = process.env.LOCKFILE || path.join(__dirname, "..", "..", "..", "pnpm-lock.yaml");

// name -> Map<version, manifest>；manifest 为 unpkg 返回的已发布 package.json
const docs = new Map();
// `${name}@${range}` -> version（unpkg 的 range 解析结论，持久化避免重复请求）
const rangeIndex = new Map();
// name -> Promise（按名互斥，避免并发请求竞态）
const nameLocks = new Map();
const walkedKeys = new Set();

const META_DIR = path.join(CACHE_DIR, "_meta");
const RANGE_FILE = path.join(META_DIR, "ranges.json");

// 简单并发闸：外部请求（unpkg/cdn）最多 4 并发，重试含退避（容忍 429/瞬时 5xx）
let activeFetches = 0;
const fetchQueue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    fetchQueue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (activeFetches < 4 && fetchQueue.length) {
    const job = fetchQueue.shift();
    activeFetches++;
    job.fn().then(job.resolve, job.reject).finally(() => {
      activeFetches--;
      pump();
    });
  }
}

async function fetchWithRetry(url, { asJson = false, tries = 5 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await withSlot(() => fetch(url, { headers: { "user-agent": "kb-registry-fallback/1.0" }, redirect: "follow" }));
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} (retryable) for ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (asJson) return await res.json();
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function loadPersisted() {
  try {
    const ranges = JSON.parse(fs.readFileSync(RANGE_FILE, "utf8"));
    for (const [k, v] of Object.entries(ranges)) rangeIndex.set(k, v);
  } catch {}
  let count = 0;
  try {
    for (const file of fs.readdirSync(META_DIR)) {
      if (!file.endsWith(".json") || file === "ranges.json") continue;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));
        const name = doc.name;
        if (!docs.has(name)) docs.set(name, new Map());
        for (const [v, manifest] of Object.entries(doc.versions)) docs.get(name).set(v, manifest);
        count++;
      } catch {}
    }
  } catch {}
  console.log(`加载持久化元数据：${count} 个包，${rangeIndex.size} 条 range 映射`);
}

function persistManifest(manifest) {
  // 每包一个 JSON 文件，整包重写（量小，简单可靠）
  const file = path.join(META_DIR, manifest.name.replace(/\//g, "_") + ".json");
  const versions = {};
  for (const [v, m] of docs.get(manifest.name)) versions[v] = m;
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: manifest.name, versions }));
}
function persistRanges() {
  fs.mkdirSync(META_DIR, { recursive: true });
  const obj = {};
  for (const [k, v] of rangeIndex) obj[k] = v;
  fs.writeFileSync(RANGE_FILE, JSON.stringify(obj, null, 0));
}

async function resolveManifest(name, range) {
  const key = `${name}@${range}`;
  const cachedV = rangeIndex.get(key);
  if (cachedV && docs.get(name)?.has(cachedV)) return docs.get(name).get(cachedV);
  const manifest = await fetchWithRetry(`${UNPKG_BASE}/${name}@${range}/package.json`, { asJson: true });
  if (!manifest.name || !manifest.version) throw new Error(`unpkg 返回异常 manifest: ${key}`);
  rangeIndex.set(key, manifest.version);
  persistRanges();
  return manifest;
}

function tarballPath(name, version) {
  return path.join(CACHE_DIR, name.replace(/\//g, "_"), `${version}.tgz`);
}
function tarballCandidates(name, version) {
  // npmmirror CDN 的目录保留 scope、文件名去掉 scope；两种命名都尝试
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return [
    `${TARBALL_CDN}/${name}/${version}/${base}-${version}.tgz`,
    `${TARBALL_CDN}/${name}/${version}/${name}-${version}.tgz`,
  ];
}
async function ensureTarball(name, version) {
  const file = tarballPath(name, version);
  if (fs.existsSync(file)) return file;
  for (const url of tarballCandidates(name, version)) {
    try {
      const buffer = await fetchWithRetry(url);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buffer);
      return file;
    } catch {
      /* 尝试下一个候选 URL */
    }
  }
  throw new Error(`tarball 不可得: ${name}@${version}`);
}

// BFS 遍历依赖闭包：dependencies + optionalDependencies + 非可选 peerDependencies；bundled 依赖随 tarball 分发不再解析
async function walk(name, range) {
  const key = `${name}@${range}`;
  if (walkedKeys.has(key)) return;
  walkedKeys.add(key);
  const manifest = await resolveManifest(name, range);
  if (!docs.has(manifest.name)) docs.set(manifest.name, new Map());
  if (!docs.get(manifest.name).has(manifest.version)) {
    docs.get(manifest.name).set(manifest.version, manifest);
    persistManifest(manifest);
    console.log(`[walk] ${manifest.name}@${manifest.version} (range ${range})`);
  }

  const bundled = new Set([...(manifest.bundleDependencies || []), ...(manifest.bundledDependencies || [])]);
  const peerOptional = new Set(
    Object.entries(manifest.peerDependenciesMeta || {})
      .filter(([, m]) => m && m.optional)
      .map(([n]) => n),
  );
  const next = [];
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [depName, depRange] of Object.entries(manifest[section] || {})) {
      if (bundled.has(depName)) continue;
      if (section === "peerDependencies" && peerOptional.has(depName)) continue;
      next.push([depName, depRange]);
    }
  }
  await Promise.all(
    next.map(([n, r]) =>
      walk(n, r).catch((e) => console.error(`  ! skip ${n}@${r}: ${e.message}`)),
    ),
  );
}

async function withNameLock(name, fn) {
  const prev = nameLocks.get(name) || Promise.resolve();
  const job = prev.then(fn, fn);
  nameLocks.set(name, job.finally(() => {
    if (nameLocks.get(name) === job) nameLocks.delete(name);
  }));
  return job;
}

// 按需保证：该包当前已记录的全部版本 tarball 在本地，缺失的剔除出 doc
async function ensurePackageReady(name) {
  await ensureTarball(name, docs.get(name).keys().next().value).catch(() => {});
  for (const version of docs.get(name).keys()) {
    try {
      await ensureTarball(name, version);
    } catch (e) {
      console.error(`  ! 剔除缺 tarball 的版本: ${e.message}`);
      docs.get(name).delete(version);
    }
  }
}

// 从 pnpm-lock.yaml 的 packages: 段提取 name@version 种子（YAML 子集手解析，只认两缩进的键行）
function lockfilePairs() {
  try {
    const lines = fs.readFileSync(LOCKFILE, "utf8").split(/\r?\n/);
    const pairs = [];
    let inPackages = false;
    for (const line of lines) {
      if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
      if (!inPackages || /^ {4}/.test(line)) continue; // 只认 packages: 段的两缩进键行
      const m = line.match(/^  '?((?:@[^/]+\/)?[^']+)'?:$/);
      if (!m) continue;
      const key = m[1];
      const at = key.lastIndexOf("@");
      if (at <= 0) continue;
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      if (name && version && !version.includes(":")) pairs.push([name, version]);
    }
    return pairs;
  } catch {
    return [];
  }
}

async function prewarm() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const seeds = lockfilePairs();
  console.log(`lockfile 种子：${seeds.length} 个 name@version`);
  await Promise.all(
    seeds.map(([n, v]) =>
      walk(n, v).catch((e) => console.error(`  ! seed skip ${n}@${v}: ${e.message}`)),
    ),
  );
  for (const spec of ROOT_SPECS) {
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const range = spec.slice(at + 1);
    await walk(name, range);
  }
  const pkgs = [...docs.keys()];
  for (const name of pkgs) await withNameLock(name, () => ensurePackageReady(name));
  console.log(`prewarm 完成：${docs.size} 个包元数据就绪`);
}

function metadataDoc(name) {
  const versions = docs.get(name);
  if (!versions || versions.size === 0) return null;
  const out = { name, versions: {}, "dist-tags": { latest: "" } };
  let latest = "0.0.0";
  for (const [version, manifest] of versions) {
    const file = tarballPath(name, version);
    if (!fs.existsSync(file)) continue;
    out.versions[version] = {
      ...manifest,
      dist: {
        tarball: `http://127.0.0.1:${PORT}/tarball/${name}/${version}`,
        integrity: "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64"),
      },
    };
    if (/^\d+\.\d+\.\d+$/.test(version) && version > latest) latest = version;
  }
  if (Object.keys(out.versions).length === 0) return null;
  out["dist-tags"].latest = latest;
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith("/tarball/")) {
      // 路径形如 /tarball/<name 可含斜杠>/<version>：最后一段为 version，其余拼回 name
      const parts = url.pathname.split("/").filter(Boolean).slice(1);
      const version = parts.pop() || "";
      const name = decodeURIComponent(parts.join("/"));
      const file = tarballPath(name, version);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end("no tarball");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!name || name.startsWith("-")) {
      res.writeHead(404).end();
      return;
    }
    // 按名互斥：未记录的包先按 latest 拉取闭包；已记录的包补齐 tarball 后出 doc
    const doc = await withNameLock(name, async () => {
      if (!docs.has(name)) {
        await walk(name, "latest").catch((e) => console.error(`  ! walk(${name}@latest) 失败: ${e.message}`));
      }
      if (!docs.has(name)) return null;
      await ensurePackageReady(name);
      return metadataDoc(name);
    });
    if (!doc) {
      res.writeHead(404).end(`{"error":"not found: ${name}"}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(doc));
  } catch (e) {
    console.error(`  ! handler 500: ${req.url}: ${e && e.message}`);
    res.writeHead(500).end(String((e && e.message) || "error"));
  }
});

loadPersisted();
prewarm()
  .then(() => new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve)))
  .then(() => console.log(`registry fallback proxy 就绪: http://127.0.0.1:${PORT} (缓存 ${CACHE_DIR})`))
  .catch((e) => {
    console.error("prewarm 失败:", e);
    process.exit(1);
  });
