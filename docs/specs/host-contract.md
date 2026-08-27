# DSH 宿主契约 — 树外插件 `@local/dsh-mcp-manager`

只读调查结论，自包含，构建者无需再读源码。安装根 `<root>` =
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（v0.1.1-rc.2，type: module，bin=dsh），
官方包在 `<root>\node_modules\@deepseek-ai\<pkg>`；引用格式 `[pkg/文件:L行]`。

## 0. 环境事实
- `$DSH_HOME` = `~\.dsh`；web profile 目录 `.dsh\profiles\web\`（含 `cordis.yml`、`cordis.patch.yml`、自有 `node_modules`）；共享回退目录 `.dsh\profiles\node_modules\`（现为 healProfilesModuleFallback 维护的逐包 junction）。
- 家级用户补丁层 `~/.dsh/cordis.patch.yml` 已存在且正是 MCP 服务器 insert 清单 —— 本插件的宿主半要托管的就是它。
- web 组合挂载顺序：`dsh-base` bundle 层 → `dsh-web-app` bundle 层 → `profiles/web/cordis.patch.yml` → `~/.dsh/cordis.patch.yml` → `--patch` 覆盖层（+telemetry 开关）[profile-boot-DG5t9aNs.js:L146-L154,L166-L198]。

## 1. 路由注册：webServer 服务
- 服务定义 `[dsh-host-webserver/lib/index.js:L96-L135]`、类型 `[lib/types/index.d.ts:L32-L55]`：
  `ctx.get('webServer').register(route): () => void`，`route = { kind:'exact'|'prefix', path, handler }`。
  - `path` 必须为绝对 pathname 且**无尾斜杠**；同 kind 同 path 重复注册抛错（exact/prefix 分属两张表，同名不互斥，L102-L103,L130）。
  - `handler(req, res)` 收到的是 **node:http 原生对象**（IncomingMessage / ServerResponse，见 d.ts:L10 导入），async 可用，**handler 拥有完整响应生命周期**（可长开 SSE）；抛错时宿主 warn 并回 400（已发头则 destroy 连接）[index.js:L186-L207]。
  - 匹配：先 exact 精确命中，再 prefix 中最长前缀胜出（等于 path 或以 `path + '/'` 开头）[index.js:L270-L279]。
  - 相关但勿占用的席位：`registerFallback` 仅一个（官方 SPA dist 占用）、`registerUpgrade`、`tapIndex`。
- 返回 JSON 的标准写法（真实样例）：`res.writeHead(200,{ 'content-type':'application/json; charset=utf-8' }); res.end(JSON.stringify(obj))`。SSE 样例见 `[dsh-client-hmr/lib/index.js:L116-L159]`（method 守卫→405 也是官方惯例 L137-L141）。
- 最小可用宿主插件（模仿 dsh-client-hmr 的导出形状 `export { Config?, apply, inject?, name }`）：

```js
// lib/index.js
export const name = "@local/dsh-mcp-manager";
export const inject = ["webServer"];          // 缺服务则 fiber 挂起等待
export function apply(ctx) {
  const handler = async (req, res) => {       // req.method/url/headers；res.writeHead/end
    if (!["GET","POST"].includes(req.method)) { res.writeHead(405); return void res.end(); }
    // …读写 ~/.dsh/cordis.patch.yml 后…
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  };
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/mcp-manager-api", handler }),
             "mcp-manager api");              // dispose 时自动注销——这就是"注销"标准做法
}
```
  真实参照：prefix 路由 + trust fence + `ctx.effect(() => ctx.webServer.register(route), label)` 自动注销 `[dsh-client-connection/lib/index.js:L550-L562]`。

## 2. 客户端包发现与 `/plugins` 服务
服务端半 `[dsh-client-modules/lib/index.js]`（下称 idx）：
- 服务 `clientModules`，`static inject=["webServer","loader"]` [L259]，要求 `ctx.baseUrl` 存在 [L274]，包元数据经 `createRequire(ctx.baseUrl).resolve('<pkg>/package.json')` 解析 [L275-L276] —— **exports 存在的包必须显式导出 `"./package.json"`**，否则 ERR_PACKAGE_PATH_NOT_EXPORTED。
- 扫描驱动：监听 cordis `internal/plugin` 事件 + 初始遍历 `loader.entries()`，微任务 flush 增量调和 [L277-L294]。`processOne` 只认 **entry.options.name === 包名且 entry.fiber 非空且未 disabled** 的 loader 行 [L421-L437] ⇒ 你的插件必须以一行的形式挂进组合树，且该行 `name:` 就是完整 npm 包名（含 scope）。
- `package.json` 解析规则 `parseDshClient` [L120-L134]、`resolveMeta` [L377-L404]：
  - `dsh.client.platform` 必须是字符串且等于 `"web"`，否则整个包按非客户端包忽略 [L390-L393]；
  - `inject?: string[]` —— 信息性依赖边（预检显示/HMR diff），不约束代码到达 [manifest.d.ts:L41-L45,L54-L55]；
  - `external?: string[]` —— 本 bundle 向模块表请求的非基线 specifier，约束**到达顺序**（被请求包的行必须排在消费者前；`<pkg>/client` 与裸名等价，`stripClientSuffix` 归一）[idx:L52-L63,L172-L194; manifest.d.ts:L58-L59]；
  - `immediately?: boolean` —— 第一阶段预取标记：仅提前加载脚本完成 factory 注册，不物化 [manifest.d.ts:L56-L57]；
  - 真实声明示例：`[dsh-client-runtime/package.json:L32-L42]`。
- `exports["./client"]` 必须为 string 或 `{ default: string }` [idx:L136-L146]，相对包目录解析为产物绝对路径 [L397]；声明了 dsh.client 却无 `./client` 导出 → 启动期直接抛错 [L395]；产物文件缺失(ENOENT) → `MissingClientBundleError` 聚合失败（提示 "run `pnpm run build` before launch"，FAILED fiber）[L91-L118,L412-L418] ⇒ **启动时产物必须已在盘上**。
- URL 形状：`GET /plugins/<id>/client.js?rev=<sha1前12>`，`id = 完整包名（如 "@local/dsh-mcp-manager"，scope 内的 "/" 属于 id）`，rev 为内容哈希仅作 cache-busting；路由为 `kind:"prefix", path:"/plugins"` [idx:L152-L161,L295-L299]。serveBundle 只接受 GET/HEAD，`decodeURIComponent(pathname)` 后剥离固定前缀 `/plugins/`(9 字符) 与后缀 `/client.js`(10 字符) 得 id，恒 `cache-control: no-cache`, content-type `text/javascript; charset=utf-8` [idx:L459-L490]。
- source map：**不需要**。`.map` 只是顺带尝试 `${clientPath}.map`，读不到返回 404 无任何副作用（HMR 重哈希只读 clientPath 本体）[idx:L468-L488]；仅影响 DevTools 源码映射。
- 浏览器端注册：bundle 是 classic script（IIFE 包裹），首行执行 `window.__ModuleLoader__.load({ id, factory })`，其中 **id 必须等于图行 id 即完整包名**（带 `/client` 尾缀会被 strip 兼容，注册键取 strip 后的 id）[client.js:L1-L3,L190-L193; manifest.d.ts:L129-L139]；脚本加载完未完成注册会报 "loaded without registering \<id\>" [client.js:L201-L202]。factory `(require) => exports` 内闭包持有全部副作用（含 CSS 注入），物化惰性且 memoized [idx:L16-L31]。

## 3. 模块解析路径与免安装挂载点
- bundle 补丁层定位用双锚 `resolveBundleDir`：安装根优先，其次 profile 目录 `package.json`；探测走 `require.resolve.paths(pkg)` + `existsSync(pkg/package.json)`（**此路径不要求导出 ./package.json**）[app-boot/lib/index.js:L492-L524]。
- 运行时插件模块导入：`EntryTree.import(name)` → `internal.import(name, ctx.baseUrl)` [cordis-plugin-loader/lib/index.js:L259-L274]；Node 半 `ctx.baseUrl` = 配置文件所在目录 = profile 目录（`boot()` 设 `[app-boot:L1171]`；Include 再锚定 `[app-boot:L133,L138]`）。⇒ 裸包名解析走 Node 常规**父目录 node_modules 上溯**：
  `~\.dsh\profiles\web\node_modules` → `~\.dsh\profiles\node_modules`（共享回退）→ 再向上。
- 共享回退目录由 `healProfilesModuleFallback` 维护：对安装依赖闭包逐包做 Windows junction（`symlinkSync(target, link, "junction")`）[app-boot:L370-L389,L409-L438]。它只管理官方闭包内的名字，**不会动你的条目**。实际观察：该目录已有 `@anthropic-ai`、`@deepseek-ai` 等作用域子目录。
- **结论：「junction 进共享 profiles\node_modules」可行**（父目录上溯天然命中、全 profile 共享）；放 `profiles\web\node_modules` 亦可行且仅该 profile 可见。两种放置都免 pnpm install，require.resolve/existsSync 均 transparent 跟随 junction。注意 subtree 里再放真实目录+独立 node_modules 同样成立（symlink 的依赖从其真实路径解析 [app-boot:L400-L402]）。
- 但 client 半元数据走的 `require.resolve('<pkg>/package.json')` 要求 exports 放行该子路径（见 §2）。
- 新包 `package.json` 最小必备字段：

```jsonc
{
  "name": "@local/dsh-mcp-manager",
  "type": "module",                       // 宿主半由 plain ESM Node 导入
  "main": "lib/index.js",
  "exports": {
    ".":         { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client":  { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./invariant": { "default": "./lib/invariant.js" },   // 可选，模仿官方惯例
    "./src/*": "./src/*",
    "./package.json": "./package.json"    // ★ 必备（元数据扫描）
  },
  "dsh": { "client": {                    // 浏览器半声明；纯宿主插件可整体省略
    "platform": "web",                    // 必须，否则不入图
    "inject": ["@deepseek-ai/dsh-client-connection"],   // 信息性；浏览器 RPC 用它
    "external": []                        // 若 require 其他客户端包必填
  } }
}
```

## 4. 回环校验标准做法
全库 grep `remoteAddress`：**零命中** —— 官方没有基于套接字地址的判定，标准做法是 Host 头围栏（防 DNS rebinding 与跨站），实现在 `[dsh-client-connection/lib/index.js]`：
```js
function isLoopbackHostname(hostname) {                 // WHATWG URL hostname，IPv6 带方括号
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127"
      && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);   // 整个 127/8
}                                                       // [L100-L104]
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);                 // new URL("http://"+authority)，失败 undefined [L127-L133]
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === void 0) return true;                   // 非浏览器读取不带 Origin
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}                                                       // [L184-L198]
```
- 特权方法集钉死回环：`PRIVILEGED_METHODS`（settings.*/credentials.*/host.openPath 等）+ `authority:"loopback"` 通道一律传空 trustedHosts 再过 fence [L237,L243,L504-L520,L530-L562]。
- 背景默认安全：webserver 绑定回填 `127.0.0.1` [dsh-web-app/cordis.patch.yml:L121-L126]，外网本不可达；fence 防 rebinding/cross-site。
- 因不存在 IP 字面量解析，`::ffff:` 在官方代码中不需处理。若构建者想额外按 `req.socket.remoteAddress` 强校验（本文补充建议，非官方实现）：接受 `::1` 与 `::ffff:127.x.x.x`（先剥 `::ffff:` 前缀再走 isLoopbackHostname 同款四段判断）。

## 5. 热挂载语义（补丁文件 watch）
- web 组合里共享 HMR 行被禁用 `[dsh-web-app/cordis.patch.yml:L22-L23]`（`- id: hmr / disabled: true`）。profile-boot 自举兜底：运行中若无 hmr 服务则动态创建 timer + `@deepseek-ai/cordis-plugin-hmr`（config `{ root: [] }`，即**不 watch 模块源码根**，init 立即 ready）[profile-boot-DG5t9aNs.js:L256-L263; cordis-plugin-hmr/lib/index.js:L226-L227]。
- 接着对两个补丁文件各挂一个精确路径 watcher：`watchUserPatches(ctx,{filename: profiles/web/cordis.patch.yml})` 与 `(~/.dsh/cordis.patch.yml)` [DG5t9aNs:L264-L273; app-boot:L761-L781]。底层是 chokidar 对最近存在祖先目录 add/change/unlink 的精确过滤 [cordis-plugin-hmr:L118-L166]。
- 变更流程：重读文件（内容不变则短路不动作 `[app-boot:L177]`）→ 重 compose 该层 → `entry.update({config:{patches}})` → Include 的 `internal/update` 处理器 `applyPatches(currentData, patches)` 后 `root.update(data)` **事务性差分刷新整棵 include 子树** [app-boot:L139-L146,L236-L242]。
- **结论：运行中向 `~/.dsh/cordis.patch.yml` 增加/删除一行插件 insert 会即时挂载/卸载** ✔。差分语义：新 id → 创建并激活；消失 id → dispose 移除；同 id 变 config → 原位换新 [cordis-plugin-loader/lib/index.js:L76-L112]；失败整笔拒绝并回滚旧树 [L94-L111]。
- 需要重启的场景：
  1) 改插件自身 JS 源码/重新构建宿主 lib —— 模块根 watch 关闭（hmr `root:[]` + 共享行 disabled），无人触发 reload；
  2) 改 `dsh.profile.bundles`、pnpm install 新依赖 —— `composeProfile` 仅启动跑一次 [DG5t9aNs:L166-L198]；
  3) client 半包元数据缓存 `pkgMeta`「per name 永不失效」——同名行曾被判为非客户端包（或当时声明错误）后修正 package.json，需重启才会重扫 [dsh-client-modules/lib/index.js:L82-L85,L377-L404]；
  4) `!!js ctx.webStartup.*` 类表达式值只在启动求值一次。
- 附：client bundle 内容更新另有常开链路 —— client-hmr 以默认 500ms stat-poll 监听所有图行产物文件，变更即 `rebuilt(id)` 重哈希并经 SSE `/plugins/events` 推 `rebuilt` 帧 [dsh-client-hmr/lib/index.js:L15-L28,L78-L108,L145-L158]；浏览器端 invalidate 后重拉新 rev URL。改 `dist` 里的 client.js 不需要动补丁文件。

## 6. cordis 补丁插入格式回顾
顶层 YAML 数组（js-yaml JSON_SCHEMA + `!!js` 表达式方言 `[app-boot:L15-L29]`），每项一个 patch mapping `[app-boot:L57-L106]`：
- `- insert:` 数组（项=插件行 `{ id?, name, inject?, config? }`）：
  - 顶层无 id insert → 行追加到入口列表尾 [L83]；带 id 的 insert 目标必须是 group 行并把数组并入其 `config` 数组 [L70-L82]，不是 group 则告警跳过。
  - insert 行即时进入 id 索引 ⇒ 同一 patch 列表中后续定点 patch 可以指向先前 insert 的行 [L47-L51,L84]。
- 定点覆写：`{ id: X, name?, config?|disabled?... }`。缺 id 报错跳过；`name` 用于守卫，不一致告警跳过；其余键**逐一赋值覆盖**，`config` 键 = **整体替换**（非深合并）——web-app 各行因此都重述全部所属键 [L87-L103; yml 文件头注释 L4-L6]；`disabled: true` 也是普通 override（见 hmr 行实例）。缺少 id 的行由加载器生成随机 id（此后无法寻址）[cordis-plugin-loader:L189-L194] ⇒ **总是显式给 id**。
- 多层重复插入行为：所有层扁平化为**一条列表、单次顺序应用** [composeEntries app-boot:L575-L580]，insert 是纯追加不去重 ⇒ 两层插入同一 id 会在最终表中出现两条同 id 行，而 `EntryGroup.update` 对重复 id 直接抛 `duplicate loader entry id` [loader:L76-L83] ⇒ Boot 直接失败 / 热更新回滚。同 id 正确姿势：后层用定点覆写（config 整替/disabled），home 层排位高于全部 bundle 层与 profile 层（§0 顺序），天然适合覆盖式写法。

## 7. 复用原子写 `@deepseek-ai/dsh-atomic-write`
`import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";` [package.json:L13-L20; lib/index.js:L117]
- `writeFileAtomic(filename, content, options?): Promise<void>` —— options `{ mode?, dirMode? }`；自动 mkdir 父目录 → 同目录随机后缀兄弟临时件以 `wx` 独占创建写入 → rename 覆盖目标；任何失败清 temp 后重抛 [L30-L46]。读者只见旧/新完整内容。
- `withFileLock(filename, operation, options?): Promise<T>` —— operation 期间持有 `<file>.lock` 兄弟锁（wx 创建）；EEXIST 或 EPERM+lstat 确认存在视为争用；20ms 起指数退避至 200ms，默认等 2s 超时抛错；从不删除他者的孤儿锁 [L92-L115]。
- 与平台交互的实践要点：Windows 上 rename 覆盖可能遇 EPERM/EBUSY 抖动，官方 Include 写配置的做法是小步退避重试（≤10 次、50ms 递增）[app-boot:L36-L41,L248-L254] —— 宿主半写 patch 文件照抄即可；原子替换完成后 watchUserPatches 恰好收到一次 change 触发全量重放（内容没变则 read 短路），无需自行通知。

---
*调查基于对上述安装根的静态只读检查；行号对应 v0.1.1-rc.2 发行产物。*
