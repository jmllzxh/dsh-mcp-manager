window.__ModuleLoader__.load({
	id: "@local/dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const h = react.createElement;

		//#region 常量与词典（zh 为真源、en 对照，key 集合一致）
		const NS = "settings.mcpManager";

		const zh = {
			section: "MCP 服务器",
			title: "MCP 服务器管理",
			subtitle: "全局生效于所有会话（~/.dsh/cordis.patch.yml），保存后热重载自动挂载。",
			add: "添加服务器",
			edit: "编辑",
			delete: "删除",
			save: "保存",
			cancel: "取消",
			name: "名称 serverName",
			transport: "传输方式",
			command: "命令",
			args: "参数（每行一个）",
			env: "环境变量（KEY=VALUE，每行一条）",
			url: "URL",
			headers: "请求头（KEY: VALUE，每行一条）",
			empty: "暂无 MCP 服务器。",
			loading: "加载中…",
			confirmDelete: "确定删除 {name}？",
			saved: "已保存，正在热重载…",
			confirmYes: "确认删除",
			loadError: "读取失败",
			requestError: "操作失败",
			filePath: "配置文件",
			invalidName: "名称需 1-32 位字母数字下划线连字符",
			commandRequired: "stdio 需要 command",
			urlRequired: "http 传输需要合法 URL",
		};
		const en = {
			section: "MCP Servers",
			title: "MCP Server Manager",
			subtitle: "Applies globally to all sessions (~/.dsh/cordis.patch.yml). Changes hot-reload after save.",
			add: "Add server",
			edit: "Edit",
			delete: "Delete",
			save: "Save",
			cancel: "Cancel",
			name: "Name (serverName)",
			transport: "Transport",
			command: "Command",
			args: "Arguments (one per line)",
			env: "Environment variables (KEY=VALUE, one per line)",
			url: "URL",
			headers: "Headers (KEY: VALUE, one per line)",
			empty: "No MCP servers yet.",
			loading: "Loading…",
			confirmDelete: "Delete {name}?",
			saved: "Saved. Hot-reloading…",
			confirmYes: "Confirm delete",
			loadError: "Failed to load",
			requestError: "Request failed",
			filePath: "Config file",
			invalidName: "Name must be 1-32 chars of letters/digits/underscore/hyphen",
			commandRequired: "stdio transport requires a command",
			urlRequired: "streamable-http requires a valid URL",
		};

		let _boundT = null;
		const t = (key, ...rest) => {
			let v = null;
			if (_boundT) {
				try {
					v = _boundT(key);
				} catch {
					v = undefined;
				}
			}
			if (v === undefined || v === null) v = zh[key]; // 兜底回退到 zh 真源
			return typeof v === "function" ? v(...rest) : v;
		};

		const COLORS = {
			layer2: "var(--dsw-alias-bg-layer-2)",
			layer3: "var(--dsw-alias-bg-layer-3)",
			border: "var(--dsw-alias-border-l2)",
			labelPrimary: "var(--dsw-alias-label-primary)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary)",
			business: "var(--dsw-alias-state-business-primary)",
			error: "var(--dsw-alias-state-error-primary)",
		};
		//#endregion

		//#region 小工具：textarea 行解析（splitLines 家族）
		function splitLinesToRows(text) {
			return String(text == null ? "" : text)
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		}

		function splitKVPairs(text, sep) {
			const out = {};
			for (const line of splitLinesToRows(text)) {
				const i = line.indexOf(sep);
				if (i <= 0) continue; // 无分隔符的残行跳过
				const k = line.slice(0, i).trim();
				const v = line.slice(i + sep.length).trim();
				if (k) out[k] = v;
			}
			return out;
		}

		const API = {
			state: () => fetch("/mcp-manager/api/state").then((r) => r.json()),
			create: (server) =>
				fetch("/mcp-manager/api/create", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ server }),
				}).then((r) => r.json()),
			update: (id, server, expectRevision) =>
				fetch("/mcp-manager/api/update", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id, server, expectRevision }),
				}).then((r) => r.json()),
			remove: (id, expectRevision) =>
				fetch("/mcp-manager/api/delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id, expectRevision }),
				}).then((r) => r.json()),
		};

		async function callApi(promiseFactory, onError) {
			try {
				const resp = await promiseFactory();
				if (!resp || resp.ok !== true) {
					throw new Error((resp && resp.error && resp.error.message) || t("requestError"));
				}
				return resp;
			} catch (e) {
				onError(String((e && e.message) || e));
				return null;
			}
		}
		//#endregion

		//#region 样式基元
		const BTN = {
			padding: "6px 12px",
			border: "1px solid " + COLORS.border,
			borderRadius: 8,
			background: "transparent",
			cursor: "pointer",
			font: "inherit",
			color: COLORS.labelSecondary,
		};
		const BTN_PRIMARY = { ...BTN, color: COLORS.business, borderColor: COLORS.business };
		const BTN_DANGER = { ...BTN, color: COLORS.error, borderColor: COLORS.error };
		const INPUT = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 10px",
			borderRadius: 8,
			border: "1px solid " + COLORS.border,
			background: COLORS.layer3,
			color: COLORS.labelPrimary,
			font: "inherit",
			fontSize: 13,
			outline: "none",
		};
		const TEXTAREA = { ...INPUT, resize: "vertical", minHeight: 52, fontFamily: "inherit", lineHeight: 1.5 };
		const CARD = {
			background: COLORS.layer2,
			border: "1px solid " + COLORS.border,
			borderRadius: 10,
			padding: "12px 14px",
		};
		const LABEL = { fontSize: 12, color: COLORS.labelTertiary, marginBottom: 4 };
		const BADGE = {
			fontSize: 11,
			color: COLORS.business,
			border: "1px solid " + COLORS.business,
			borderRadius: 8,
			padding: "0 8px",
			lineHeight: "18px",
		};
		const ROW = (extra) => ({ display: "flex", alignItems: "center", gap: 12, ...(extra || {}) });
		//#endregion

		//#region 表单组件（添加/编辑共用）
		function formStateFrom(server) {
			if (!server) {
				return { name: "", transport: "stdio", command: "", argsText: "", envText: "", url: "", headersText: "" };
			}
			return {
				name: server.serverName || "",
				transport: server.transport || "stdio",
				command: server.command || "",
				argsText: Array.isArray(server.args) ? server.args.join("\n") : "",
				envText: Object.keys(server.env || {})
					.map((k) => k + "=" + server.env[k])
					.join("\n"),
				url: server.url || "",
				headersText: Object.keys(server.headers || {})
					.map((k) => k + ": " + server.headers[k])
					.join("\n"),
			};
		}

		function payloadFromState(f) {
			const server = {
				serverName: f.name.trim(),
				transport: f.transport,
				enabled: true,
			};
			if (f.transport === "stdio") {
				server.command = f.command.trim();
				server.args = splitLinesToRows(f.argsText);
			} else {
				server.url = f.url.trim();
				server.headers = splitKVPairs(f.headersText, ":");
			}
			server.env = splitKVPairs(f.envText, "=");
			return server;
		}

		function validatePayload(server) {
			const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
			if (!NAME_RE.test(server.serverName)) return t("invalidName");
			if (server.transport === "stdio") {
				if (String(server.command || "").trim().length === 0) return t("commandRequired");
			} else {
				if (!/^https?:\/\//.test(server.url)) return t("urlRequired");
			}
			return null;
		}

		function ServerForm({ onCancel, onDone }) {
			const [f, setF] = react.useState(() => formStateFrom(null));
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState(null);
			const patch = (kv) => setF((prev) => ({ ...prev, ...kv }));

			const submit = async () => {
				const server = payloadFromState(f);
				const bad = validatePayload(server);
				if (bad) {
					setErr(bad);
					return;
				}
				setBusy(true);
				setErr(null);
				const resp = await callApi(() => API.create(server), setErr);
				setBusy(false);
				if (resp) onDone();
			};

			const field = (labelText, node) =>
				h(
					"label",
					{ style: { display: "block" } },
					h("div", { style: LABEL }, labelText),
					node
				);

			return h(
				"div",
				{ style: { ...CARD, display: "flex", flexDirection: "column", gap: 12 } },
				h(
					"div",
					{ style: ROW() },
					field(
						t("name"),
						h("input", {
							style: { ...INPUT, flex: 1 },
							value: f.name,
							onChange: (e) => patch({ name: e.target.value }),
							placeholder: "burp",
							maxLength: 32,
						})
					),
					field(
						t("transport"),
						h(
							"select",
							{
								style: { ...INPUT, width: "auto", minWidth: 160 },
								value: f.transport,
								onChange: (e) => patch({ transport: e.target.value }),
							},
							h("option", { value: "stdio" }, "stdio"),
							h("option", { value: "streamable-http" }, "streamable-http")
						)
					)
				),
				f.transport === "stdio"
					? h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 12 } },
							field(
								t("command"),
								h("input", {
									style: INPUT,
									value: f.command,
									onChange: (e) => patch({ command: e.target.value }),
									placeholder: "C:\\path\\to.exe",
								})
							),
							field(
								t("args"),
								h("textarea", {
									style: TEXTAREA,
									rows: 3,
									value: f.argsText,
									onChange: (e) => patch({ argsText: e.target.value }),
								})
							)
						)
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 12 } },
							field(
								t("url"),
								h("input", {
									style: INPUT,
									value: f.url,
									onChange: (e) => patch({ url: e.target.value }),
									placeholder: "http://127.0.0.1:8080/mcp",
								})
							),
							field(
								t("headers"),
								h("textarea", {
									style: TEXTAREA,
									rows: 3,
									value: f.headersText,
									onChange: (e) => patch({ headersText: e.target.value }),
								})
							)
						),
				field(
					t("env"),
					h("textarea", {
						style: TEXTAREA,
						rows: 3,
						value: f.envText,
						onChange: (e) => patch({ envText: e.target.value }),
						placeholder: "FOO=bar",
					})
				),
				err ? h("div", { style: { color: COLORS.error, fontSize: 12 } }, err) : null,
				h(
					"div",
					{ style: ROW({ justifyContent: "flex-end" }) },
					h("button", { style: BTN, onClick: onCancel }, t("cancel")),
					h("button", { style: BTN_PRIMARY, onClick: submit, disabled: busy }, t("save"))
				)
			);
		}

		// 编辑表单：与添加共用渲染，但提交走 update 并携带 expectRevision。
		function EditInner({ server, revision, onCancel, onDone }) {
			const [f, setF] = react.useState(() => formStateFrom(server));
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState(null);
			const patch = (kv) => setF((prev) => ({ ...prev, ...kv }));

			const submit = async () => {
				const payload = payloadFromState(f);
				payload.id = undefined; // 后端忽略新 id，仅按旧 id 定位
				delete payload.id;
				const bad = validatePayload(payload);
				if (bad) {
					setErr(bad);
					return;
				}
				setBusy(true);
				setErr(null);
				const resp = await callApi(() => API.update(server.id, payload, revision), setErr);
				setBusy(false);
				if (resp) onDone();
			};

			const field = (labelText, node) =>
				h(
					"label",
					{ style: { display: "block" } },
					h("div", { style: LABEL }, labelText),
					node
				);

			return h(
				"div",
				{ style: { ...CARD, display: "flex", flexDirection: "column", gap: 12 } },
				h(
					"div",
					{ style: ROW() },
					field(
						t("name"),
						h("input", {
							style: { ...INPUT, flex: 1 },
							value: f.name,
							onChange: (e) => patch({ name: e.target.value }),
							maxLength: 32,
						})
					),
					field(
						t("transport"),
						h(
							"select",
							{
								style: { ...INPUT, width: "auto", minWidth: 160 },
								value: f.transport,
								onChange: (e) => patch({ transport: e.target.value }),
							},
							h("option", { value: "stdio" }, "stdio"),
							h("option", { value: "streamable-http" }, "streamable-http")
						)
					)
				),
				f.transport === "stdio"
					? h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 12 } },
							field(
								t("command"),
								h("input", {
									style: INPUT,
									value: f.command,
									onChange: (e) => patch({ command: e.target.value }),
								})
							),
							field(
								t("args"),
								h("textarea", {
									style: TEXTAREA,
									rows: 3,
									value: f.argsText,
									onChange: (e) => patch({ argsText: e.target.value }),
								})
							)
						)
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 12 } },
							field(
								t("url"),
								h("input", {
									style: INPUT,
									value: f.url,
									onChange: (e) => patch({ url: e.target.value }),
								})
							),
							field(
								t("headers"),
								h("textarea", {
									style: TEXTAREA,
									rows: 3,
									value: f.headersText,
									onChange: (e) => patch({ headersText: e.target.value }),
								})
							)
						),
				field(
					t("env"),
					h("textarea", {
						style: TEXTAREA,
						rows: 3,
						value: f.envText,
						onChange: (e) => patch({ envText: e.target.value }),
					})
				),
				err ? h("div", { style: { color: COLORS.error, fontSize: 12 } }, err) : null,
				h(
					"div",
					{ style: ROW({ justifyContent: "flex-end" }) },
					h("button", { style: BTN, onClick: onCancel }, t("cancel")),
					h("button", { style: BTN_PRIMARY, onClick: submit, disabled: busy }, t("save"))
				)
			);
		}
		//#endregion

		//#region 服务器卡片
		function ServerCard({ server, onEdit, pendingDelete, onRequestDelete, onCancelDelete, onConfirmDelete }) {
			const detail =
				server.transport === "stdio"
					? [server.command].concat(Array.isArray(server.args) ? server.args : []).join(" ")
					: server.url;
			// 确认文案防御化：支持字符串模板 {name}（locale.bind 安全）与旧版函数
			// 两种词典形态；缺失时退回裸名字，绝不因词典管线抛错。
			const rawAsk = t("confirmDelete");
			const askText =
				typeof rawAsk === "function"
					? String(rawAsk(server.serverName))
					: String(rawAsk == null ? "{name}" : rawAsk).replace("{name}", server.serverName);
			const confirmStyle = {
				padding: "6px 12px",
				borderRadius: 8,
				cursor: "pointer",
				font: "inherit",
				background: COLORS.error,
				color: "#fff",
				border: "1px solid " + COLORS.error,
			};
			return h(
				"div",
				{ style: { ...CARD, display: "flex", flexDirection: "column", gap: 10 } },
				h(
					"div",
					{ style: ROW() },
					h(
						"div",
						{ style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 } },
						h(
							"div",
							{ style: ROW({ gap: 8 }) },
							h(
								"span",
								{
									style: { fontWeight: 700, fontSize: 13, color: COLORS.labelPrimary },
								},
								server.serverName
							),
							h("span", { style: BADGE }, server.transport),
							server.enabled === false
								? h("span", { style: { ...BADGE, color: COLORS.labelTertiary, borderColor: COLORS.border } }, "disabled")
								: null
						),
						h(
							"code",
							{
								title: detail,
								style: {
									fontSize: 12,
									color: COLORS.labelTertiary,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
									display: "block",
								},
							},
							detail
						)
					),
					h("button", { style: BTN, onClick: onEdit }, t("edit")),
					h("button", { style: BTN_DANGER, onClick: onRequestDelete }, t("delete"))
				),
				pendingDelete
					? h(
							"div",
							{ style: ROW({ justifyContent: "flex-end", borderTop: "1px dashed " + COLORS.error, paddingTop: 10 }) },
							h(
								"span",
								{ style: { fontSize: 12, color: COLORS.error, marginRight: "auto" } },
								askText
							),
							h("button", { style: BTN, onClick: onCancelDelete }, t("cancel")),
							h("button", { style: confirmStyle, onClick: onConfirmDelete }, t("confirmYes"))
						)
					: null
			);
		}
		//#endregion

		//#region 设置页分区组件
		function McpSection(props) {
			// props.close 由设置页注入，本组件忽略之。
			const [data, setData] = react.useState(null); // {servers, revision, filePath}
			const [revision, setRevision] = react.useState(null);
			const [loadErr, setLoadErr] = react.useState(null);
			const [actErr, setActErr] = react.useState(null);
			const [editing, setEditing] = react.useState(null); // {mode:'create'} | {mode:'edit', server}
			const [pendingDeleteId, setPendingDeleteId] = react.useState(null);
			const [flashUntil, setFlashUntil] = react.useState(0);
			const [, forceTick] = react.useState(0);
			const mountedRef = react.useRef(true);

			react.useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);

			const applyResult = (resp) => {
				setData({ servers: resp.servers || [], filePath: resp.filePath || "" });
				setRevision(resp.revision);
			};

			const refresh = react.useCallback(async () => {
				const resp = await callApi(API.state, (msg) => {
					if (mountedRef.current) setLoadErr(t("loadError") + "：" + msg);
				});
				if (resp && mountedRef.current) {
					setLoadErr(null);
					applyResult(resp);
				}
			}, []);

			react.useEffect(() => {
				refresh();
			}, [refresh]);

			// 成功提示条：2.5 秒后消失。
			const showFlash = () => {
				setFlashUntil(Date.now() + 2500);
				setTimeout(() => {
					if (mountedRef.current) forceTick((n) => n + 1);
				}, 2600);
			};
			const flashing = Date.now() < flashUntil;

			const finishOp = async () => {
				setEditing(null);
				showFlash();
				await refresh();
			};

			const deleteServer = async (server) => {
				// 页内两段式确认由 ServerCard 的行内确认行承担；不依赖原生
				// window.confirm——沙箱 iframe / webview 会静默拦截原生模态框。
				setActErr(null);
				const resp = await callApi(() => API.remove(server.id, revision), setActErr);
				if (resp) {
					setPendingDeleteId(null);
					await finishOp();
				}
			};

			const children = [];
			children.push(
				h(
					"div",
					{ key: "head", style: ROW({ justifyContent: "space-between" }) },
					h(
						"div",
						{ style: { minWidth: 0 } },
						h(
							"div",
							{ style: { fontWeight: 600, fontSize: 16, color: COLORS.labelPrimary } },
							t("title")
						),
						h(
							"div",
							{ style: { fontSize: 12, color: COLORS.labelTertiary, marginTop: 4, lineHeight: 1.6 } },
							t("subtitle")
						)
					),
					data
						? h(
								"button",
								{
									key: "add",
									style: BTN_PRIMARY,
									onClick: () => setEditing({ mode: "create" }),
								},
								t("add")
							)
						: null
				)
			);

			if (data && data.filePath) {
				children.push(
					h(
						"div",
						{ key: "file", style: { fontSize: 12, color: COLORS.labelTertiary, ...ROW({ gap: 6 }) } },
						h("span", null, t("filePath")),
						h(
							"code",
							{
								style: {
									fontSize: 12,
									background: COLORS.layer3,
									border: "1px solid " + COLORS.border,
									borderRadius: 8,
									padding: "2px 8px",
									wordBreak: "break-all",
									color: COLORS.labelSecondary,
								},
							},
							data.filePath
						)
					)
				);
			}

			if (!data && !loadErr) {
				children.push(h("div", { key: "loading", style: { color: COLORS.labelTertiary, fontSize: 13 } }, t("loading")));
			}

			if (loadErr) {
				children.push(
					h(
						"div",
						{
							key: "lerr",
							role: "alert",
							style: { color: COLORS.error, fontSize: 12, border: "1px dashed " + COLORS.error, borderRadius: 8, padding: "8px 10px" },
						},
						loadErr
					)
				);
			}
			if (actErr) {
				children.push(
					h(
						"div",
						{
							key: "aerr",
							role: "alert",
							style: { color: COLORS.error, fontSize: 12, background: COLORS.layer2, borderLeft: "3px solid " + COLORS.error, padding: "8px 10px", borderRadius: 8 },
						},
						actErr
					)
				);
			}
			if (flashing) {
				children.push(
					h(
						"div",
						{
							key: "flash",
							style: { color: COLORS.business, fontSize: 12, border: "1px solid " + COLORS.business, borderRadius: 8, padding: "8px 10px" },
						},
						t("saved")
					)
				);
			}

			if (editing && editing.mode === "create") {
				children.push(h(ServerForm, { key: "form-create", onCancel: () => setEditing(null), onDone: finishOp }));
			}
			if (editing && editing.mode === "edit") {
				children.push(
					h(EditInner, {
						key: "form-edit-" + editing.server.id,
						server: editing.server,
						revision,
						onCancel: () => setEditing(null),
						onDone: finishOp,
					})
				);
			}

			const servers = (data && data.servers) || [];
			if (data && servers.length === 0) {
				children.push(h("div", { key: "empty", style: { color: COLORS.labelTertiary, fontSize: 13 } }, t("empty")));
			}
			servers.forEach((sv) => {
				children.push(
					h(ServerCard, {
						key: sv.id,
						server: sv,
						onEdit: () => setEditing({ mode: "edit", server: sv }),
						pendingDelete: pendingDeleteId === sv.id,
						onRequestDelete: () => {
							setActErr(null);
							setPendingDeleteId(sv.id);
						},
						onCancelDelete: () => setPendingDeleteId(null),
						onConfirmDelete: () => deleteServer(sv),
					})
				);
			});

			return h(
				"div",
				{
					style: {
						maxWidth: 760,
						width: "100%",
						display: "flex",
						flexDirection: "column",
						gap: 14,
					},
				},
				children
			);
		}
		//#endregion

		//#region 错误边界：任何渲染异常只降级为面板内提示，绝不拖垮整个设置页
		class SectionErrorBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { err: null };
			}
			static getDerivedStateFromError(e) {
				return { err: e };
			}
			componentDidCatch(e, info) {
				try {
					// eslint-disable-next-line no-console
					console.error("[mcp-manager] 渲染异常:", e, info && info.componentStack);
				} catch {}
			}
			render() {
				if (this.state.err) {
					const msg = String((this.state.err && this.state.err.message) || this.state.err);
					return h(
						"div",
						{
							role: "alert",
							style: { color: COLORS.error, fontSize: 12, border: "1px dashed " + COLORS.error, borderRadius: 8, padding: "8px 10px" },
						},
						"MCP 服务器面板渲染出错（可刷新重试）：" + msg
					);
				}
				return h(McpSection, this.props);
			}
		}
		//#endregion

		//#region 插件入口
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "mcp-manager: dictionaries");
			_boundT = ctx.locale.bind(NS);
			const tt = _boundT;
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "mcp-manager",
						order: 40,
						locale: NS,
						label: () => tt("section"),
					},
					SectionErrorBoundary // 渲染异常降级为面板内提示，不拖垮设置页
				)
			);
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
