/**
 * dsh-sandbox-legacy-acl · 离线自检 ②：宿主半
 *
 * 用桩 ctx + 桩 provider 跑 **真源码**（lib/index.js），断言两处覆盖与全部失败路径。
 *
 * 两条硬纪律：
 *   · **绝不写真实 ACE**：覆盖实现的行为用「假 legacy 模块」验证（真 buildMaterialize +
 *     假 AclWriteGrant），所以跑多少遍都不动系统 ACL；真实 vendor 只在 install 阶段被
 *     import（那一步只加载 koffi，不写 ACE）。
 *   · **不污染实机报告**：DSH_HOME 被指到 .smoke/.tmp/，报告落在那里，不碰
 *     $DSH_HOME/sandbox-legacy-acl/report.json。
 *
 * 期望输出：ALL OK (n assertions)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUG = fileURLToPath(new URL("../", import.meta.url));
const TMP_HOME = join(HERE, ".tmp");
const ENTRY = pathToFileURL(join(PLUG, "lib", "index.js")).href;

// 报告落盘位置在模块求值时确定 —— 必须在 import 之前把 DSH_HOME 指走。
rmSync(TMP_HOME, { recursive: true, force: true });
mkdirSync(TMP_HOME, { recursive: true });
process.env.DSH_HOME = TMP_HOME;

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
	if (cond) {
		pass++;
		console.log("  ok   " + label);
	} else {
		fail++;
		console.log("  FAIL " + label);
	}
};
const eq = (actual, expected, label) => {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	ok(same, label + (same ? "" : ` — 期望 ${JSON.stringify(expected)}，实测 ${JSON.stringify(actual)}`));
};
const group = (title) => console.log("\n## " + title);
const waitFor = async (fn, ms = 4000, step = 20) => {
	const deadline = Date.now() + ms;
	for (;;) {
		if (fn()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, step));
	}
};
const REPORT = join(TMP_HOME, "sandbox-legacy-acl", "report.json");
const readReport = () => JSON.parse(readFileSync(REPORT, "utf8"));

// ── 桩件 ────────────────────────────────────────────────────────
class FakeProvider {
	internals = {};
	workspaceGrants = new Map();
	tempCapabilities = new Map();
	removed = [];
	materializeAclGrant() {
		throw new Error("prototype materializeAclGrant must not be called after install");
	}
	revokeAclGrants() {}
	removeTempDir(dir) {
		this.removed.push(dir);
	}
}

function makeCtx(provider) {
	const log = [];
	const injections = [];
	const effects = [];
	const ctx = {
		logger: {
			info: (m) => log.push(["info", m]),
			warn: (m) => log.push(["warn", m]),
		},
		get: (name) => (name === "sandbox" ? provider : undefined),
		inject: (deps, cb) => {
			injections.push({ deps, cb });
			// 模拟「服务已就绪 → 注入回调立即触发」（真 cordis 是懒触发，这里要立刻看结果）。
			cb(ctx);
			return { dispose() {} };
		},
		effect: (fn, label) => {
			effects.push({ label, dispose: fn() });
			return () => {};
		},
	};
	return { ctx, log, injections, effects };
}

/** 假 legacy：记录每一次调用，可注入失败点。 */
function makeFakeLegacy(fail = {}) {
	const calls = [];
	class FakeGrant {
		constructor(sid) {
			this.writeSid = sid;
			this.paths = [];
			this.disposed = false;
		}
		static create(sid) {
			calls.push(["create", sid]);
			return new FakeGrant(sid);
		}
		add(path, standing) {
			const isStanding = standing === true;
			calls.push(["add", path, isStanding]);
			if (isStanding && fail.workspaceAdd === true) throw new Error("fake workspace add failed");
			if (!isStanding && fail.tempAdd === true) throw new Error("fake temp add failed");
			this.paths.push(path);
		}
		dispose() {
			calls.push(["dispose", this.writeSid]);
			this.disposed = true;
			if (fail.dispose === true) throw new Error("fake dispose failed");
		}
	}
	return {
		calls,
		mod: {
			AclWriteGrant: FakeGrant,
			assertTempRootOutsideWorkspace: (workspace, temp) => calls.push(["assertTempRoot", workspace, temp]),
			tempWriteSid: (dir) => {
				calls.push(["tempWriteSid", dir]);
				return "S-1-4-1-2-1";
			},
			workspaceWriteSid: (root) => {
				calls.push(["workspaceWriteSid", root]);
				return "S-1-4-9-9";
			},
		},
	};
}
const quickCtx = { logger: { info() {}, warn() {} } };
const cleanups = [];

console.log("plugin = " + PLUG);
console.log("DSH_HOME (测试用) = " + TMP_HOME);

// ── 1. 关闭开关 ─────────────────────────────────────────────────
group("1. DSH_LEGACY_ACL=0 —— 完全不接管");
process.env.DSH_LEGACY_ACL = "0";
const disabled = await import(ENTRY + "?case=disabled");
const p1 = new FakeProvider();
const c1 = makeCtx(p1);
let threw1 = null;
try {
	disabled.apply(c1.ctx);
} catch (error) {
	threw1 = error;
}
ok(threw1 === null, "apply 不抛" + (threw1 === null ? "" : " — " + String(threw1)));
await new Promise((resolve) => setTimeout(resolve, 30));
eq(c1.injections.length, 0, "关闭时一个注入都不注册（不接管）");
ok(p1.internals.windowsAclRunnerArgs === undefined, "关闭时 provider.internals 未被改写");
ok(p1.materializeAclGrant.__legacyAcl === undefined, "关闭时 provider 方法未被替换");
ok(existsSync(REPORT), "关闭时也落盘报告（可见性）");
if (existsSync(REPORT)) {
	const r = readReport();
	eq(r.status, "disabled", "报告 status=disabled");
	eq(r.enabled, false, "报告 enabled=false");
	ok(typeof r.reason === "string" && r.reason.includes("DSH_LEGACY_ACL=0"), "报告 reason 写明关闭开关");
	eq(r.probeVersion, 2, "报告带 probeVersion=2（v2 新增 controlFd / patched 字段）");
	eq(r.vendor.aclVersion, "0.1.7-rc.2", "报告记录 vendor 侧版本 = 0.1.7-rc.2（换版后）");
	eq(r.vendor.patched, true, "报告标记 vendor 是打过补丁的（patched: true）");
	ok(String(r.vendor.patchSemantics ?? "").includes("补丁 A") && String(r.vendor.patchSemantics ?? "").includes("补丁 B"), "报告写明两处补丁语义");
}

// ── 2. 正常接管（真 install + 真 vendor import） ────────────────
group("2. 正常接管：两处改点同时生效");
process.env.DSH_LEGACY_ACL = "1";
const mod = await import(ENTRY + "?case=enabled");
const provider = new FakeProvider();
const c2 = makeCtx(provider);
let threw2 = null;
try {
	mod.apply(c2.ctx);
} catch (error) {
	threw2 = error;
}
ok(threw2 === null, "apply 不抛" + (threw2 === null ? "" : " — " + String(threw2)));
eq(c2.injections.length, 1, "apply 注册了 1 次注入");
eq(c2.injections[0]?.deps, ["sandbox"], "注入面正是 [\"sandbox\"]");
eq(c2.effects.length, 1, "注入回调内建了 1 个 effect（随卸载回收）");
const installed = await waitFor(() => ["installed", "refused", "error"].includes(mod.__internals.state.status));
ok(installed, "install 在 4s 内收敛（status=" + mod.__internals.state.status + "）");
eq(mod.__internals.state.status, "installed", "status=installed");
eq(provider.internals.windowsAclRunnerArgs, [process.execPath, mod.__internals.ACL_RUNNER], "改点②：internals.windowsAclRunnerArgs 指向 vendor 的补丁 runner（0.1.7-rc.2 + 补丁 A/B）");
ok(provider.materializeAclGrant.__legacyAcl === true, "改点①：provider.materializeAclGrant 被替换为 legacy 版（带 __legacyAcl 标记）");
ok(Object.prototype.hasOwnProperty.call(provider, "materializeAclGrant"), "替换是实例自有属性（不动原型）");
ok(typeof FakeProvider.prototype.materializeAclGrant === "function" && FakeProvider.prototype.materializeAclGrant.__legacyAcl === undefined, "原型方法未被污染");
ok(provider.internals.windowsAclRunnerArgs?.[1]?.endsWith(join("vendor", "legacy-acl", "lib", "runner.js")) === true, "runner 指向 vendor/legacy-acl/lib/runner.js");
const rep2 = readReport();
eq(rep2.status, "installed", "报告 status=installed");
eq(rep2.preflight.problems, [], "报告里前置检查 problems 为空");
eq(rep2.override.runnerArgs, [process.execPath, mod.__internals.ACL_RUNNER], "报告记录 runnerArgs 覆盖");
ok(rep2.preflight.fields.materializeAclGrant === true && rep2.preflight.fields.workspaceGrantsIsMap === true, "报告记录 provider 形状探针（materializeAclGrant / workspaceGrants 均为真）");
ok(Array.isArray(rep2.decisions) && rep2.decisions.some((d) => d.event === "installed"), "报告 decisions 里有 installed 事件");
const againArgs = [...provider.internals.windowsAclRunnerArgs];
const rep3 = await mod.__internals.install(quickCtx, provider);
ok(typeof rep3 === "function", "同一 provider 再 install 一次走幂等短路（返回可调用 disposer）");
eq(provider.internals.windowsAclRunnerArgs, againArgs, "幂等短路不改动既有覆盖（runnerArgs 原样）");
ok(provider.materializeAclGrant.__legacyAcl === true, "幂等短路后方法仍是 legacy 版");

// ── 2b. control-fd 回归防线（run_code 的 worker 靠 fd 7） ────────
// 这条防线要防的是：vendor 被换成不支持 control fd 的版本（0.1.5 命中 0 次）后
// 插件仍然接管 → run_code 的 worker 起不来 → read / write / pwsh 全瘫。
group("2b. control-fd 回归防线（preflight 硬门槛）");
const cf = rep2.preflight.fields.controlFd;
ok(cf !== undefined && cf !== null, "报告记录了 controlFd 扫描结果");
ok(typeof cf.hits === "number" && cf.hits >= mod.__internals.CONTROL_FD_MIN_HITS, "vendor ACL 包里 controlFileDescriptor 命中 " + cf.hits + " ≥ 门槛 " + mod.__internals.CONTROL_FD_MIN_HITS);
ok(typeof cf.callShape === "number" && cf.callShape >= 1, "control fd 的传递形态命中 " + cf.callShape + " 次");
ok(Array.isArray(cf.files) && cf.files.length >= 1, "报告列出命中文件：" + JSON.stringify((cf.files ?? []).map((f) => f.where + "×" + f.hits)));
eq(cf.minHits, mod.__internals.CONTROL_FD_MIN_HITS, "报告记录门槛值");
ok(mod.__internals.CONTROL_FD_MIN_HITS === 3, "门槛 = 3（0.1.5 实测 0、0.1.7-rc.2 实测 5，取 3 留余量）");
const fdZero = mod.__internals.controlFdProblems({ hits: 0, callShape: 0 });
ok(fdZero.length === 2, "反向控制：hits=0 且 callShape=0（= 0.1.5 的形态）→ 2 条问题 → 拒绝接管");
ok(fdZero.some((p) => p.includes("control fd")), "反向控制的理由写明 control fd：" + String(fdZero[0]).slice(0, 120));
const fdShapeMissing = mod.__internals.controlFdProblems({ hits: mod.__internals.CONTROL_FD_MIN_HITS, callShape: 0 });
ok(fdShapeMissing.length === 1 && fdShapeMissing[0].includes("传递形态"), "反向控制：命中数够但缺传递形态 → 仍拒绝接管（防「只有声明没有使用」）");
eq(mod.__internals.controlFdProblems({ hits: mod.__internals.CONTROL_FD_MIN_HITS, callShape: 1 }), [], "正向：命中数 ≥ 门槛且有传递形态 → 零问题（允许接管）");

// ── 3. 覆盖实现的行为（真 buildMaterialize + 假 legacy） ─────────
group("3. 覆盖后的 materializeAclGrant 行为（不写任何真实 ACE）");
const { buildMaterialize } = mod.__internals;
const fA = makeFakeLegacy();
const pA = new FakeProvider();
const fnA = buildMaterialize(fA.mod, quickCtx);
const capA = fnA.call(pA, "session-A", "C:\\ws");
const wsSidA = "S-1-4-9-9";
eq(
	fA.calls,
	[
		["assertTempRoot", "C:\\ws", tmpdir()],
		["workspaceWriteSid", "C:\\ws"],
		["create", wsSidA],
		["add", "C:\\ws", true],
		["tempWriteSid", capA.dir],
		["create", "S-1-4-1-2-1"],
		["add", capA.dir, false],
	],
	"调用序：路径边界检查 → workspace SID 派生 → create+add(standing) → temp SID 派生 → create+add(非 standing)"
);
ok(capA.dir.startsWith(tmpdir()) && capA.dir.includes("dsh-"), "temp 目录前缀 dsh-（与 0.1.7 的 mkdtempSync 前缀一致）");
eq(capA.writeSid, "S-1-4-1-2-1", "capability.writeSid = temp SID");
eq(pA.workspaceGrants.get("C:\\ws")?.writeSid, wsSidA, "workspaceGrants 写入同一个复用缓存");
eq([...pA.tempCapabilities.keys()], [JSON.stringify(["session-A", "C:\\ws"])], "tempCapabilities 的 key = JSON.stringify([sessionId, workspaceRoot])（与 0.1.7 一致）");
const before = fA.calls.length;
const capA2 = fnA.call(pA, "session-A", "C:\\ws");
const delta = fA.calls.slice(before);
// 0.1.7 原实现把 assertTempRootOutsideWorkspace / workspaceWriteSid 放在缓存判断**之前**
// （dsh-sandbox-local/lib/index.js:393-394），所以每次调用这两条都会跑；
// 被缓存省掉的只有 create/add —— 断言如实分档，别把「省掉授权」写成「零调用」。
eq(delta.filter((c) => c[0] === "assertTempRoot" || c[0] === "workspaceWriteSid").length, 2, "第二次仍做路径边界检查与 SID 派生（与 0.1.7 逐行同序）");
eq(delta.filter((c) => c[0] === "create" || c[0] === "add").length, 0, "第二次零 create/add（授权走缓存，不重复写 ACE）");
ok(capA2 === capA, "第二次返回同一个 capability 对象");
const capA3 = fnA.call(pA, "session-B", "C:\\ws");
ok(capA3.dir !== capA.dir, "换 session 得到新的私有 temp 目录（身份隔离）");
ok(fA.calls.filter((c) => c[0] === "create" && c[1] === wsSidA).length === 1, "workspace 授权只发生一次（standing 复用）");
cleanups.push(capA.dir, capA3.dir);

// 失败路径：workspace add 抛错 → dispose + 不落缓存
const fB = makeFakeLegacy({ workspaceAdd: true });
const pB = new FakeProvider();
let errB = null;
try {
	buildMaterialize(fB.mod, quickCtx).call(pB, "s", "C:\\ws");
} catch (error) {
	errB = error;
}
ok(errB !== null && String(errB.message).includes("fake workspace add failed"), "workspace add 抛错时原错误向上抛");
ok(fB.calls.some((c) => c[0] === "dispose" && c[1] === wsSidA), "workspace add 抛错时调用了 grant.dispose()");
eq(pB.workspaceGrants.size, 0, "workspace add 抛错时不留缓存");

// 失败路径：temp add 抛错 → dispose + removeTempDir + 不落缓存
const fC = makeFakeLegacy({ tempAdd: true });
const pC = new FakeProvider();
let errC = null;
try {
	buildMaterialize(fC.mod, quickCtx).call(pC, "s", "C:\\ws");
} catch (error) {
	errC = error;
}
ok(errC !== null && String(errC.message).includes("fake temp add failed"), "temp add 抛错时原错误向上抛");
ok(fC.calls.some((c) => c[0] === "dispose" && c[1] === "S-1-4-1-2-1"), "temp add 抛错时 dispose 了 temp grant");
ok(pC.removed.length === 1 && pC.removed[0].startsWith(tmpdir()), "temp add 抛错时调用了 removeTempDir（清理私有目录）");
eq(pC.tempCapabilities.size, 0, "temp add 抛错时不留缓存");
eq(pC.workspaceGrants.size, 1, "temp 失败不影响已 standing 的 workspace 授权（与 0.1.7 同款语义）");
cleanups.push(pC.removed[0]);

// 覆盖实现绝不触碰完整性标签：假 legacy 上根本没有这些 API，调用序里也没有
const flat = JSON.stringify(fA.calls) + JSON.stringify(fB.calls) + JSON.stringify(fC.calls);
ok(!/Low|Label|Integrity|Everyone/i.test(flat), "覆盖实现的全调用序里没有任何 Low/标签/完整性/Everyone 动作");

// ── 4. 前置检查失败 = 一处不改（fail-closed） ───────────────────
group("4. 前置检查失败时原子拒绝");
const broken = { internals: {}, materializeAclGrant() {}, revokeAclGrants() {}, removeTempDir() {} };
const c4 = makeCtx(broken);
const r4 = await mod.__internals.install(c4.ctx, broken).catch((error) => ({ __threw: error }));
ok(r4 === null, "缺 workspaceGrants/tempCapabilities 时 install 返回 null（不接管）");
ok(broken.internals.windowsAclRunnerArgs === undefined, "被拒绝时 runnerArgs **一处都没改**");
ok(broken.materializeAclGrant.__legacyAcl === undefined, "被拒绝时方法**一处都没改**");
eq(mod.__internals.state.status, "refused", "报告 status=refused");
ok(typeof mod.__internals.state.reason === "string" && mod.__internals.state.reason.length > 0, "报告 reason 写明拒绝原因：" + mod.__internals.state.reason);
ok((mod.__internals.state.preflight?.problems ?? []).length >= 2, "报告列出至少 2 条前置问题（实测 " + (mod.__internals.state.preflight?.problems ?? []).length + " 条）");

// ── 5. 卸载还原 ─────────────────────────────────────────────────
group("5. 卸载还原两处改点");
let threw5 = null;
try {
	c2.effects[0].dispose();
} catch (error) {
	threw5 = error;
}
ok(threw5 === null, "effect disposer 不抛");
ok(!Object.prototype.hasOwnProperty.call(provider, "materializeAclGrant"), "disposer 删掉了实例自有属性（原型方法重新生效）");
ok(provider.internals.windowsAclRunnerArgs === undefined, "disposer 还原了 windowsAclRunnerArgs（delete）");
eq(mod.__internals.state.status, "uninstalled", "报告 status=uninstalled");

// ── 6. 绝不抛 ───────────────────────────────────────────────────
group("6. 畸形输入下绝不抛");
const cases = [
	["provider = null", null],
	["provider = 字符串", "not-a-provider"],
	["provider = 空对象", {}],
	["provider 缺 internals", { workspaceGrants: new Map(), tempCapabilities: new Map(), materializeAclGrant() {}, removeTempDir() {} }],
];
for (const [label, value] of cases) {
	let threw = null;
	const c = makeCtx(value);
	try {
		mod.apply(c.ctx);
	} catch (error) {
		threw = error;
	}
	ok(threw === null, label + " → apply 不抛");
	const settled = await waitFor(() => ["installed", "refused", "error", "uninstalled"].includes(mod.__internals.state.status), 4000);
	ok(settled, label + " → 状态在 4s 内收敛（不悬挂）");
}

// ── 收尾 ────────────────────────────────────────────────────────
for (const dir of cleanups) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* 尽力而为：这是本进程 mkdtemp 出来的空目录 */
	}
}
console.log("\n" + (fail === 0 ? "ALL OK" : "FAILED") + " (" + pass + " passed, " + fail + " failed)");
console.log("报告样本：" + REPORT);
process.exit(fail === 0 ? 0 : 1);
