/**
 * dsh-sandbox-legacy-acl · 离线自检 ①：vendor 侧
 *
 * 验的是「替身的成色」，全程不碰真实工作区、不写任何 ACE。
 *
 * 分组：
 *   A. 文件与 import 改写：0.1.7-rc.2 的包整包在位，裸包名已改成包内相对路径
 *   B. **安全目标防线**：Low 标签与 Everyone 拒绝的构造代码在实现里 0 命中
 *   C. **回归防线**：control fd 能力必须存在（run_code 的 worker 靠它）
 *   D. 加载契约：vendor 能被真正 import（含 koffi 原生库加载）
 *   E. 行为：SID 派生确定性 + 与参照版本一致 + 真实一次 create/dispose（不写 ACE）
 *   F. runner 契约：argv 形态、manageDacls 语义、control fd 转交
 *
 * 参照包自动探测（也可用环境变量覆盖）：
 *   LEGACY_ACL_REF_017 = 0.1.7 的 dsh-sandbox-windows-acl 目录（**未打补丁**）
 *   LEGACY_ACL_REF_015 = 0.1.5 的 dsh-sandbox-windows-acl 目录
 * 反向控制的意义：
 *   · 0.1.7 里同一批符号必须**大量命中** —— 检测面若失效（符号名写错），它会先红；
 *   · 0.1.5 里必须**一个 controlFileDescriptor 都没有** —— 证明 C 组真能抓住那次回归。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUG = fileURLToPath(new URL("../", import.meta.url));
const VENDOR = join(PLUG, "vendor");

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (cond, label) => {
	if (cond) {
		pass++;
		console.log("  ok   " + label);
	} else {
		fail++;
		console.log("  FAIL " + label);
	}
};
const skipped = (label) => {
	skip++;
	console.log("  skip " + label);
};
const group = (title) => console.log("\n## " + title);

/** 递归收集某目录下的文件（相对路径 + 全文）。 */
function collect(dir, ext) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
		const full = join(dir, rel);
		if (!statSync(full).isFile()) continue;
		if (ext !== undefined && !rel.endsWith(ext)) continue;
		out.push({ rel: rel.split("\\").join("/"), full, text: readFileSync(full, "utf8") });
	}
	return out;
}
const countAll = (files, needle) => files.reduce((n, f) => n + f.text.split(needle).length - 1, 0);

/**
 * 自动探测参照包：<工作区根>/versions/<版本>/node_modules/.pnpm/@deepseek-ai+dsh-sandbox-wi_*。
 * 环境变量优先；找不到就返回空表（对应断言降级为 skip）。**只读**，不写任何东西。
 */
function findRefPackages() {
	const out = {};
	try {
		const versions = join(PLUG, "..", "..", "versions");
		if (!existsSync(versions)) return out;
		for (const v of readdirSync(versions, { encoding: "utf8" })) {
			const pnpm = join(versions, v, "node_modules", ".pnpm");
			if (!existsSync(pnpm)) continue;
			for (const d of readdirSync(pnpm, { encoding: "utf8" })) {
				if (!d.startsWith("@deepseek-ai+dsh-sandbox-wi_")) continue;
				const pkg = join(pnpm, d, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl");
				const pj = join(pkg, "package.json");
				if (!existsSync(pj)) continue;
				const ver = JSON.parse(readFileSync(pj, "utf8")).version;
				if (out[ver] === undefined) out[ver] = pkg;
			}
		}
	} catch {
		/* 探测失败就当没有参照 —— 对应断言 skip，不影响其余 */
	}
	return out;
}

const REFS = findRefPackages();
const REF017 = process.env.LEGACY_ACL_REF_017 ?? REFS["0.1.7-rc.2"] ?? null;
const REF015 = process.env.LEGACY_ACL_REF_015 ?? REFS["0.1.5-rc.3"] ?? null;

const ACL = join(VENDOR, "legacy-acl");
const WIN32P = join(VENDOR, "win32-process");
const KOFFI = join(VENDOR, "koffi");
const KOROMIX = join(VENDOR, "@koromix", "koffi-win32-x64");
const LAZY = join(VENDOR, "lazy-require");
const SUB = join(VENDOR, "subprocess");

console.log("plugin = " + PLUG);
console.log("vendor = " + VENDOR);
console.log("参照 0.1.7 = " + (REF017 ?? "（未找到）"));
console.log("参照 0.1.5 = " + (REF015 ?? "（未找到）"));

// ── A. 文件与改写 ───────────────────────────────────────────────
group("A. vendor 文件与 import 改写（0.1.7-rc.2 整包 + 两个新依赖）");
const files = {
	aclEntry: join(ACL, "lib", "index.js"),
	aclRunner: join(ACL, "lib", "runner.js"),
	aclTypes: join(ACL, "lib", "types-DxezulnA.js"),
	win32: join(WIN32P, "lib", "index.js"),
	lazyRequire: join(LAZY, "lib", "index.js"),
	subprocessControl: join(SUB, "lib", "control.js"),
	koffi: join(KOFFI, "index.js"),
	koffiNative: join(KOROMIX, "win32_x64", "koffi.node"),
	patchNotes: join(ACL, "PATCH-NOTES.md"),
};
for (const [label, path] of Object.entries(files)) ok(existsSync(path), "存在 " + label + " → " + path.slice(PLUG.length));
ok(!existsSync(join(ACL, "lib", "types-DuU3lSVe.js")), "0.1.5 的 types-DuU3lSVe.js 已不在（换版彻底）");
ok(!existsSync(join(ACL, "node_modules")) && !existsSync(join(WIN32P, "node_modules")), "vendor 里没有 node_modules（pnpm 的 .bin shim 未混入）");

const aclPkg = JSON.parse(readFileSync(join(ACL, "package.json"), "utf8"));
const win32Pkg = JSON.parse(readFileSync(join(WIN32P, "package.json"), "utf8"));
const koffiPkg = JSON.parse(readFileSync(join(KOFFI, "package.json"), "utf8"));
const lazyPkg = JSON.parse(readFileSync(join(LAZY, "package.json"), "utf8"));
const subPkg = JSON.parse(readFileSync(join(SUB, "package.json"), "utf8"));
ok(aclPkg.version === "0.1.7-rc.2", "legacy-acl 版本 = 0.1.7-rc.2（实测 " + aclPkg.version + "）");
ok(win32Pkg.version === "0.1.7-rc.2", "win32-process 版本 = 0.1.7-rc.2（实测 " + win32Pkg.version + "）");
ok(koffiPkg.version === "3.3.1", "koffi 版本 = 3.3.1（实测 " + koffiPkg.version + "）");
ok(lazyPkg.version === "0.1.7-rc.2", "lazy-require 版本 = 0.1.7-rc.2（实测 " + lazyPkg.version + "）");
ok(subPkg.version === "0.1.7-rc.2", "subprocess 版本 = 0.1.7-rc.2（实测 " + subPkg.version + "）");

const aclTypesText = readFileSync(files.aclTypes, "utf8");
const aclRunnerText = readFileSync(files.aclRunner, "utf8");
const win32Text = readFileSync(files.win32, "utf8");
ok(aclTypesText.includes('from "../../win32-process/lib/index.js"'), "types: dsh-win32-process 已改写为包内相对路径");
ok(aclTypesText.includes('from "../../lazy-require/lib/index.js"'), "types: dsh-lazy-require 已改写为包内相对路径");
ok(aclTypesText.includes('createLazyRequire("../../koffi/index.cjs", import.meta.url)'), "types: koffi 走 vendor 内的 CJS 入口（createRequire 只能加载 CJS）");
ok(!aclTypesText.includes("@deepseek-ai/dsh-win32-process"), "types: 已无 @deepseek-ai/dsh-win32-process 裸说明符");
ok(!aclTypesText.includes("@deepseek-ai/dsh-lazy-require"), "types: 已无 @deepseek-ai/dsh-lazy-require 裸说明符");
ok(!aclTypesText.includes('createLazyRequire("koffi"'), "types: 已无 koffi 裸说明符");
ok(aclRunnerText.includes('from "../../subprocess/lib/control.js"'), "runner: dsh-subprocess/control 已改写为包内相对路径");
ok(!aclRunnerText.includes("@deepseek-ai/dsh-subprocess/control"), "runner: 已无 dsh-subprocess/control 裸说明符");
ok(win32Text.includes('from "../../lazy-require/lib/index.js"'), "win32-process: lazy-require 已改写为包内相对路径");
ok(win32Text.includes('createLazyRequire("../../koffi/index.cjs", import.meta.url)'), "win32-process: koffi 走 vendor 内的 CJS 入口");
ok(!win32Text.includes("@deepseek-ai/dsh-lazy-require"), "win32-process: 已无 lazy-require 裸说明符");
ok(readFileSync(files.patchNotes, "utf8").includes("补丁 A"), "PATCH-NOTES.md 在位且记录了两处补丁");

// ── B. 安全目标防线 ─────────────────────────────────────────────
group("B. **安全目标防线**：三件套后两件的构造代码在实现里不存在（.js 全扫）");
const forbidden = [
	"S-1-16-4096", "TokenIntegrityLevel", "Low Mandatory", "buildLowLabelAcl", "lowLabelSidPtr",
	"addMandatoryAce", "FILE_DELETE_CHILD", "SE_GROUP_INTEGRITY", "restrictTokenIntegrity",
	"hasExactLabel", "hasExactDeny", "hasForeignGrant", "worldSidPtr", "lowLabelSid",
	"Mandatory", "IntegrityLevel",
];
const implJs = [...collect(ACL, ".js"), ...collect(WIN32P, ".js")];
console.log("  扫描实现文件 " + implJs.length + " 个（" + implJs.map((f) => f.rel).join(", ") + "）");
for (const sym of forbidden) {
	const n = countAll(implJs, sym);
	ok(n === 0, "vendor 实现里 \"" + sym + "\" 命中 " + n + " 次（期望 0）");
}
const dts = collect(ACL, ".d.ts");
ok(countAll(dts, "FILE_DELETE_CHILD") >= 1, ".d.ts 里 FILE_DELETE_CHILD 常量定义仍在（类型面未同步，命中 " + countAll(dts, "FILE_DELETE_CHILD") + "）");
// 写受限令牌本身必须还在（只去掉完整性降级与标签，不是去掉整个机制）
ok(countAll(implJs, "WRITE_RESTRICTED") >= 1, "WRITE_RESTRICTED 仍在（写受限令牌没有被一起拿掉, 命中 " + countAll(implJs, "WRITE_RESTRICTED") + "）");
ok(countAll(implJs, "restricting") >= 1, "restricting SID 列表仍在（命中 " + countAll(implJs, "restricting") + "）");
ok(countAll(implJs, "hasExactGrant") >= 1, "幂等跳过（hasExactGrant）仍在 —— 去掉它会让每次授权重传播整棵树");
ok(countAll(implJs, "SYSTEM_MANDATORY_LABEL") === 0, "SYSTEM_MANDATORY_LABEL 也 0 命中（冗余检查）");

if (REF017 !== null) {
	const ref = collect(REF017, ".js");
	console.log("  参照 0.1.7（未打补丁）：" + REF017);
	let refTotal = 0;
	for (const sym of forbidden) refTotal += countAll(ref, sym);
	ok(refTotal >= 10, "[反向控制] 同一批符号在未打补丁的 0.1.7 里命中 " + refTotal + " 次（期望 ≥10；为 0 说明检测面失效）");
} else {
	skipped("[反向控制] 未找到 0.1.7 参照包，跳过");
}

// ── C. 回归防线：control fd ─────────────────────────────────────
group("C. **回归防线**：control fd 能力必须在位（run_code 的 worker 靠 fd 7）");
const CONTROL_FD = "controlFileDescriptor";
const CONTROL_FD_SHAPE = "controlFileDescriptor: options.controlFileDescriptor";
const aclImpl = collect(ACL, ".js");
const fdHits = countAll(aclImpl, CONTROL_FD);
const fdShape = countAll(aclImpl, CONTROL_FD_SHAPE);
console.log("  ACL 包内 " + CONTROL_FD + " 命中 " + fdHits + " 次，关键调用形态 " + fdShape + " 次");
ok(fdHits >= 3, "[" + "(i)" + "] controlFileDescriptor 在 vendor ACL 包里命中 " + fdHits + " 次（门槛 3 —— 0.1.5 是 0）");
ok(fdShape >= 1, "[" + "(i)" + "] control fd 的传递形态在场：" + CONTROL_FD_SHAPE);
ok(aclRunnerText.includes("SUBPROCESS_CONTROL_FD"), "runner 认识 control fd 常量 SUBPROCESS_CONTROL_FD");
ok(aclRunnerText.includes("controlFileDescriptor: SUBPROCESS_CONTROL_FD"), "runner 在 control 通道存在时把 fd 转交给受限 spawn");
ok(readFileSync(files.subprocessControl, "utf8").includes("const SUBPROCESS_CONTROL_FD = 7;"), "vendor/subprocess 的 control 常量 = 7（与 0.1.7 逐字一致）");
if (REF015 !== null) {
	const ref15 = collect(REF015, ".js");
	const refHits = countAll(ref15, CONTROL_FD);
	console.log("  参照 0.1.5：" + REF015);
	ok(refHits === 0, "[反向控制] 0.1.5 的包里 controlFileDescriptor 命中 " + refHits + " 次（期望 0 —— 这正是被换掉的那版）");
} else {
	skipped("[反向控制] 未找到 0.1.5 参照包，跳过");
}

// ── D. 加载契约 ─────────────────────────────────────────────────
group("D. vendor 可加载 + 导出契约");
const legacy = await import(pathToFileURL(files.aclEntry).href);
ok(typeof legacy.AclWriteGrant === "function", "导出 AclWriteGrant 存在（class）");
ok(typeof legacy.AclSandbox === "function", "导出 AclSandbox 存在（class）");
ok(typeof legacy.assertTempRootOutsideWorkspace === "function", "导出 assertTempRootOutsideWorkspace");
ok(typeof legacy.tempWriteSid === "function", "导出 tempWriteSid");
ok(typeof legacy.workspaceWriteSid === "function", "导出 workspaceWriteSid");
ok(typeof legacy.AclWriteGrant.create === "function", "AclWriteGrant.create 是静态方法");
ok(typeof legacy.AclWriteGrant.prototype.add === "function", "AclWriteGrant.prototype.add");
ok(typeof legacy.AclWriteGrant.prototype.dispose === "function", "AclWriteGrant.prototype.dispose");
ok(typeof legacy.AclSandbox.prototype.init === "function", "AclSandbox.prototype.init");
ok(legacy.AclWriteGrant.prototype.add.length === 1 && /add\(path, standing = false\)/.test(String(legacy.AclWriteGrant.prototype.add)), "AclWriteGrant.add(path, standing = false) 签名与 0.1.7 逐字一致（fn.length=1 是因为默认值参数不计入）");
const win32Mod = await import(pathToFileURL(files.win32).href);
ok(win32Mod !== null && typeof win32Mod === "object", "win32-process 可加载（koffi 解析到 vendor 副本）");
ok(typeof win32Mod.extendWin32ProcessBindings === "function", "win32-process 导出 extendWin32ProcessBindings");
const subControl = await import(pathToFileURL(files.subprocessControl).href);
ok(subControl.SUBPROCESS_CONTROL_FD === 7 && subControl.SUBPROCESS_CONTROL_ENV === "DSH_SUBPROCESS_CONTROL", "subprocess/control 可加载且常量正确");
const lazyMod = await import(pathToFileURL(files.lazyRequire).href);
ok(typeof lazyMod.createLazyRequire === "function", "lazy-require 可加载且导出 createLazyRequire");

// ── E. 行为：SID 派生 + 真实 FFI 冒烟 ───────────────────────────
group("E. SID 派生确定性与真实 FFI 冒烟（不写任何 ACE）");
const probeRoot = "C:\\Users\\PUBLIC\\legacy-acl-probe";
const sid1 = legacy.workspaceWriteSid(probeRoot);
const sid2 = legacy.workspaceWriteSid(probeRoot);
ok(/^S-1-4-\d+-\d+$/.test(sid1), "workspaceWriteSid 形如 S-1-4-x-y（实测 " + sid1 + "）");
ok(sid1 === sid2, "workspaceWriteSid 对同一路径确定（同值 " + sid1 + "）");
const tsid = legacy.tempWriteSid("C:\\Temp\\dsh-probe");
ok(/^S-1-4-\d+-\d+-1$/.test(tsid), "tempWriteSid 形如 S-1-4-x-y-1（实测 " + tsid + "）");
if (REF015 !== null) {
	const ref = await import(pathToFileURL(join(REF015, "lib", "index.js")).href);
	ok(ref.workspaceWriteSid(probeRoot) === sid1, "与 0.1.5 的 workspaceWriteSid 逐字一致（" + sid1 + "）");
	ok(ref.tempWriteSid("C:\\Temp\\dsh-probe") === tsid, "与 0.1.5 的 tempWriteSid 逐字一致（" + tsid + "）");
} else {
	skipped("未找到 0.1.5 参照包，跳过与 0.1.5 的 SID 一致性对照");
}
if (REF017 !== null) {
	const ref = await import(pathToFileURL(join(REF017, "lib", "index.js")).href);
	ok(ref.workspaceWriteSid(probeRoot) === sid1, "与 0.1.7（未打补丁）的 workspaceWriteSid 逐字一致（" + sid1 + "）");
} else {
	skipped("未找到 0.1.7 参照包，跳过与 0.1.7 的 SID 一致性对照");
}
// 真实走一遍 koffi FFI：create 只解析 SID 字符串 + 打开绑定表，**不授予任何 ACE**
let grant = null;
let createErr = null;
try {
	grant = legacy.AclWriteGrant.create(sid1);
} catch (error) {
	createErr = error;
}
ok(createErr === null, "AclWriteGrant.create 真实调用成功（koffi FFI 可用）" + (createErr === null ? "" : " — " + String(createErr)));
if (grant !== null) {
	ok(grant.writeSid === sid1, "grant.writeSid 回读一致（" + grant.writeSid + "）");
	ok(Array.isArray(grant.paths) && grant.paths.length === 0, "grant.paths 为空 —— create 没有授予任何路径（期望 0，实测 " + (grant.paths?.length ?? "n/a") + "）");
	ok(grant.lowLabelSidPtr === undefined && grant.worldSidPtr === undefined, "grant 上已无 label/world SID 字段（补丁 B 的收窄生效）");
	let disposeErr = null;
	try {
		grant.dispose();
	} catch (error) {
		disposeErr = error;
	}
	ok(disposeErr === null, "grant.dispose 真实调用成功（释放 SID，无残留）" + (disposeErr === null ? "" : " — " + String(disposeErr)));
}

// ── F. runner 契约 ──────────────────────────────────────────────
group("F. runner argv 契约与 control fd 转交");
for (const flag of ["--workspace", "--temp", "--mode", "--write-sid", "--temp-write-sid"]) ok(aclRunnerText.includes('"' + flag + '"'), "runner 认识 " + flag);
ok(aclRunnerText.includes("manageDacls: !seamManaged"), "runner 在 seam 拥有授权时 manageDacls: false（既不 grant 也不 revoke）");
ok(aclRunnerText.includes("windows-acl-run"), "runner 失败签名 windows-acl-run 在位");
ok(!aclRunnerText.includes("restrictTokenIntegrity"), "runner 侧已无令牌完整性降级调用");
ok(readFileSync(files.win32, "utf8").includes("controlFileDescriptor"), "win32-process 支持 controlFileDescriptor（受限 spawn 的原生侧）");

console.log("\n" + (fail === 0 ? "ALL OK" : "FAILED") + " (" + pass + " passed, " + fail + " failed, " + skip + " skipped)");
process.exit(fail === 0 ? 0 : 1);
