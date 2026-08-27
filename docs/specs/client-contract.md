# DSH Web 客户端半契约 —— MCP 服务器管理插件（@local/dsh-mcp-manager）

只读调查结论。证据路径缩写：
- `[INV]` = `...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-plugin-inventory\lib\client.js`
- `[GEN]` = `...\node_modules\@deepseek-ai\dsh-client-ui-settings-general\lib\client.js`（设置壳）
- `[MOD]` = `...\node_modules\@deepseek-ai\dsh-client-modules\lib\client.js`（浏览器模块系统契约面）
- `[HMOD]`= `...\node_modules\@deepseek-ai\dsh-client-modules\lib\index.js`（宿主侧图/清单组装）
- `[PEN]` = `~\.dsh\profiles\web\node_modules\@howmp\dsh-pentest`（第三方真实样板：`lib/ui-pentest.client.js`、`lib/ui-pentest.js`、`cordis.patch.yml`、`package.json`）
- `[IDX]` = `...\dsh-web-frontend\dist\assets\index-ClqxG24t.js`（实际部署的浏览器主 bundle，静态表/引导代码）

## 0. 结论速览
1. bundle 的 `load({id})` 必须＝Loader 行的 `name`；建议 `<pkg>/<subpath>`，我们用 `'@local/dsh-mcp-manager/ui'`。
2. 浏览器注册用 `ctx.slots.inject('settings.section', …)` + `ctx.slots.register({name,id,order,label,locale},Comp)`；对照官方三处现成 section（order 0/10/15），新页取 30+。
3. `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 都在静态表里，**primitives 可以被第三方 require**；可用 `require('react').createElement`，无需 jsx-runtime。
4. 同源裸 fetch 无官方先例但无任何拦截层；`fetch('/mcp-manager/list')` 默认 `credentials:'same-origin'` 自动带 cookie，够用。
5. CSS 用与两份样板一致的 `document.head.append(<style data-plugin data-plugin-css>)`＋去重；不要卸载移除（样板从不移除）。
6. section 组件只在「该页处于激活」时挂载（切走即卸载）；`useState+useEffect` 挂载拉取可靠且每次进入都会刷新。

## 1. module id 与 Loader 行名：必须相等
- `[PEN cordis.patch.yml:18-20]` 插入行 `{id: ui-pentest, name: '@howmp/dsh-pentest/ui-pentest'}`（空 config）；
- `[PEN lib/ui-pentest.client.js:1-3]` `window.__ModuleLoader__.load({ id:"@howmp/dsh-pentest/ui-pentest", factory:(require)=>{…} })`——两者逐字符相同。
- 原理：`[HMOD processOne]` 以「Loader 行名 entryName」为键建图行，`resolveMeta(entryName)` 把行名当作包说明符走 Node 解析（子路径 `'@howmp/dsh-pentest/ui-pentest'` → 经包 `exports['./ui-pentest']` 落到包根 package.json），读出 `dsh.client` 与 `exports["./client"]`；URL 固定为 `/plugins/<行名>/client.js?rev=<sha1前12位>`（`[HMOD graphRow]`）。浏览器端 `arrive()` 校验脚本必须用同 id 调 `__ModuleLoader__.load`，否则抛 "loaded without registering"（`[MOD arrive]`）。
- 双面结构确认：`[PEN lib/ui-pentest.js]` 宿主半就是 `function apply(){}` 空函数，“纯 UI 插件：空的 apply 让插件出现在宿主 cordis.yml / Loader；浏览器半经 exports["./client"] 由 package.json dsh.client 声明被发现”。照抄即可。

## 2. 我们的 package.json 应写什么
```jsonc
{
  "name": "@local/dsh-mcp-manager",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./ui": "./lib/ui.js",                 // 宿主半：function apply(){} （供行 name 子路径解析用）
    "./ui/package.json": "./package.json",
    "./client": "./lib/client.js"          // 浏览器半：手写 bundle（window.__ModuleLoader__.load 形式）
  },
  "dsh": { "client": { "platform": "web" } }
}
```
要点与取舍：
- 平台必须 `"web"`；否则行被忽略（`[HMOD resolveMeta]: decl.platform!=="web" → null`）。`dsh.client` 存在则强制要求 `exports["./client"]`，缺失直接 throw（`[HMOD clientExportOf/resolveMeta]`）。
- `dsh.client.inject`（可选字符串数组，原样进引导线 `row.inject`→`plugins[].inject`，`[HMOD parseDshClient/graphRow]`）：**可以省略**（省略时客户端解析为 `[]`，`[MOD parseBootManifest:95]`，合法）。`[INV package.json dsh.client]` 列了 api-remotes/runtime/ui-settings/locale 四个包，那是对其打包产物的依赖提示；我们是手写 bundle 且所需模块全在静态表（见 §4），声明为空即可避免“需要就地对账”的不确定性。本项证据充分但消费方在 vendored loader 内部，属低风险未决点（见 §9）。
- 浏览器 bundle 内 `exports.apply = apply; exports.inject = ["slots","locale"]` 这一层仍是 **cordis 服务名**，走 fiber 注入（`[GEN :463-468 exports.inject=["slots","locale","connection","settingsScope"]]`、`[IDX @Inject()/initHooks]` 显示 inject 数组驱动 `ctx.inject(...)`）。它与 package.json 的 dsh.client.inject 不是一回事，别混写。
- 多行的坑：同一包内多行（如 pentest 还有 storage-sqlite 行）每行都会各自成图行并指向同一 clientPath；我们只有一行 ui，不涉及。

## 3. 注册 settings.section 的完整代码（浏览器半骨架）
```js
window.__ModuleLoader__.load({
  id: "@local/dsh-mcp-manager/ui",           // 必须等于行 name
  factory: (require) => {
    const react = require("react");
    const NS = "mcpManager";
    const zh = { tab: "MCP 服务器管理", loading: "加载中…", /*…*/ };
    const en = { tab: "MCP servers",     loading: "Loading…" };
    const inject = ["slots", "locale"];

    function McpSection(props) {              // 收到的 props 见下注
      const { close, renderSlot, t } = props;
      const [servers, setServers] = react.useState(null);
      const [error, setError] = react.useState("");
      react.useEffect(() => {
        let alive = true;
        fetch("/mcp-manager/list")
          .then((r) => r.json())
          .then((data) => { if (alive) setServers(data.servers ?? []); })
          .catch((e) => { if (alive) setError(String(e)); });
        return () => { alive = false; };
      }, []);
      // …列表 + 内联编辑表单（inline style），此处从略
      return react.createElement("div", { style: styles.section },
        error ? react.createElement("p", { role: "alert" }, error)
              : servers === null ? t("loading") : /* 列表 */ null);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "mcp-manager: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "mcp-manager",                     // list 槽必填；导航图标未知 id 回落齿轮 [GEN navIcon]
        order: 40,                             // 见下方取证
        label: () => t("tab"),
        locale: NS
      }, McpSection));
    }
    return { apply, inject };
  }
});
```
用户给的模板句式正确。取证实录：
- `[GEN :585-595]` `inject("settings.section", …register({name,id:"general",order:0,label:()=>t("general.nav"),locale:NS,children:{…}}, GeneralSection))`；`[GEN models/plugins 版本]` 同构，order 分别 10、15。**建议 order 取 30–90 的独立值**（现有占用 0/10/15；排序仅按数值升序 `[GEN :507]`，相同值 tie-break 未定义，避开为稳）。
- list 槽条目**必须有 id**：“SlotCore rejects an entry without one”（`[GEN :503 注释]`）。
- 组件收到的 props 合集：壳渲染调用传 `{ close }` 并附带 `renderSlot`（`[GEN :164]`、GeneralSection 解构 `{renderSlot}`）；入口 `options.inject()` 返回值按字段展开注入（`[INV :284]` `injected=()=>({list})` → Tab 收到 `list`）；设了 `locale:NS` 则自动注入绑定好的 `t`（`[INV :63]` 形参 `({list,t})`）。不需要 hooks/snapshot 手工传递；想要响应式 store 才用 `inject()` 返回 `{hooks:{snapshot}}` 这类自定义形状（`[GEN :482-485、494-535]`）。
- 左侧导航行为：壳用 `useSections` 快照 = `entries("settings.section")` 映射 `{id,order,label}` 按 order 排序，label 经 `resolveSlotLabel`；版本号来自 `slots.getVersion` + `locale.getSnapshot().revision`，语言切换会刷新导航文案（`[GEN :494-535]`）。
- 二级插槽可选：section 入口可带 `children` 声明自己的 item 槽（`[GEN GeneralSection]`、`[PLUGINS]` 为 `settings.plugins.tab`）。首版不需要。

### locale key 缺失的表现
`[LOC=dsh-client-locale/lib/client.js translate()]`：查找顺序 命名空间当前语言 → 同 ns `"en"` → `"common"` ns（同样先当前后 en）→ **回落为 key 字符串本身**；`t(key,{params})` 做 `{name}` 占位插值。因此漏译不会崩，只会露 key；zh/en 两册都给齐即可（`register(NS,{zh,en})`，zh 是 key 基准，`[INV :216-259]`）。

## 4. React 与 primitives：都可直接 require
`[IDX Jd()]` 静态表全文（seed words，`[MOD makeRequire:254]` 首选命中）：
```
react, "react/jsx-runtime", "react-dom", "react-dom/client",
"@deepseek-ai/cordis", "@deepseek-ai/dsh-client-ui-slots",
"@deepseek-ai/dsh-client-ui-primitives"
```
- 即：任务假设“primitives 可能不可 require”不成立——它在 seed 里，任何插件工厂都能 `require("@deepseek-ai/dsh-client-ui-primitives")` 拿到 Button/Icon 等（`[GEN :336]、[INV :117]` 实际用到 Button、IconSearchOutline16 等）。若要更贴近官方观感可尽管用；不确定面就用 inline style + `var(--dsw-alias-*)` token（所有官方 CSS 变量均此体系，如 `--dsw-alias-bg-layer-2`、`--dsw-alias-border-l2`、`--dsw-shadow-lv1`，见 `[INV css]`/`[GEN css]`）。
- 不想用 jsx-runtime 时，`require("react")` 后 `react.createElement(...)` 完全等价（同一 react 实例，单例 seed）；手写 jsx 勿须 transpile。[PEN] 工厂头只 `require("react")、"react/jsx-runtime"、"react-dom"` 三者（正是静态表子集）佐证了这条 require 白名单用法。
- 纯洁性红线：require 其他 id 一律抛 "missed the module table"（`[MOD :259]`），动态跨插件脸需把对方加入行 external 且其 bundle 先到达——我们不跨插件，勿引入。

## 5. 同源 fetch 到 /mcp-manager/*
- 前端 shell 不 hook `window.fetch`：`[IDX]` 全部 `fetch(` 仅 2 处（1 处是 Vite 模块预载 polyfill `fetch(c.href,d)` 且设 `credentials="same-origin"`；另一处为 boot 预取内部调用）；vendor bundle 里的 27 处均为 katex 内部。SSE/WS 走自有连接，不存在“HTTP GET 被网关拦截”的层。结论：**没有官方“裸 fetch 自定义路由”先例，但也没有干扰源**；自管路由需宿主半自行注册 `/mcp-manager/*` handler（对齐 `[HMOD serveBundle]` 自定义 `/plugins/` 路由的先例，宿主侧允许插件加自有路由）。
- 凭据：fetch 默认 `credentials:"same-origin"`，回环 cookie 自动携带，无需手工加头；建议响应加 `Content-Type: application/json; charset=utf-8` 并禁缓存（避免 rev 缓存混淆心智）。风险：确保宿主 404 兜底不会吞掉该前缀（选独特前缀已规避）。

## 6. CSS 注入（保守做法，与两家样板逐字同款）
```js
const css = ".mcp-section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}";
const tagId = "@local/dsh-mcp-manager/McpSection.module.css";
if (typeof document !== "undefined" &&
    document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@local/dsh-mcp-manager/ui";   // 或不带 /ui 的包名，保持一致即可
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
```
证据：`[INV :12-19]`、`[GEN :29-36]`、`[PEN ui-pentest.client.js 两处 document.head 块]` 同一模式（`style[data-plugin-css=<tagId>]` 去重 + append head）。系统还有兜底归属逻辑 `claimStyles(id)`：materialize 时给未标 `data-plugin` 的 style 补标（`[MOD :129-139]`）。**卸载/关闭弹层都不必移除**——三家样板都从不移除；惰性 CJS 模型下“副作用活在工厂闭包里”，styles 记录仅供 HMR 盘点（`[MOD :16-23、223-244]`）。

## 7. section 打开时机与数据加载生命周期
- 只渲染激活页：壳 `renderSlot("settings.section",{close},{only:active})`（`[GEN :162-165]`）——打开设置时不预载其他 section，切到我们的 page 才 mount，切走/close 即 unmount。
- 因此 `useState+useEffect([])` 首次挂载拉列表：可靠且天然“每次进入刷新一次”；对照 `[INV :69-82]` 官方同样模式（`Promise.resolve().then(()=>list())` + `current` 标志防竞态 + retry 计数器触发重拉 `[request]` 依赖）——推荐抄这个形状。
- 重连/locale 对组件的影响：我们的数据在自己 state 里，session 重连不回流；locale 只是换 `t` 文案（壳订阅 locale revision 刷新导航 `[GEN :499]`）。注意远程浏览器 `connection.isLoopback=false` 时官方设置功能整体降级 memory 模式（`[GEN :480-481]`、`[SETTINGS 服务面]`），我们的 fetch 属于宿主 HTTP 直连，不受此开关影响，但页面应自处理网络失败态（role:"alert" + 重试按钮，样式见 `[INV failure 块]`）。

## 8. 手写 bundle 工程要点
- CJS 形状逐字仿 `[INV :1-9、295-300]`：`window.__ModuleLoader__.load({ id, factory })`，factory 内建 `module/exports`、末尾 `return module.exports`（导出 `{apply, inject}`，及可选命名导出）。
- 幂等性：重复执行同名 load 会抛 duplicate（`[MOD register:190-194]`）；脚本由 HTML 引导线统一预载（`[HMOD bootInjections]` 产出 facade queue 脚本、preload 标签与 `window.__DSH_BOOT__`），我们只保证文件内容自洽、不重复 load。
- rev=client 文件内容 sha1 前 12 位，改文件自动换 URL 缓存键（`[HMOD shortHash/initialBundleRevision]`）。

## 9. 未决点 / 最大风险
1. `dsh.client.inject` 的确切消费点在 vendored loader（minified `[IDX]`）内，未能逐行核对；省略它有 `[MOD parseBootManifest]` 默认 `[]` + pentest 同域多行运行的旁证，风险低。
2. 我们需新增宿主半 HTTP 路由 `/mcp-manager/*`，其注册 API 在 dsh-web/webserver 宿主面内，本次只验证了“插件可挂自有路由”可行性（serveBundle 先例），具体宿主路由 API 未查——实现宿主半时另行取证。
3. order 相同时排序 tie-break 未定义：坚持唯一值即可规避。
