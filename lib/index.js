/**
 * dsh-sandbox-legacy-acl · 宿主半（单文件，零外部依赖）
 *
 * ## 做什么
 *
 * 让 0.1.7 运行时的 Windows ACL 沙箱**只写能力 ACE**：
 *
 *   0.1.5  授权工作区时只写「能力 SID 的允许 ACE」（S-1-4-x-y:(OI)(CI)(W,D,DC)）
 *   0.1.7  同一次授权还会多写两条，且永不自动撤销：
 *            · Everyone:(CI)(DENY)(DC)                      ← world 删除拒绝
 *            · Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)  ← 低完整性标签
 *
 * 后两条会让文件在资源管理器里删不掉、Explorer 预览失败或提示「这些文件可能有
 * 害」、标签还会继承外溢到新建文件。本插件把这两条去掉，回到 0.1.5 的形态。
 *
 * ## vendor 的版本策略（2026-09-30 修正）
 *
 * 早先 vendor 放的是 **0.1.5-rc.3 整包** —— 那是一个错误。0.1.7 的 run_code
 * worker 是独立 Node 进程，靠 **fd 7（control channel）** 与主进程通信，而 0.1.5
 * 的 `spawnSandboxedInherited` 不支持 `controlFileDescriptor`（0.1.5 包内命中
 * **0** 次）→ 受限 spawn 出来的 worker 拿不到合法 fd，`node:net` 抛
 * `ERR_INVALID_FD_TYPE`，**整条工具链（read / write / pwsh 全走 run_code）瘫痪**。
 *
 * 现在 vendor = **0.1.7-rc.2 的 dsh-sandbox-windows-acl + dsh-win32-process（整包）**
 * + **dsh-lazy-require 与 dsh-subprocess/lib/control.js（0.1.7 新增的两个依赖）**，
 * 由插件打两处补丁（逐行对照见 vendor/legacy-acl/PATCH-NOTES.md）：
 *
 *   补丁 A  删掉 `restrictTokenIntegrity(...)` 的定义与调用 —— 令牌保持 Medium。
 *   补丁 B  `grantWrite` 只写能力 SID 的 allow ACE —— 去掉 Low 强制标签与
 *           Everyone 的 FILE_DELETE_CHILD 拒绝；`revokeWrite` 也不再依赖共享标签。
 *
 * 于是 **seam 与 runner 出自同一份补丁过的包**，control-fd 能力完整保留。
 *
 * ## 怎么做的（两个改点）
 *
 * 补丁只改了 vendor 里的**一份**包；插件要让它真正生效，需要覆盖两个执行体：
 *
 *   ① **ACE 写入**发生在 seam 进程内的 dsh-sandbox-local
 *      `LocalSandboxProvider.materializeAclGrant()` → `AclWriteGrant.add()`。
 *      本插件用实例属性覆盖该方法，改调 **vendor 里这份补丁过的 AclWriteGrant**
 *      （它的 add() 只写能力 ACE）。
 *
 *   ② **runner 进程**由 provider 的 test seam `internals.windowsAclRunnerArgs`
 *      指向 **vendor 的 lib/runner.js**（同一个补丁包里的 runner），令牌完整性
 *      降级因此在 runner 侧也不再发生。
 *
 * ⚠️ 仍然**必须成对**：只改 ① 会让目录有 ACE 却没有 Low 标签，而 runner 仍把令牌
 * 降到 Low —— no-write-up 之下写入静默失败（比不做还糟）。所以本插件是**原子**的：
 * 任一前置检查不通过就**一处都不改**，并落盘写明原因。前置检查里有一条**硬门槛**：
 * vendor 的 runner 必须支持 control fd（源码里出现 `controlFileDescriptor`），
 * 否则拒绝接管 —— 绝不允许「接管了但 run_code 坏掉」。
 *
 * ## 关闭开关
 *
 *   DSH_LEGACY_ACL=0   → 完全不接管（便于回滚，等价于把插件禁用）
 *
 * ## 可观测性
 *
 * 全部结论落盘到 `$DSH_HOME/sandbox-legacy-acl/report.json`（DSH_HOME 缺失时退到
 * cwd）。**不注册 /api 路由**：少一个失败面，且 curl 那条本来就要会话令牌。
 * 报告里带 probeVersion，字段结构变化时 +1。
 *
 * ## 红线
 *
 *   · **绝不抛**：宿主半抛错会让整棵插件树装载失败。一切失败都 try/catch + 落盘。
 *   · **不接管就一个字都不改**：前置检查失败时保持 DSH 原生（0.1.7）行为。
 *   · 不改 DSH 自己的文件，不 import `@deepseek-ai/*`（profile 的 node_modules
 *     里没有该 scope），只走相对路径的 vendor 副本。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 插件名（cordis 插件标识）。 */
export const name = "sandbox-legacy-acl";

/** 只为 `ctx.get("sandbox")` 而注入；服务就绪时回调才触发。 */
export const inject = ["sandbox"];

/** 报告结构版本；字段结构一变就 +1（客户端/人工读报告时用它判兼容）。
 *  v2：新增 `vendor.patched` / `vendor.patchSemantics` / `vendor.controlFdRequired`
 *      与 `preflight.fields.controlFd`（control-fd 硬门槛的扫描结果）。 */
const PROBE_VERSION = 2;

/** 关闭开关：`DSH_LEGACY_ACL=0` 时完全不接管。 */
const ENABLED = process.env.DSH_LEGACY_ACL !== "0";

const VENDOR_DIR = fileURLToPath(new URL("../vendor/", import.meta.url));
const ACL_ENTRY = fileURLToPath(new URL("../vendor/legacy-acl/lib/index.js", import.meta.url));
const ACL_RUNNER = fileURLToPath(new URL("../vendor/legacy-acl/lib/runner.js", import.meta.url));
const ACL_TYPES = fileURLToPath(new URL("../vendor/legacy-acl/lib/types-DxezulnA.js", import.meta.url));
/** vendor 的两处实现目录：control-fd 硬检查扫这两处（只扫 .js）。 */
const ACL_LIB_DIR = fileURLToPath(new URL("../vendor/legacy-acl/lib/", import.meta.url));
const WIN32_LIB_DIR = fileURLToPath(new URL("../vendor/win32-process/lib/", import.meta.url));
const ACL_PKG = fileURLToPath(new URL("../vendor/legacy-acl/package.json", import.meta.url));
const WIN32_PROCESS_ENTRY = fileURLToPath(new URL("../vendor/win32-process/lib/index.js", import.meta.url));
const KOFFI_ENTRY = fileURLToPath(new URL("../vendor/koffi/index.js", import.meta.url));
/** `@koromix/koffi-win32-x64`：koffi 按 `import.meta.dirname/../../../@koromix/…` 找原生库，
 *  这正是把 koffi 放在 `vendor/koffi`、平台包放在 `vendor/@koromix/` 的原因。 */
const KOFFI_NATIVE = fileURLToPath(new URL("../vendor/@koromix/koffi-win32-x64/win32_x64/koffi.node", import.meta.url));

const REPORT_DIR = join(process.env.DSH_HOME ?? process.cwd(), "sandbox-legacy-acl");
const REPORT_PATH = join(REPORT_DIR, "report.json");

/** vendor 侧要覆盖的导出契约（缺任何一个都拒绝接管）。 */
const REQUIRED_EXPORTS = ["AclWriteGrant", "AclSandbox", "assertTempRootOutsideWorkspace", "tempWriteSid", "workspaceWriteSid"];

/**
 * run_code 的回归防线：worker 是独立 Node 进程，靠 **fd 7（control channel）**
 * 与主进程通信，只有 runner 把 `controlFileDescriptor` 交给受限 spawn 才成立。
 * 0.1.5 的包命中 **0** 次（换上它 → `ERR_INVALID_FD_TYPE`，read / write / pwsh
 * 全瘫），0.1.7-rc.2 的 ACL 包里命中 **5** 次（runner 1 + types 4）。
 * 达不到门槛就**拒绝接管** —— 绝不允许「接管了但 run_code 坏掉」。
 */
const CONTROL_FD_MARKER = "controlFileDescriptor";
const CONTROL_FD_CALL_SHAPE = "controlFileDescriptor: options.controlFileDescriptor";
const CONTROL_FD_MIN_HITS = 3;

/** 进程内状态：每次变化都整体落盘。 */
const state = {
	probeVersion: PROBE_VERSION,
	plugin: "dsh-sandbox-legacy-acl",
	pluginVersion: readJsonField(fileURLToPath(new URL("./package.json", import.meta.url)), "version"),
	startedAt: new Date().toISOString(),
	node: process.version,
	execPath: process.execPath,
	host: { version: hostVersion() },
	enabled: ENABLED,
	status: ENABLED ? "init" : "disabled",
	reason: ENABLED ? null : "DSH_LEGACY_ACL=0 — 完全不接管（回滚开关）",
	vendor: {
		dir: VENDOR_DIR,
		aclVersion: readJsonField(ACL_PKG, "version"),
		entry: ACL_ENTRY,
		runner: ACL_RUNNER,
		types: ACL_TYPES,
		win32Process: WIN32_PROCESS_ENTRY,
		koffi: KOFFI_ENTRY,
		koffiNative: KOFFI_NATIVE,
		patched: true,
		patchSemantics: "0.1.7-rc.2 + 补丁 A（不降级令牌完整性）+ 补丁 B（grantWrite 只写能力 ACE）；"
			+ "0.1.7-rc.2 / 0.2.0-rc.2 两代接管契约相同（materializeAclGrant 2/2 · internals.windowsAclRunnerArgs 1/1 · internals 13/13；被替换核心符号计数逐项一致），同一份 vendor 跨两代通用，不做版本分流",
		controlFdRequired: CONTROL_FD_MIN_HITS,
	},
	provider: null,
	override: null,
	preflight: null,
	decisions: [],
	failures: [],
};

/** 读一个 JSON 文件的某字段，失败返回 null（报告用，绝不抛）。 */
function readJsonField(path, field) {
	try {
		return JSON.parse(readFileSync(path, "utf8"))[field] ?? null;
	} catch {
		return null;
	}
}

/** 宿主版本（尽力而为：拿不到返回 null，绝不抛）。0.1.7 / 0.2.0 两代的诊断字段。
 *  来源只有一处：`$DSH_HOME` 的末级目录名（实测 execPath 指向系统 node，不含 versions 路径，故不用它）。
 *  DSH_HOME 缺失或格式不符时返回 null —— 报告少一个字段，功能不受影响。 */
function hostVersion() {
	try {
		const home = process.env.DSH_HOME;
		if (typeof home === "string" && home.length > 0) {
			const m = home.match(/[\\/]homes[\\/]([^\\/]+)[\\/]?$/u);
			if (m !== null && m[1]) return m[1];
		}
	} catch { /* 任何异常都不影响接管 */ }
	return null;
}

/** 落盘 + 记日志；两者都尽力而为，绝不抛。 */
function report(ctx, note) {
	if (ctx !== undefined && note !== undefined) state.decisions.push({ at: new Date().toISOString(), event: note });
	if (state.decisions.length > 200) state.decisions.splice(0, state.decisions.length - 200);
	try {
		mkdirSync(REPORT_DIR, { recursive: true });
		writeFileSync(REPORT_PATH, JSON.stringify(state, null, 2), "utf8");
	} catch (error) {
		try { ctx?.logger?.warn?.(`sandbox-legacy-acl: report write failed: ${String(error)}`); } catch { /* 日志本身也失败了 */ }
	}
}

/** 记一次失败：进 failures 数组 + 日志 + 落盘。 */
function recordFailure(ctx, phase, error) {
	state.failures.push({ at: new Date().toISOString(), phase, message: error instanceof Error ? error.message : String(error) });
	try { ctx?.logger?.warn?.(`sandbox-legacy-acl: ${phase} failed: ${String(error)}`); } catch { /* ignore */ }
}

/**
 * control-fd 门槛的判定（与扫描分开：离线自检要直接喂样本做反向控制）。
 * @param controlFd - 扫描结果 `{ hits, callShape, minHits }`。
 * @returns 问题描述数组（空数组 = 通过）。
 */
function controlFdProblems(controlFd) {
	const problems = [];
	if (controlFd.hits < CONTROL_FD_MIN_HITS) problems.push(`vendor runner 不支持 control fd（源码里 "${CONTROL_FD_MARKER}" 命中 ${controlFd.hits} 次，门槛 ${CONTROL_FD_MIN_HITS}）—— 接管会让 run_code 的 worker 起不来（ERR_INVALID_FD_TYPE），拒绝接管`);
	if (controlFd.callShape < 1) problems.push(`vendor 实现里找不到 control fd 的传递形态 "${CONTROL_FD_CALL_SHAPE}" —— 只有声明没有使用，拒绝接管`);
	return problems;
}

/**
 * 接管前的前置检查。
 *
 * 检查面覆盖三类：「vendor 文件在不在」/「vendor runner 有没有 control fd 能力」
 * /「provider 的私有字段形状对不对」。第二类是 run_code 回归的防线（见
 * CONTROL_FD_MARKER 的注释）；字段名取自 0.1.7 dsh-sandbox-local/lib/index.js:392-478
 * 的实测原文（`this.workspaceGrants` / `this.tempCapabilities` /
 * `this.removeTempDir` / `this.internals`）。
 * @param provider - ctx.sandbox 实例。
 * @returns { problems: string[], fields: object } —— problems 非空即拒绝接管。
 */
function preflight(provider) {
	const problems = [];
	const fields = {};
	for (const [label, path] of [["aclEntry", ACL_ENTRY], ["aclRunner", ACL_RUNNER], ["aclTypes", ACL_TYPES], ["win32Process", WIN32_PROCESS_ENTRY], ["koffi", KOFFI_ENTRY], ["koffiNative", KOFFI_NATIVE]]) {
		const exists = existsSync(path);
		fields[label] = exists;
		if (!exists) problems.push(`vendor file missing: ${label} (${path})`);
	}
	// —— control-fd 硬门槛（回归防线）——
	// 检查的是**源码文本**：0.1.5 的包一个 controlFileDescriptor 都没有，换上它
	// 会让 run_code 的 worker 起不来。不满足就拒绝接管，保持 0.1.7 原生行为。
	const controlFd = { files: [], hits: 0, callShape: 0, minHits: CONTROL_FD_MIN_HITS };
	for (const [label, dir] of [["aclLib", ACL_LIB_DIR], ["win32Lib", WIN32_LIB_DIR]]) {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
				const text = readFileSync(join(dir, entry.name), "utf8");
				const hits = text.split(CONTROL_FD_MARKER).length - 1;
				const callShape = text.split(CONTROL_FD_CALL_SHAPE).length - 1;
				if (hits === 0 && callShape === 0) continue;
				controlFd.files.push({ where: `${label}/${entry.name}`, hits, callShape });
				controlFd.hits += hits;
				controlFd.callShape += callShape;
			}
		} catch (error) {
			problems.push(`vendor 目录不可读：${label} (${dir}) — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	fields.controlFd = controlFd;
	for (const problem of controlFdProblems(controlFd)) problems.push(problem);
	if (provider === undefined || provider === null || typeof provider !== "object") {
		problems.push("ctx.sandbox is not an object");
		return { problems, fields };
	}
	fields.materializeAclGrant = typeof provider.materializeAclGrant === "function";
	if (!fields.materializeAclGrant) problems.push("provider.materializeAclGrant is not a function — 0.1.7 的 windows-acl seam 形状变了");
	fields.revokeAclGrants = typeof provider.revokeAclGrants === "function";
	fields.removeTempDir = typeof provider.removeTempDir === "function";
	if (!fields.removeTempDir) problems.push("provider.removeTempDir is not a function — 覆盖实现依赖它做失败清理");
	fields.workspaceGrantsIsMap = provider.workspaceGrants instanceof Map;
	fields.tempCapabilitiesIsMap = provider.tempCapabilities instanceof Map;
	if (!fields.workspaceGrantsIsMap) problems.push("provider.workspaceGrants is not a Map — 覆盖实现要写同一个复用缓存");
	if (!fields.tempCapabilitiesIsMap) problems.push("provider.tempCapabilities is not a Map");
	fields.internalsIsObject = typeof provider.internals === "object" && provider.internals !== null;
	if (!fields.internalsIsObject) problems.push("provider.internals is not an object — 无处挂 windowsAclRunnerArgs 覆盖");
	fields.ctorName = provider.constructor?.name ?? null;
	// 非 Windows 平台不该走到这里：windows-acl runner 只在 win32 的链上。
	fields.platform = process.platform;
	if (process.platform !== "win32") problems.push(`platform is ${process.platform}, windows-acl seam is not in play`);
	return { problems, fields };
}

/**
 * 造 0.1.7 `materializeAclGrant` 的等价物，`AclWriteGrant` 取自 **vendor 里这份补丁过的包**
 * （0.1.7-rc.2 + 补丁 B：add() 只写能力 ACE）。**seam 与 runner 同源** —— 两者都来自
 * 同一个 vendor 目录，不再有版本混用。
 *
 * 逐行对位 0.1.7 dsh-sandbox-local/lib/index.js:392-440：workspace 走 standing 授权
 * （跨会话复用缓存），每个 (sessionId, workspaceRoot) 走一个随机私有 temp 目录 + 独立
 * temp SID（可撤销）。**唯一的语义差异**在 vendor 那份包里：它的 add() 只写能力 ACE，
 * 不写 Low 强制标签、不写 Everyone 的删除拒绝、也不降级令牌完整性。
 *
 * 覆盖的是**实例自有属性**，因此 this 就是 provider，读写的是它自己的
 * workspaceGrants / tempCapabilities 复用缓存（revokeAclGrants 能照常回收）。
 * @param legacy - vendor 里补丁过的包模块（0.1.7-rc.2 + 补丁 A/B）。
 * @param ctx - 插件上下文（记日志用）。
 * @returns 可直接赋给 provider.materializeAclGrant 的函数。
 */
function buildMaterialize(legacy, ctx) {
	const { AclWriteGrant, assertTempRootOutsideWorkspace, tempWriteSid, workspaceWriteSid } = legacy;
	return function materializeAclGrant(sessionId, workspaceRoot) {
		assertTempRootOutsideWorkspace(workspaceRoot, tmpdir());
		const writeSid = workspaceWriteSid(workspaceRoot);
		if (!this.workspaceGrants.has(workspaceRoot)) {
			const grant = AclWriteGrant.create(writeSid);
			try {
				grant.add(workspaceRoot, true);
			} catch (error) {
				try {
					grant.dispose();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "sandbox-legacy-acl: workspace grant failed and its cleanup also failed");
				}
				throw error;
			}
			this.workspaceGrants.set(workspaceRoot, grant);
			state.override?.granted?.push({ at: new Date().toISOString(), kind: "workspace", workspaceRoot, writeSid, standing: true, aceOnly: true });
			report(ctx, `legacy grant (ACE only): workspace=${workspaceRoot} sid=${writeSid}`);
		}
		const key = JSON.stringify([String(sessionId), workspaceRoot]);
		const existing = this.tempCapabilities.get(key);
		if (existing !== undefined) return existing;
		const tempDir = mkdtempSync(join(tmpdir(), "dsh-"));
		const tempSid = tempWriteSid(tempDir);
		let grant;
		try {
			grant = AclWriteGrant.create(tempSid);
			grant.add(tempDir);
		} catch (error) {
			const cleanupFailures = [];
			if (grant !== undefined) {
				try {
					grant.dispose();
				} catch (cleanupError) {
					cleanupFailures.push(cleanupError);
				}
			}
			try {
				this.removeTempDir(tempDir);
			} catch (cleanupError) {
				cleanupFailures.push(cleanupError);
			}
			if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], "sandbox-legacy-acl: temp grant failed and its cleanup also failed");
			throw error;
		}
		const capability = { dir: tempDir, writeSid: tempSid, grant };
		this.tempCapabilities.set(key, capability);
		state.override?.granted?.push({ at: new Date().toISOString(), kind: "temp", tempDir, writeSid: tempSid, standing: false, aceOnly: true });
		report(ctx, `legacy grant (ACE only): temp=${tempDir} sid=${tempSid}`);
		return capability;
	};
}

/**
 * 安装接管。**原子**：任一前置或加载失败都一处不改，只落盘原因。
 * @param ctx - 注入后的上下文。
 * @param provider - ctx.sandbox 实例（由调用方先取出，便于按实例做幂等缓存）。
 * @returns disposer（还原两处改点），或 null（未接管）。
 */
async function install(ctx, provider) {
	// 幂等短路：这个 provider 已经被本插件接管过（`apply` 的 WeakMap 之外的第二道保险，
	// 也让「重复安装」不会把替换版当成 original 记下来）。
	if (provider !== null && typeof provider === "object" && provider.materializeAclGrant?.__legacyAcl === true) {
		state.status = "installed";
		state.reason = "已经是接管状态（幂等短路，未重复改写）";
		report(ctx, "already-installed");
		return () => {};
	}
	const { problems, fields } = preflight(provider);
	state.preflight = { problems, fields };
	state.provider = { ctor: fields.ctorName, materializeAclGrant: fields.materializeAclGrant, removeTempDir: fields.removeTempDir, workspaceGrantsIsMap: fields.workspaceGrantsIsMap, tempCapabilitiesIsMap: fields.tempCapabilitiesIsMap, internalsIsObject: fields.internalsIsObject, platform: fields.platform };
	if (problems.length > 0) {
		state.status = "refused";
		state.reason = `前置检查未通过（${problems.length} 项）—— 一处都没有改，DSH 保持原生行为`;
		report(ctx, "refused: preflight");
		return null;
	}
	let legacy;
	try {
		legacy = await import(pathToFileURL(ACL_ENTRY).href);
	} catch (error) {
		recordFailure(ctx, "vendor import", error);
		state.status = "refused";
		state.reason = `vendor 的包加载失败（koffi 原生库或改写后的 import 路径有问题）：${error instanceof Error ? error.message : String(error)}`;
		report(ctx, "refused: vendor import");
		return null;
	}
	const missing = REQUIRED_EXPORTS.filter((key) => typeof legacy[key] !== "function");
	if (missing.length > 0) {
		state.status = "refused";
		state.reason = `vendor 的包缺少导出：${missing.join(", ")}`;
		report(ctx, "refused: vendor exports");
		return null;
	}
	state.vendor.exports = Object.fromEntries(REQUIRED_EXPORTS.map((key) => [key, typeof legacy[key]]));

	// —— 改点 ①：ACE 写入 ——
	const hadOwnMaterialize = Object.prototype.hasOwnProperty.call(provider, "materializeAclGrant");
	const originalMaterialize = provider.materializeAclGrant;
	const replacement = buildMaterialize(legacy, ctx);
	// 打标，便于实机核对「跑的是不是这一份」。
	replacement.__legacyAcl = true;
	// —— 改点 ②：runner 用 vendor 的 ——（同源的补丁包；AclSandbox.init() 里那条
	//    令牌完整性降级调用已在 vendor 侧删掉，runner 里也不会再发生）
	const previousRunnerArgs = provider.internals.windowsAclRunnerArgs;
	state.override = {
		runnerArgs: [process.execPath, ACL_RUNNER],
		previousRunnerArgs: previousRunnerArgs === undefined ? null : previousRunnerArgs,
		materializeOwn: hadOwnMaterialize,
		granted: [],
	};

	try {
		provider.internals.windowsAclRunnerArgs = [process.execPath, ACL_RUNNER];
		provider.materializeAclGrant = replacement;
	} catch (error) {
		recordFailure(ctx, "override", error);
		// 半途失败：尽力回滚到「一处都没改」。
		try { provider.internals.windowsAclRunnerArgs = previousRunnerArgs; } catch { /* ignore */ }
		try { provider.materializeAclGrant = originalMaterialize; } catch { /* ignore */ }
		state.status = "refused";
		state.reason = `写入覆盖时抛错，已尽力回滚：${error instanceof Error ? error.message : String(error)}`;
		report(ctx, "refused: override threw");
		return null;
	}

	state.status = "installed";
	state.reason = "两处改点均已生效（materializeAclGrant → vendor 的补丁 AclWriteGrant；windowsAclRunnerArgs → vendor 的补丁 runner）";
	report(ctx, "installed");
	try { ctx.logger?.info?.("sandbox-legacy-acl: installed (ACE-only grants, patched 0.1.7 runner with control-fd)"); } catch { /* ignore */ }

	return function uninstall() {
		try {
			if (hadOwnMaterialize) provider.materializeAclGrant = originalMaterialize;
			else delete provider.materializeAclGrant;
		} catch (error) {
			recordFailure(ctx, "restore materializeAclGrant", error);
		}
		try {
			if (previousRunnerArgs === undefined) delete provider.internals.windowsAclRunnerArgs;
			else provider.internals.windowsAclRunnerArgs = previousRunnerArgs;
		} catch (error) {
			recordFailure(ctx, "restore windowsAclRunnerArgs", error);
		}
		state.status = "uninstalled";
		state.reason = "插件卸载：两处改点已还原";
		report(ctx, "uninstalled");
	};
}

/**
 * 幂等缓存：inject 回调可能多次触发（服务重挂），按 **provider 实例**只接管一次。
 * refused 时把条目删掉，允许服务修好后重试。
 */
const installs = new WeakMap();

/** 只有 .smoke 用得到：把内部件暴露出来，让离线自检能在**不写任何 ACE** 的前提下
 *  验证覆盖实现的行为（用假 AclWriteGrant 跑真 buildMaterialize）。生产路径不读它。 */
export const __internals = {
	PROBE_VERSION,
	ACL_ENTRY,
	ACL_RUNNER,
	ACL_TYPES,
	ACL_LIB_DIR,
	WIN32_LIB_DIR,
	CONTROL_FD_MARKER,
	CONTROL_FD_CALL_SHAPE,
	CONTROL_FD_MIN_HITS,
	controlFdProblems,
	buildMaterialize,
	preflight,
	install,
	state,
	installs,
};

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
	report(ctx, ENABLED ? "apply" : "apply (disabled)");
	if (!ENABLED) return;
	ctx.inject(["sandbox"], (sctx) => {
		sctx.effect(() => {
			let dispose = null;
			const provider = sctx.get("sandbox");
			// WeakMap 只接受对象/函数作键 —— 服务位置被别的东西占了（字符串/数字）时 
			// installs.get() 自己会抛，所以先判可用性，别让插件把异常丢进插件树。
			const keyable = provider !== null && (typeof provider === "object" || typeof provider === "function");
			let pending = keyable ? installs.get(provider) : undefined;
			if (pending === undefined) {
				pending = install(sctx, provider)
					.then((result) => {
						if (result === null && keyable) installs.delete(provider);
						return result;
					})
					.catch((error) => {
						recordFailure(sctx, "install", error);
						state.status = "error";
						state.reason = `接管时抛错（DSH 保持原生行为）：${error instanceof Error ? error.message : String(error)}`;
						report(sctx, "install threw");
						if (keyable) installs.delete(provider);
						return null;
					});
				if (keyable) installs.set(provider, pending);
			}
			pending.then((result) => {
				dispose = result;
			});
			return () => {
				try {
					if (typeof dispose === "function") dispose();
				} catch (error) {
					recordFailure(sctx, "dispose", error);
				}
			};
		}, "sandbox-legacy-acl: install");
	});
}