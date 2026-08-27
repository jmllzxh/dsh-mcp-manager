// @local/dsh-mcp-manager — 宿主半（host half）。
// 职责：在 Web 内置 HTTP 服务上挂 prefix 路由 /mcp-manager，
// 对 $DSH_HOME/cordis.patch.yml（默认 ~/.dsh/cordis.patch.yml）内的
// 受管 MCP 条目执行 CRUD。窄解析器只认本包自己生成的规范布局 +
// 用户手工注释；看不懂的单个条目段保持“不透明”原样保留，绝不破坏。
//
// 零依赖、Node ESM、手写实现。

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

export const inject = ["webServer"];

//#region 常量与工具
const ROUTE_PREFIX = "/mcp-manager";
const MAX_BODY_BYTES = 256 * 1024; // POST 体上限，超限断开
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// cordis.patch.yml 条目里固定写入的插件标识（任务书模板冻结值）。
const ENTRY_NAME = "@deepseek-ai/dsh-mcp-client";
// 全新文件整份生成时的头部横幅。
const BANNER_LINES = [
  "# $DSH_HOME/cordis.patch.yml — home-level user patch layer.",
  "# Managed MCP servers are appended here by @local/dsh-mcp-manager.",
];

const ID_RE = /^mcp-[a-z0-9-]+$/;
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAP_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const URL_RE = /^https?:\/\//;
const TRANSPORTS = ["stdio", "streamable-http"];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function filePath() {
  // 通过环境变量 DSH_HOME 判定优先：process.env.DSH_HOME || ~/.dsh
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "cordis.patch.yml");
}

/** 校验可落盘标量值（宁严勿损）。命中返回中文原因，否则 null。 */
function sanitizeValueError(name, v) {
  if (typeof v !== "string") return `${name} 必须是字符串`;
  if (v.length === 0) return `${name} 不能为空`;
  if (/[\x00-\x1f\x7f]/.test(v)) return `${name} 含控制字符`;
  if (v.includes("'") || v.includes('"')) return `${name} 不能包含引号字符`;
  if (v !== v.trim()) return `${name} 首尾不能有空白`;
  if (v.includes(": ")) return `${name} 不能包含 ": "`;
  for (const ch of "{}[],#") {
    if (v.includes(ch)) return `${name} 不能包含 "${ch}"`;
  }
  return null;
}

/** 序列化加引号：plain 标量首字符是 YAML 指示符/空白，或含歧义序列时用单引号包裹。 */
function yamlQuote(v) {
  if (v === "") return "''";
  if (/^[-?:,[\]{}#&*!|>'"%@`\t ]/.test(v) || v.includes(": ") || v.includes(" #")) {
    return "'" + v + "'"; // sanitize 已保证值内无单引号
  }
  return v;
}

/** 窄解析的 "k: v"；冒号后必须紧跟一个空格或行尾。返回 [key, rawRest] 或 null。 */
function splitKV(content) {
  const m = /^([^\s:#][^:]*?):(?: (.*))?$/.exec(content);
  if (!m) return null;
  return [m[1], m[2] === undefined ? "" : m[2]];
}
//#endregion

//#region 解析器（窄解析：规范布局 + 注释直通；不可理解结构 → unparsable）
/**
 * 把原始文本解析为文档节点序列：
 *   {t:"pas", s}            直通行（空白/注释等逐字保留）
 *   {t:"mark"}              顶格 "- insert:" 标记行
 *   {t:"seg", lines:[...]}  一个条目段（首行缩进 4 空格 "- "，续行缩进 ≥6）
 * 解析成功后每个段还会带 m（canonical 模型）或保持 null（不透明段）。
 * 行按原样保留（含可能的 \r），serialize 后逐字节还原。
 */
export function parseDocument(text) {
  const rawLines = String(text ?? "").split("\n");
  let tail = false;
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    tail = true;
    rawLines.pop();
  }
  const nodes = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      cur.m = tryParseSegment(cur.lines);
      nodes.push(cur);
      cur = null;
    }
  };
  for (const line of rawLines) {
    const an = line.replace(/\r$/, "");
    let indent = 0;
    while (indent < an.length && an[indent] === " ") indent += 1;
    const content = an.slice(indent);
    const isBlank = content === "";
    const isComment = !isBlank && content[0] === "#";

    if (indent === 4 && content.startsWith("- ") && content.length > 2) {
      flush();
      cur = { t: "seg", lines: [line], m: null };
      continue;
    }
    if (cur) {
      if (isBlank || isComment) {
        flush();
        nodes.push({ t: "pas", s: line });
        continue;
      }
      if (indent >= 6) {
        cur.lines.push(line);
        continue;
      }
      return {
        error: {
          code: "unparsable",
          message: `无法理解的缩进结构（第 ${nodes.length + 1} 行附近："${content.slice(0, 20)}"）`,
        },
        nodes,
        tail,
      };
    }
    // 段外
    if (isBlank || isComment) {
      nodes.push({ t: "pas", s: line });
      continue;
    }
    if (content === "- insert:") {
      nodes.push({ t: "mark", m: null });
      continue;
    }
    return {
      error: { code: "unparsable", message: "出现无法理解的顶层内容（仅支持注释、空行与顶格的 - insert: 块）" },
      nodes,
      tail,
    };
  }
  flush();
  return { error: null, nodes, tail };
}

/** 段内标量：剥单/双引号（不做转义折叠），plain 取剩余 trim。 */
function scalarVal(raw) {
  const v = raw.trim();
  if (v.length >= 2) {
    const c = v[0];
    if ((c === "'" || c === '"') && v[v.length - 1] === c) return v.slice(1, -1);
  }
  return v;
}

/**
 * 尝试把一个条目段解释成完整合法 MCP 模型。
 * 所有必填键齐全且形状匹配才返回 canonical 模型对象；
 * 否则返回 null（该段保持“不透明”，绝不出现在 servers 里也不报错）。
 */
function tryParseSegment(lines) {
  const first = lines[0].replace(/\r$/, "");
  const head = /^ {4}- (.*)$/.exec(first);
  if (!head) return null;
  const root = {};
  let cfg = null;
  let container = null; // { kind:"seq"|"map", target, keyIndent }

  // 首行 "- " 后的内联载荷必须是 id 键值（模板：    - id: mcp-x）。
  const headPayload = head[1];
  if (headPayload !== "") {
    const headKV = splitKV(headPayload);
    if (!headKV || headKV[0] !== "id") return null;
    root.id = scalarVal(headKV[1]);
  }

  for (let i = 1; i < lines.length; i += 1) {
    const an = lines[i].replace(/\r$/, "");
    if (an.trim() === "") return null;
    let indent = 0;
    while (indent < an.length && an[indent] === " ") indent += 1;
    const content = an.slice(indent);
    if (content[0] === "#") return null;

    if (container && indent > container.keyIndent) {
      if (container.kind === "seq") {
        const item = /^- (.*$)/.exec(content);
        if (!item) return null;
        container.target.push(scalarVal(item[1]));
        continue;
      }
      const kv = splitKV(content);
      if (!kv) return null;
      container.target[kv[0]] = scalarVal(kv[1]);
      continue;
    }
    if (container) container = null;

    const kv = splitKV(content);
    if (!kv) return null;
    const k = kv[0];
    const vInline = kv[1].trim();

    if (indent === 6) {
      if (cfg) return null; // config 之后又回到条目级键：形状异常
      if (k === "config") {
        if (vInline !== "" && vInline !== "{}") return null;
        cfg = {};
        root.config = cfg;
        continue;
      }
      if (k !== "id" && k !== "name") return null; // 条目级未知键 → 不透明
      root[k] = scalarVal(kv[1]);
      continue;
    }
    if (indent === 8) {
      if (!cfg) return null;
      if (
        k === "transport" ||
        k === "command" ||
        k === "url" ||
        k === "serverName"
      ) {
        cfg[k] = scalarVal(kv[1]);
        continue;
      }
      if (k === "disabled") {
        if (vInline !== "true" && vInline !== "false") return null;
        cfg.disabled = vInline === "true";
        continue;
      }
      if (k === "args") {
        if (vInline !== "" && vInline !== "[]") return null;
        container = { kind: "seq", target: [], keyIndent: 8 };
        cfg.args = container.target;
        continue;
      }
      if (k === "env" || k === "headers") {
        if (vInline !== "" && vInline !== "{}") return null;
        container = { kind: "map", target: {}, keyIndent: 8 };
        cfg[k] = container.target;
        continue;
      }
      return null; // config 下未知键 → 不透明
    }
    return null; // 其他缩进层级一律不支持
  }

  //#region 形状匹配校验：必填齐全且形状匹配才算数
  const str = (o, k) => (o && typeof o[k] === "string" ? o[k] : undefined);
  const id = str(root, "id");
  const nameV = str(root, "name");
  const serverName = str(cfg, "serverName");
  const transport = str(cfg, "transport");

  if (!id || !ID_RE.test(id)) return null;
  if (!nameV) return null; // name 键必须存在且非空
  if (!serverName || !SERVER_NAME_RE.test(serverName)) return null;
  if (TRANSPORTS.indexOf(transport) < 0) return null;

  let args = Array.isArray(cfg.args) ? cfg.args : undefined;
  const env =
    cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env) ? cfg.env : {};
  let headers =
    cfg.headers && typeof cfg.headers === "object" && !Array.isArray(cfg.headers)
      ? cfg.headers
      : {};

  if (transport === "stdio") {
    const command = str(cfg, "command");
    if (!command) return null; // stdio 必填非空
    if (str(cfg, "url") !== undefined) return null; // 形状互斥
    for (const a of args || []) {
      if (typeof a !== "string") return null;
    }
  } else {
    const url = str(cfg, "url");
    if (!url || !URL_RE.test(url)) return null; // streamable-http 必填且 ^https?://
    if (str(cfg, "command") !== undefined || args !== undefined) return null; // 形状互斥
    args = undefined;
    for (const kk of Object.keys(headers)) {
      if (!MAP_KEY_RE.test(kk) || typeof headers[kk] !== "string") return null;
    }
  }
  for (const kk of Object.keys(env)) {
    if (!MAP_KEY_RE.test(kk) || typeof env[kk] !== "string") return null;
  }

  const m = {
    id,
    serverName,
    transport,
    enabled: cfg.disabled === true ? false : true,
    env: { ...env },
  };
  if (transport === "stdio") {
    m.command = command0(cfg);
    if ((args || []).length > 0) m.args = [...args];
  } else {
    m.url = str(cfg, "url");
    if (Object.keys(headers).length > 0) m.headers = { ...headers };
  }
  return m;
  //#endregion
}

function command0(cfg) {
  return typeof cfg.command === "string" ? cfg.command : "";
}

/** 文档节点序列还原为文本（含尾部换行状态），逐字节可逆。 */
export function serializeDocument(nodes, tail) {
  let out = "";
  for (const n of nodes) {
    if (n.t === "seg") out += n.lines.join("\n") + "\n";
    else if (n.t === "mark") out += "- insert:\n";
    else out += n.s + "\n";
  }
  while (out.endsWith("\n")) out = out.slice(0, -1);
  return tail ? out + "\n" : out;
}
//#endregion

//#region 序列化器（严格按任务书模板生成条目段）
/** 由 canonical 模型生成条目段行数组；name 用固定模板值。 */
export function buildEntrySegment(m) {
  const L = [];
  L.push(`    - id: ${yamlQuote(m.id)}`);
  L.push(`      name: ${yamlQuote(ENTRY_NAME)}`);
  L.push(`      config:`);
  L.push(`        serverName: ${yamlQuote(m.serverName)}`);
  L.push(`        transport: ${m.transport}`);
  if (m.transport === "stdio") {
    L.push(`        command: ${yamlQuote(m.command)}`);
    if (m.args && m.args.length > 0) {
      L.push(`        args:`);
      for (const a of m.args) L.push(`          - ${yamlQuote(a)}`);
    }
  } else {
    L.push(`        url: ${yamlQuote(m.url)}`);
    const hk = Object.keys(m.headers || {});
    if (hk.length > 0) {
      L.push(`        headers:`);
      for (const k of hk) L.push(`          ${k}: ${yamlQuote(m.headers[k])}`);
    }
  }
  L.push(`        env: {}`);
  if (m.enabled === false) L.push(`        disabled: true`);
  return L;
}

function canonOf(input) {
  // 剥掉内部辅助字段，得到纯 canonical 模型。
  const m = { ...input };
  delete m.nameValue;
  delete m._opaque;
  return m;
}

/** 全新文档脚手架（含横幅）。entries 为 canonical 模型数组。 */
export function wholeFileScaffold(entryModels) {
  const nodes = [];
  for (const s of BANNER_LINES) nodes.push({ t: "pas", s });
  nodes.push({ t: "pas", s: "" });
  nodes.push({ t: "mark", m: null });
  for (const rawM of entryModels) {
    const m = canonOf(rawM);
    nodes.push({ t: "seg", lines: buildEntrySegment(m), m });
  }
  return { nodes, tail: true };
}

/**
 * 在文档末尾最后一个 - insert: 块尾追加一个条目段（纯函数）。
 * 无任何块且文档为空 → 整份生成（含横幅）；无任何块但有内容 →
 * 字节保留既有内容并在其后补空块接住。
 */
export function appendToDocument(prevNodes, prevTail, rawModel) {
  const m = canonOf(rawModel);
  const segNode = () => ({ t: "seg", lines: buildEntrySegment(m), m });
  const nodes = prevNodes.map((n) =>
    n.t === "seg" ? { t: "seg", lines: [...n.lines], m: n.m } : { ...n }
  );
  const isOwned = (n) => n.t === "mark" || n.t === "seg";
  const isBlank = (n) => n.t === "pas" && n.s.replace(/\r$/, "").trim() === "";
  const lastOwned = (() => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) if (isOwned(nodes[i])) return i;
    return -1;
  })();

  if (lastOwned < 0) {
    if (nodes.length === 0) return wholeFileScaffold([m]);
    // 已有内容但没有任何 insert 块：截掉尾部空行，补一空行 + 空块接住。
    let cut = nodes.length;
    while (cut > 0 && isBlank(nodes[cut - 1])) cut -= 1;
    nodes.length = cut;
    nodes.push({ t: "pas", s: "" }, { t: "mark", m: null });
    nodes.push(segNode());
    return { nodes, tail: true };
  }

  const gap = (() => {
    let c = 0;
    for (let i = lastOwned + 1; i < nodes.length && isBlank(nodes[i]); i += 1) c += 1;
    return c;
  })();
  const trailingExists = lastOwned + 1 + gap < nodes.length;

  if (trailingExists) {
    // 块后面还有内容（如尾部注释）：直接在既有分隔之后插入段行。
    const insAt = lastOwned + 1 + gap;
    nodes.splice(insAt, 0, segNode());
    return { nodes, tail: prevTail };
  }
  // 追加到文档末尾：保证至少一个空行分隔，然后放段。
  if (gap === 0) nodes.splice(lastOwned + 1, 0, { t: "pas", s: "" });
  nodes.push(segNode());
  return { nodes, tail: true };
}
//#endregion

//#region 文档读写服务（缓存 + 互斥锁 + 原子写）
const runtime = {
  mutex: Promise.resolve(),
  revision: 0,
  cache: null, // { key, fp, exists, parsed:{error,nodes,tail}, servers:[canonical+_opaque], index:Map(id->nodeRef) }
};

function withLock(fn) {
  const run = runtime.mutex.then(fn, fn);
  runtime.mutex = run.then(
    () => {},
    () => {}
  );
  return run;
}

function describeServers(parsed) {
  const servers = [];
  const index = new Map();
  const seenIds = new Set();
  const seenNames = new Set();
  for (const n of parsed.nodes) {
    if (n.t !== "seg" || !n.m) continue;
    const mm = n.m;
    if (seenIds.has(mm.id) || seenNames.has(mm.serverName)) continue; // 重复声明者按不透明处理
    seenIds.add(mm.id);
    seenNames.add(mm.serverName);
    servers.push({ ...mm, _opaque: false });
    index.set(mm.id, n);
  }
  return { servers, index };
}

async function loadParsed(force) {
  const fp = filePath();
  let st = null;
  try {
    st = await fsp.stat(fp);
  } catch {
    st = null;
  }
  const key = st ? `${st.mtimeMs}:${st.size}` : "missing";
  if (!force && runtime.cache && runtime.cache.key === key) return runtime.cache;
  let parsed;
  if (!st) {
    parsed = { nodes: [], tail: true, error: null };
  } else {
    let text = null;
    try {
      text = await fsp.readFile(fp, "utf8");
    } catch {
      text = null;
    }
    parsed = text === null ? { nodes: [], tail: true, error: null } : parseDocument(text);
  }
  const { servers, index } = parsed.error
    ? { servers: [], index: new Map() }
    : describeServers(parsed);
  const entry = { key, fp, exists: !!st, parsed, servers, index };
  runtime.cache = entry;
  return entry;
}

/** 提交一次成功写入后的缓存刷新（重新 stat + 重解析），revision 自增。 */
async function commitWritten(fp) {
  const text = await fsp.readFile(fp, "utf8");
  const parsed = parseDocument(text);
  if (parsed.error) throw new ApiError(500, "internal", "写入后重解析失败：" + parsed.error.message);
  const { servers, index } = describeServers(parsed);
  const st = await fsp.stat(fp);
  runtime.cache = { key: `${st.mtimeMs}:${st.size}`, fp, exists: true, parsed, servers, index };
  runtime.revision += 1;
  return runtime.revision;
}

//#region 原子写：优先官方 @deepseek-ai/dsh-atomic-write，否则等价本地实现
// 官方包随 DSH 装在 profiles 树的 node_modules 中；插件被 junction 进同一棵树后，
// 裸导入沿父目录上溯即可解析。在无宿主树的独立环境（本包自测）导入失败时，
// 回退到下方语义等价的本地实现（额外补 fsync）。
let officialAW = undefined; // undefined=未探测 null=不可用 module=官方
async function getOfficialAtomic() {
  if (officialAW === undefined) {
    officialAW = null;
    try {
      const m = await import("@deepseek-ai/dsh-atomic-write");
      if (m && typeof m.writeFileAtomic === "function") officialAW = m;
    } catch {}
  }
  return officialAW;
}

const ATOMIC_FILE_MODE = 0o644;

/** 与官方 writeFileAtomic 同语义：dirMode 递归建父目录、wx 随机后缀 tmp、rename 原子替换、失败清理；另补 fsync。 */
async function writeFileAtomicLocal(fp, content, opts = {}) {
  const dir = path.dirname(fp);
  await fsp.mkdir(dir, { recursive: true, ...(opts.dirMode === undefined ? {} : { mode: opts.dirMode }) });
  const tmp = path.join(
    dir,
    `.${path.basename(fp)}.${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`
  );
  let fh = null;
  try {
    fh = await fsp.open(tmp, "wx", opts.mode === undefined ? ATOMIC_FILE_MODE : opts.mode);
    await fh.write(String(content), 0, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    try {
      await fsp.rename(tmp, fp);
    } catch (e) {
      try {
        await fsp.unlink(tmp);
      } catch {}
      throw e;
    }
  } catch (e) {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
    try {
      await fsp.unlink(tmp);
    } catch {}
    throw e;
  }
}

let lastWriteImpl = null; // 最近一次实际写入路径："official" | "local"（诊断用）

/** 统一写入口：官方包可解析则用之，否则本地等价实现。 */
async function writeTargetFile(fp, text) {
  const off = await getOfficialAtomic();
  if (off) {
    await off.writeFileAtomic(fp, text, { mode: ATOMIC_FILE_MODE });
    lastWriteImpl = "official";
  } else {
    await writeFileAtomicLocal(fp, text, { mode: ATOMIC_FILE_MODE });
    lastWriteImpl = "local";
  }
}

/**
 * 在跨进程 writer 锁内执行 thunk（官方 withFileLock，等待上限 2s；
 * 锁超时映射为 500/"locked"）。官方锁不可用时退化为仅进程内互斥
 * （调用方已包 withLock），靠写入前 stat/mtime 重查收窄竞态窗口。
 * 注意：与 rename 提交配对时读者免锁；孤儿 .lock 由运维清理（官方语义如此）。
 */
async function withCrossProcessLock(thunk) {
  const off = await getOfficialAtomic();
  if (!off || typeof off.withFileLock !== "function") return thunk();
  try {
    return await off.withFileLock(filePath(), thunk, { waitMs: 2000 });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = String((e && e.message) || e);
    if (/writer lock/.test(msg)) {
      throw new ApiError(500, "locked", "配置文件正被其他进程修改，请稍后重试：" + msg);
    }
    throw e;
  }
}
//#endregion
//#endregion

//#region 校验与业务操作
function failValidation(message) {
  throw new ApiError(400, "validation", message);
}

function expectObject(v, label) {
  if (!v || typeof v !== "object" || Array.isArray(v)) failValidation(`${label} 必须是对象`);
  return v;
}

/** 全量校验 canonical server 输入（含 sanitize 宁严勿损），返回干净模型（无 id）。 */
function validatedServer(input) {
  expectObject(input, "server");
  const serverName = input.serverName;
  if (typeof serverName !== "string" || !SERVER_NAME_RE.test(serverName)) {
    failValidation("名称需 1-32 位字母数字下划线连字符");
  }
  const transport = input.transport;
  if (TRANSPORTS.indexOf(transport) < 0) failValidation("传输方式必须是 stdio 或 streamable-http");

  const m = { serverName, transport, enabled: input.enabled === false ? false : true };

  if (typeof input.command !== "undefined" && input.command !== null) {
    if (typeof input.command !== "string") failValidation("命令必须是字符串");
    m.command = input.command;
  }
  if (Array.isArray(input.args)) {
    m.args = input.args.map((a, i) => {
      if (typeof a !== "string") failValidation(`参数第 ${i + 1} 行必须是字符串`);
      const bad = sanitizeValueError("参数项", a);
      if (bad) failValidation(bad);
      return a;
    });
  }
  const takeMap = (field, label) => {
    if (input[field] === undefined || input[field] === null) return undefined;
    expectObject(input[field], label);
    const out = {};
    for (const k of Object.keys(input[field])) {
      const val = input[field][k];
      if (typeof val !== "string") failValidation(`${label} 的 "${k}" 值必须是字符串`);
      const badK = sanitizeValueError(`${label} 的键 "${k}"`, k);
      if (badK) failValidation(badK);
      const badV = sanitizeValueError(`${label} 的 "${k}"`, val);
      if (badV) failValidation(badV);
      out[k] = val;
    }
    return out;
  };
  const env = takeMap("env", "环境变量");
  if (env) m.env = env;
  const headers = takeMap("headers", "请求头");
  if (headers) m.headers = headers;
  if (typeof input.url !== "undefined" && input.url !== null) {
    if (typeof input.url !== "string" || !URL_RE.test(input.url))
      failValidation("URL 必须以 http:// 或 https:// 开头");
    m.url = input.url;
  }

  if (transport === "stdio") {
    if (!m.command) failValidation("stdio 需要 command");
    const badCmd = sanitizeValueError("命令", m.command);
    if (badCmd) failValidation(badCmd);
    delete m.url;
  } else {
    if (!m.url) failValidation("streamable-http 需要合法 URL");
    const badUrl = sanitizeValueError("URL", m.url);
    if (badUrl) failValidation(badUrl);
    delete m.command;
    delete m.args;
  }

  if (m.enabled !== false) delete m.enabled; // 缺省 true 不落盘
  if (m.env && Object.keys(m.env).length === 0) delete m.env;
  if (m.headers && Object.keys(m.headers).length === 0) delete m.headers;
  if (m.args && m.args.length === 0) delete m.args;
  return m;
}

function genIdsFrom(serverName, taken) {
  const stem = "mcp-" + serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let cand = stem;
  let n = 2;
  while (taken.has(cand)) {
    cand = `${stem}-${n}`;
    n += 1;
  }
  return cand;
}

function assertParsable(fresh) {
  if (fresh.parsed.error) {
    throw new ApiError(500, "unparsable", "目标文件存在无法理解的结构，已拒绝改动：" + fresh.parsed.error.message);
  }
}

async function opCreate(body) {
  const inputServer = expectObject(body.server, "server");
  const m = validatedServer(JSON.parse(JSON.stringify(inputServer)));
  const fresh = await loadParsed(false);
  assertParsable(fresh);

  const providedId = inputServer.id;
  const taken = new Set(fresh.index.keys());
  const takenNames = new Set(fresh.servers.map((s) => s.serverName));
  if (takenNames.has(m.serverName)) failValidation(`serverName "${m.serverName}" 已存在于配置中`);

  let finalId;
  if (providedId !== undefined && providedId !== null && providedId !== "") {
    if (typeof providedId !== "string" || !ID_RE.test(providedId))
      failValidation('id 必须以 "mcp-" 开头且仅含小写字母数字和连字符');
    if (taken.has(providedId)) failValidation(`id "${providedId}" 已存在`);
    finalId = providedId;
  } else {
    finalId = genIdsFrom(m.serverName, taken);
  }

  const full = { ...m, id: finalId };
  const built = appendToDocument(fresh.parsed.nodes, fresh.parsed.tail, full);
  const textOut = serializeDocument(built.nodes, built.tail);
  await writeTargetFile(fresh.fp, textOut);
  const revision = await commitWritten(fresh.fp);
  return { id: finalId, revision };
}

async function opUpdate(body) {
  const id = body.id;
  if (typeof id !== "string" || id === "") failValidation("id 必须是非空字符串");
  checkRevision(body.expectRevision);
  const m = validatedServer(JSON.parse(JSON.stringify(body.server)));
  const fresh = await loadParsed(false);
  assertParsable(fresh);

  const node = fresh.index.get(id);
  if (!node) throw new ApiError(404, "not_found", `未找到 id 为 "${id}" 的条目`);
  const dupe = fresh.servers.find((s) => s.serverName === m.serverName && s.id !== id);
  if (dupe) failValidation(`serverName "${m.serverName}" 已被其他条目占用`);

  const updated = { ...m, id }; // 忽略传入的新 id，沿用旧 id 定位替换
  const repl = { t: "seg", lines: buildEntrySegment(updated), m: updated };
  const idx = fresh.parsed.nodes.indexOf(node);
  const nodesNext = fresh.parsed.nodes.slice();
  nodesNext[idx] = repl;
  const textOut = serializeDocument(nodesNext, fresh.parsed.tail);
  await writeTargetFile(fresh.fp, textOut);
  const revision = await commitWritten(fresh.fp);
  return { id, revision };
}

async function opDelete(body) {
  const id = body.id;
  if (typeof id !== "string" || id === "") failValidation("id 必须是非空字符串");
  checkRevision(body.expectRevision);
  const fresh = await loadParsed(false);
  assertParsable(fresh);

  const node = fresh.index.get(id);
  if (!node) throw new ApiError(404, "not_found", `未找到 id 为 "${id}" 的条目`);
  const nodes = fresh.parsed.nodes;
  const idx = nodes.indexOf(node);

  // 删除段行及其前空行。
  let begin = idx;
  for (let probe = idx - 1; probe >= 0; probe -= 1) {
    const n = nodes[probe];
    if (n.t === "pas" && n.s.replace(/\r$/, "").trim() === "") begin = probe;
    else break;
  }
  const next = nodes.slice(0, begin).concat(nodes.slice(idx + 1));
  const textOut = serializeDocument(next, fresh.parsed.tail);
  await writeTargetFile(fresh.fp, textOut);
  const revision = await commitWritten(fresh.fp);
  return { id, revision };
}

function checkRevision(expectRevision) {
  if (typeof expectRevision !== "number" || Number.isNaN(expectRevision) || expectRevision !== runtime.revision) {
    throw new ApiError(400, "conflict", "revision 已过期，请刷新后重试");
  }
}
//#endregion

//#region HTTP 层
function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function isLoopback(remoteAddress) {
  return LOOPBACK_ADDRS.has(remoteAddress);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy(); // 超限断开
      throw new ApiError(400, "bad_request", "请求体超过 256KB 上限");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e instanceof ApiError) {
      json(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
      return null;
    }
    json(res, 400, { ok: false, error: { code: "bad_request", message: "读取请求体失败" } });
    return null;
  }
  if (raw.length === 0) {
    json(res, 400, { ok: false, error: { code: "bad_request", message: "请求体不能为空" } });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    json(res, 400, { ok: false, error: { code: "bad_request", message: "请求体不是合法 JSON" } });
    return null;
  }
}

async function handleOp(res, thunk) {
  try {
    // 进程内互斥锁（保留）→ 官方跨进程 writer 锁（可用时）→ 读改写事务
    const result = await withLock(() => withCrossProcessLock(thunk));
    json(res, 200, { ok: true, ...result });
  } catch (e) {
    if (e instanceof ApiError) {
      json(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
      return;
    }
    try {
      json(res, 500, { ok: false, error: { code: "internal", message: String((e && e.message) || e) } });
    } catch {}
  }
}

async function handler(req, res) {
  try {
    // 回环校验（全部请求）
    if (!isLoopback(req.socket.remoteAddress)) {
      json(res, 403, { ok: false, error: { code: "forbidden" } });
      return;
    }
    let urlObj;
    try {
      urlObj = new URL(req.url || "/", "http://localhost");
    } catch {
      json(res, 400, { ok: false, error: { code: "bad_request", message: "非法 URL" } });
      return;
    }
    const routePath = urlObj.pathname.replace(/\/+$/, "") || "/";
    const method = String(req.method || "").toUpperCase();

    if (method === "GET" && routePath === ROUTE_PREFIX + "/api/state") {
      const fresh = await loadParsed(false);
      if (fresh.parsed.error) {
        json(res, 500, { ok: false, error: { code: "unparsable", message: fresh.parsed.error.message } });
        return;
      }
      json(res, 200, {
        ok: true,
        revision: runtime.revision,
        servers: fresh.servers,
        filePath: fresh.fp,
      });
      return;
    }
    if (method === "POST" && routePath === ROUTE_PREFIX + "/api/create") {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      await handleOp(res, () => opCreate(body));
      return;
    }
    if (method === "POST" && routePath === ROUTE_PREFIX + "/api/update") {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      await handleOp(res, () => opUpdate(body));
      return;
    }
    if (method === "POST" && routePath === ROUTE_PREFIX + "/api/delete") {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      await handleOp(res, () => opDelete(body));
      return;
    }

    json(res, 404, { ok: false, error: { code: "not_found", message: "未知路由" } });
  } catch (e) {
    try {
      json(res, 500, { ok: false, error: { code: "internal", message: String((e && e.message) || e) } });
    } catch {}
  }
}

export function apply(ctx) {
  let activeDispose = null;
  // 动态二级注入（照 dsh-memory-evolve 的验证模式）：有 webServer 的面
  // （web）注册路由；没有的面（headless/tui）回调不执行，入口照常激活。
  // 注意：不要在 inject 回调里用 ctx.effect 挂清理——该回调的上下文是
  // 短暂子作用域，effect 会随其立即释放导致路由被注销；用闭包持有即可，
  // 生命周期跟随插件 fiber（apply 返回值就是 disposer）。
  ctx.inject(["webServer"], (webCtx) => {
    const ws = (typeof webCtx.get === "function" ? webCtx.get("webServer") : null) || webCtx;
    activeDispose = ws.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler,
    });
  });
  return () => {
    try { if (activeDispose) activeDispose(); } catch {}
  };
}
//#endregion

//#region 自测导出（不影响运行时契约）
export const __test__ = {
  parseDocument,
  serializeDocument,
  buildEntrySegment,
  appendToDocument,
  wholeFileScaffold,
  sanitizeValueError,
  yamlQuote,
  filePath,
  isLoopback,
  writeFileAtomicLocal,
  writeTargetFile,
  withCrossProcessLock,
  getLastWriteImpl: () => lastWriteImpl,
};
//#endregion
