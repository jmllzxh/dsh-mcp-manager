# @local/dsh-mcp-manager 构建任务书（契约已冻结）

为 DSH 构建一个树外双面插件。所有代码手写、零依赖、不经过打包器。
产物目录：`H:\AI\deepseek\mcp-plugin\`（构建后由指挥官安装到 DSH_HOME）。

## 包结构（必须精确）

```
mcp-plugin/
├── package.json
├── README.md
└── lib/
    ├── index.js     # 宿主半：HTTP CRUD 服务（核心）
    ├── ui.js        # 空 seat：function apply(){} 导出 {apply}
    └── client.js    # 浏览器半：factory bundle（核心）
```

### package.json 精确内容

```json
{
  "name": "@local/dsh-mcp-manager",
  "description": "Web 设置页内管理 DSH 全局 MCP 服务器（~/.dsh/cordis.patch.yml）",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./ui": "./lib/ui.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "client": {
      "platform": "web"
    }
  }
}
```

## 宿主半 lib/index.js

照官方插件形状：

```js
export const inject = ["webServer"];
export function apply(ctx) { /* 注册 prefix 路由，dispose 注销 */ }
```

- `const dispose = ctx.get("webServer").register({ kind: "prefix", path: "/mcp-manager", handler });`
  handler 是 `(req, res) => Promise<void>`，node:http 原生对象。JSON 响应：
  `res.writeHead(200, {"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(payload));`
  错误统一 400/404/500 同样 JSON。
- **回环校验**（全部请求）：`req.socket.remoteAddress` 必须 ∈ {'127.0.0.1','::1','::ffff:127.0.0.1'}，
  否则 403 `{ok:false,error:{code:"forbidden"}}`。
- 路由分派（在 prefix 内再判子路径与 method）：
  - `GET  /mcp-manager/api/state`   → `{ok:true, revision, servers:[...], filePath}`
  - `POST /mcp-manager/api/create`  body=`{server:{...}}`
  - `POST /mcp-manager/api/update`  body=`{id, server:{...}, expectRevision}`
  - `POST /mcp-manager/api/delete`  body=`{id, expectRevision}`
  - 其余 → 404。POST 读体用 for-await chunks 拼 Buffer，限 256KB，超限断开。
- 进程内互斥锁串行化写操作；内存缓存 `{mtimeMs, revision, text}`，
  读时 stat 文件，mtime 变了才重解析。

### 数据模型

MCP 服务器条目（canonical 对象）：

```js
{
  id: "mcp-burp",          // 必须以 "mcp-" 开头，[a-z0-9-] 唯一
  serverName: "burp",      // /^[A-Za-z0-9_-]{1,32}$/，文件内唯一
  transport: "stdio" | "streamable-http",
  command?: string,        // stdio 必填非空
  args?: string[],
  env?: Record<string,string>,
  url?: string,            // streamable-http 必填且 ^https?://
  headers?: Record<string,string>,
  enabled?: boolean        // 序列化为 disabled 取反；缺省 true 不落盘
}
```

校验失败返回 `{ok:false,error:{code:"validation", message:"中文原因"}}`。
id 自动生成：`mcp-` + serverName 小写、非法字符转 `-`、去重加 `-2` 后缀；
调用方也可显式提供 id（update 时忽略传入的新 id）。

### 目标文件

固定路径：`path.join(os.homedir(), ".dsh", "cordis.patch.yml")`。
通过环境变量 `DSH_HOME` 判定优先：`process.env.DSH_HOME || ~/.dsh`。

### 解析器（lib 内实现，约 150 行，严格按本节）

只支持**规范布局**的窄解析；目标文件是我们自己生成的格式 + 用户手工注释。
行级扫描：

- 文件结构 = 头部任意注释/空行 + 若干 `- insert:` 块；
  每个 insert 块含若干条目段（entry segment，连续行，首行缩进 4 空格 `- `，续行缩进 ≥6）。
- 解析每个条目段为键值模型：顶层键 `id`、`name`、`config`（config 下 `transport`,
  `command`, `url`, `serverName` 标量；`args` 为块序列 `- xxx` 行；`env`/`headers`
  为块映射 `k: v` 行；`disabled` 标量 true/false）。
- 标量解析：剥单引号/双引号（'' 与 "" 不做转义折叠——生成端保证内容不含引号字符，
  校验时拒绝值里的 `'` 和 `"`），plain 标量取冒号后剩余 trim。
- **一个条目段能被解释成完整合法 MCP 模型 ⇔ 所有必填键齐全且形状匹配**；
  否则该段保持“不透明”：原样保留行数组，不出现在 servers 里，也不报错
  （用户可能在同一 insert 里放了别的插件行，绝不能破坏它们）。
- 出现无法理解的结构（非注释顶部内容、嵌套异常等）→ 整个读操作失败：
  `{error:{code:"unparsable", message:"..."}}`，写操作同样拒绝对该文件改动。
- 序列化（生成新条目段或重写已编辑段）必须逐字使用此模板（2 空格层级，
  单引号仅在值含特殊 YAML 字符时加）：

```yaml
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: x
        transport: stdio
        command: C:\path\to.exe
        args:
          - '-y'
          - foo
        env: {}
```

  - streamable-http 时以 `url:` 替代 `command:/args:`；headers 输出块映射；
  - `env: {}` 为空时输出流式空 map；`disabled: true` 仅在 enabled=false 时输出；
  - 值一律先过 sanitize：含 `[_url:, '{', '}', '[', ']', ',', '#', ': ']`、
    前导/尾随空白、引号、控制字符者直接校验失败（宁严勿损）。
- **保留语义**：create 在文件末尾最后一个 `- insert:` 块尾追加新段；
  无任何 insert 块（包括全新文件）时生成整份文件：

```yaml
# $DSH_HOME/cordis.patch.yml — home-level user patch layer.
# Managed MCP servers are appended here by @local/dsh-mcp-manager.

- insert:
    - id: mcp-x
      ...
```

  已有文件时头部既有内容（注释、其他段、其他块）字节级保留，
  只增删改属于 MCP 条目的段行。update=定位段→替换段行；delete=删除段行及其前空行。
- 写盘原子化：同目录 tmp 文件写入+fsync+rename 替换；失败清理 tmp。
  写成功后 revision++ 并更新缓存 text。

### 返回 payload 的 servers 元素

只给 UI 需要的字段（canonical 模型本身），另带每项 `_opaque:false` 供未来扩展。

## 浏览器半 lib/client.js

第一行格式（照抄，别改）：

```js
window.__ModuleLoader__.load({
	id: "@local/dsh-mcp-manager/ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```

factory 内部：

```js
let react = require("react");
const h = react.createElement;
```

主体（全用手写函数组件 + hooks；风格参照官方
dsh-client-ui-settings-plugin-inventory：内部 `//#region` 分节注释）：

- `const NS = "settings.mcpManager";`
- 词典（zh 为真源、en 对照，key 集合一致）：
  zh: `{section:"MCP 服务器", title:"MCP 服务器管理", subtitle:"全局生效于所有会话（~/.dsh/cordis.patch.yml），保存后热重载自动挂载。",
    add:"添加服务器", edit:"编辑", delete:"删除", save:"保存", cancel:"取消",
    name:"名称 serverName", transport:"传输方式", command:"命令", args:"参数（每行一个）",
    env:"环境变量（KEY=VALUE，每行一条）", url:"URL", headers:"请求头（KEY: VALUE，每行一条）",
    empty:"暂无 MCP 服务器。", loading:"加载中…", confirmDelete:(n)=>`确定删除 ${n}？`,
    saved:"已保存，正在热重载…", loadError:"读取失败", requestError:"操作失败",
    filePath:"配置文件", invalidName:"名称需 1-32 位字母数字下划线连字符",
    commandRequired:"stdio 需要 command", urlRequired:"http 传输需要合法 URL"}`
- `const inject = ["slots", "locale"];`
- `function apply(ctx)`：
  - `ctx.effect(() => ctx.locale.register(NS, {zh, en}), "mcp-manager: dictionaries");`
  - `const t = ctx.locale.bind(NS);`
  - `ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section", id: "mcp-manager", order: 55,
      locale: NS, label: () => t("section")
    }, McpSection));`
- 组件 `McpSection(props)`（props 含 close，忽略之）：
  - useEffect 首次挂载 fetch `/mcp-manager/api/state`，存 `{servers, revision, filePath}`；
  - 顶部标题+副标题+配置文件路径 `<code>`；
  - 服务器卡片列表：serverName 加粗、transport 徽章、command/url 单行截断
    （`text-overflow:ellipsis`）、右侧 编辑/删除 按钮；
  - 「添加服务器」按钮 → 表单卡（复用编辑表单组件）：字段 name/transport(select)/
    command/args(textarea)/env(textarea)/url/headers(textarea)，transport 切换显隐对应字段；
  - 提交：`splitLines()` 把 textarea 解析回数组/对象（args 按行去空；env 按 `K=V` split('=')，
    首个 '=' 分割；headers 按 `K: V`）；fetch POST update 时带 expectRevision；
  - 成功后显示「已保存，正在热重载…」提示条 2.5 秒并刷新列表与 revision；
    失败显示 error.message 红色条；加载中骨架文案 loading；
  - 删除走 `window.confirm(t("confirmDelete")(name))`；
- 样式全部 inline style，颜色/圆角引用 DSH token 变量：背景 `var(--dsw-alias-bg-layer-2)`
  或 layer-3，边框 `var(--dsw-alias-border-l2)`，文字 `var(--dsw-alias-label-primary/tertiary)`，
  强调 `var(--dsw-alias-state-business-primary)`，错误 `var(--dsw-alias-state-error-primary)`，
  圆角 8-10px，间距 12/14px。容器 `maxWidth:760, width:'100%'`（对齐官方设置页），
  display flex column gap 14。按钮最小样式：padding '6px 12px', border var(--dsw-alias-border-l2),
  borderRadius 8, background transparent, cursor pointer, font inherit。
- 文件末尾（必须）：

```js
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
```

sourceMappingURL 指向不存在的文件无碍（Loader 只警告不阻塞），保持与其他包一致。

## 验收清单（构建者在工作区内自测）

1. `node -e "import('file:///H:/AI/deepseek/mcp-plugin/lib/index.js').then(m=>console.log(Object.keys(m)))"`
   输出含 inject/apply；client.js 用 `node --check` 通过语法检查。
2. 写一个临时脚本把 index.js 的解析器/序列化器抽出来测 round-trip：
   对 `~\.dsh\cordis.patch.yml` 当前真实内容跑 parse→serialize(no edit)→parse，
   断言第二次模型与第一次相等、且未触发 unparsable；（只读测试，不许写那个文件！）
   再构造临时字符串：追加一个假条目→改它→删它→断言其余部分逐字节不变
   （比较原始切片）。临时文件放系统 temp 目录。
3. README.md 写清：这个包是什么、安装在哪、行如何挂载、如何卸载（删两处 junction + 补丁行）。

完成后最终回复：文件清单 + 自测三项结果一句话 + 未决风险一行。不要安装到 DSH_HOME。
