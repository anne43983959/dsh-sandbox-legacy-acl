# PATCH-NOTES · vendor/legacy-acl

> 本目录 = **@deepseek-ai/dsh-sandbox-windows-acl@0.1.7-rc.2** 的副本 + 两处补丁 + import
> 说明符改写。由插件 `dsh-sandbox-legacy-acl` 维护 —— **不要**把它当成纯上游副本。

## 为什么是 0.1.7 而不是 0.1.5

0.1.5 的包**没有** control fd 支持（`controlFileDescriptor` 在整包里命中 **0** 次）。
0.1.7 的 run_code worker 是独立 Node 进程，靠 **fd 7（control channel）** 与主进程通信；
换上 0.1.5 的 runner 后，受限 spawn 出来的 worker 拿不到合法 fd，
`node:net:195 throw new ERR_INVALID_FD_TYPE(type)`，**整条工具链（read / write / pwsh
全走 run_code）瘫痪**。原始诊断见
`.sandbox/capability-audit-20260930-143840/DIAG-run_code-regression.md`。

所以 vendor 换成 0.1.7-rc.2，再把它「往回打」成 0.1.5 的**授权语义** —— 只打语义，不碰
control fd。

## 补丁 A：令牌完整性不降级

| 位置（0.1.7-rc.2 原行号） | 改动 |
| --- | --- |
| `lib/types-*.js:819-835` | 删除 `restrictTokenIntegrity()` 定义（含调用它的 `setTokenInformation(..., TokenIntegrityLevel, ...)` 写入） |
| `lib/types-*.js:1186-1205` | `AclSandbox.init()` 不再创建 label SID，也不再调用该函数；令牌保持调用方的 **Medium** 完整性 |

效果：`WRITE_RESTRICTED` 令牌本身与 restricting SID 列表（logon SID + Everyone +
能力 SID）**原样保留**，写入权限仍由能力 ACE 决定。对应上游 0.1.5：该函数不存在。

## 补丁 B：grantWrite 只写能力 SID 的 allow ACE

| 位置（0.1.7-rc.2 原行号） | 改动 |
| --- | --- |
| `lib/types-*.js:196-202` | 删除 abi 表里的 `AddMandatoryAce` 绑定（该包不再有任何写标签的途径） |
| `lib/types-*.js:307-310` | `buildExplicitAccess` 注释：去掉「ambient-delete deny 收窄继承」的说明 |
| `lib/types-*.js:383-408` | `readCurrentSecurity()` 只读 DACL（`GetNamedSecurityInfoW(..., 4, ...)`），返回值去掉 `labelAcl` |
| `lib/types-*.js:409-448` | 删除 `buildLowLabelAcl()` 与 `hasExactLabel()`（低完整性标签的构造与幂等探针） |
| `lib/types-*.js:449-487` | `mergeAndApply()` 去掉 `labelEdit` 参数：`SetNamedSecurityInfoW` 恒以 `DACL_SECURITY_INFORMATION (4)` 调用，**不再写 SACL** |
| `lib/types-*.js:530-562` | 删除 `hasExactDeny()`（Everyone 的 FILE_DELETE_CHILD 拒绝的幂等探针）与 `hasForeignGrant()`（撤销时判断是否保留共享标签） |
| `lib/types-*.js:563-608` | `grantWrite(api, path, sidPtr, lowLabelSidPtr, worldSidPtr)` → `grantWrite(api, path, sidPtr)`：只合并能力 SID 的 allow ACE |
| `lib/types-*.js:609-636` | `revokeWrite()` 恒以 `{kind: keep}` 语义合并 DACL，**不再依赖共享标签**（标签本就没写过） |
| `lib/types-*.js:908-1004` | `AclWriteGrant`：字段 / `create()` / `add()` / `dispose()` 收窄为只持有能力 SID；`add()` 调 3 参 `grantWrite` |
| `lib/types-*.js:1186-1205` | `AclSandbox.init()`：不再创建 label SID，两处 `grantWrite` 调用改 3 参 |

**保留不动**（这些不是三件套）：

- `WRITE_RESTRICTED` 令牌与 restricting SID 列表（含 Everyone —— 它是 keep-alive 组成员，
  与「Everyone 的删除拒绝 ACE」是两回事，删掉会让早期 DLL init 以 0xC0000142 挂掉）；
- `hasExactGrant()` / `hasExactEntry()` 幂等跳过（避免每次授权重传播整棵树）；
- `withPathLock()` 的 per-path `LockFileEx` 互斥；
- control fd 相关的一切。

## import 说明符改写（让包自包含，不依赖 profile 的 node_modules）

| 文件 | 改写前 | 改写后 |
| --- | --- | --- |
| `lib/types-*.js` | `@deepseek-ai/dsh-win32-process` | `../../win32-process/lib/index.js` |
| `lib/types-*.js` | `@deepseek-ai/dsh-lazy-require` | `../../lazy-require/lib/index.js` |
| `lib/types-*.js` | `createLazyRequire("koffi", …)` | `createLazyRequire("../../koffi/index.cjs", …)`（createRequire 只能加载 CJS 入口） |
| `lib/runner.js` | `@deepseek-ai/dsh-subprocess/control` | `../../subprocess/lib/control.js` |
| `../win32-process/lib/index.js` | `@deepseek-ai/dsh-lazy-require` / `"koffi"` | 同上两条相对路径 |

## 校验值（打补丁后）

| 文件 | SHA256 |
| --- | --- |
| `lib/types-DxezulnA.js` | `B5768A245167971C47A2B2206C4DE689FBADA2B7794CD5FAA91E7EC69C3FDB21` |
| `lib/runner.js` | `46AC4A38A204CCA3A966E3BDA50940D268969676E0E372B9420A509E4B845673` |
| `lib/index.js` | `7DB8F646865BCD30F43DC0A6ED081F567280F756A0E0E8A0D853BCF69A5B8AEC` |
| `../win32-process/lib/index.js` | `A5568A4AFC1287A16E4CC23669EAD2D885B7AC92E7B886CD79B884C737727BC5` |

对照基准（**未打补丁**的 0.1.7-rc.2 原文件）：

| 文件 | SHA256（原） |
| --- | --- |
| `types-DxezulnA.js` | `E6014E930810E6A6699FEB78E6195A8180876CD9E99C2E74325E14C4807E0098` |
| `runner.js` | `B58ACCC84479211F41DE5E69288B679220D6D6639618DEB76586D6281B6BD247` |
| `win32-process/lib/index.js` | `622BC3A9E97C46E784FE41C9A0A8535DA2808019E4AC3F66D17CDAD70C9AC0C9` |

## 防回归断言（`.smoke/vendor-test.mjs`）

1. **回归防线**：`controlFileDescriptor` 在 vendor 的 ACL 包里命中 `≥3`（实测 runner 1 +
   types 4），且传递形态 `controlFileDescriptor: options.controlFileDescriptor` 在场；
   反向控制：0.1.5 参照包里必须命中 `0`。
2. **安全目标防线**：`S-1-16-4096` / `TokenIntegrityLevel` / `buildLowLabelAcl` /
   `addMandatoryAce` / `FILE_DELETE_CHILD` / `restrictTokenIntegrity` /
   `lowLabelSidPtr` / `worldSidPtr` 等 16 个符号在 `.js` 实现里 **0 命中**；
   反向控制：未打补丁的 0.1.7 参照包里同一批符号必须 `≥10` 命中。

---

以下是从 0.1.7-rc.2 原文件到本副本的**逐行前后对照**（由 `.sandbox/acl-vendor-upgrade-20260930-151200/patch.mjs` 自动生成，未经手工转录）。

# vendor 补丁 · 逐行前后对照

生成时间：2026-09-30T08:17:51.002Z

## 1. import 说明符改写

| 文件 | 改写前 | 改写后 |
| --- | --- | --- |
| `legacy-acl/lib/types-DxezulnA.js` | `} from "@deepseek-ai/dsh-win32-process";` | `} from "../../win32-process/lib/index.js";` |
| `legacy-acl/lib/types-DxezulnA.js` | `} from "@deepseek-ai/dsh-lazy-require";` | `} from "../../lazy-require/lib/index.js";` |
| `legacy-acl/lib/types-DxezulnA.js` | `createLazyRequire("koffi", import.meta.url)` | `createLazyRequire("../../koffi/index.cjs", import.meta.url)` |
| `legacy-acl/lib/runner.js` | `} from "@deepseek-ai/dsh-subprocess/control";` | `} from "../../subprocess/lib/control.js";` |
| `win32-process/lib/index.js` | `} from "@deepseek-ai/dsh-lazy-require";` | `} from "../../lazy-require/lib/index.js";` |
| `win32-process/lib/index.js` | `createLazyRequire("koffi", import.meta.url)` | `createLazyRequire("../../koffi/index.cjs", import.meta.url)` |

## 2. 补丁 A（令牌完整性）

### legacy-acl/lib/types-DxezulnA.js : 819-835

改动前（17 行）：

```js
/**
* Lower the restricted token's integrity level to Low (S-1-16-4096), the level
* the mandatory labels `grantWrite` applies are matched against; a token left
* at Medium would ignore them. Requires TOKEN_ADJUST_DEFAULT on the token;
* fails closed before any child is spawned.
* @param api - the binding table.
* @param token - the restricted token to lower.
* @param lowLabelSidPtr - the Low integrity SID (S-1-16-4096).
*/
function restrictTokenIntegrity(api, token, lowLabelSidPtr) {
	const sidLength = api.getLengthSid(lowLabelSidPtr);
	if (sidLength === 0) throwLastError$1(api, "GetLengthSid", "Low integrity label SID");
	const info = Buffer.alloc(16 + sidLength);
	info.writeBigUInt64LE(ptrAddress(lowLabelSidPtr), 0);
	info.writeUInt32LE(32, 8);
	if (api.setTokenInformation(token, 25, info, info.length) === 0) throwLastError$1(api, "SetTokenInformation", "TokenIntegrityLevel (Low)");
}
```

改动后（1 行）：

```js
/** PATCH (dsh-sandbox-legacy-acl): the restricted-token integrity downgrade is removed — the WRITE_RESTRICTED token keeps the caller's Medium integrity level, matching 0.1.5. The restricting SID list still governs every write. */
```


## 2. 补丁 A 调用点 + 补丁 B 调用点（AclSandbox.init）

### legacy-acl/lib/types-DxezulnA.js : 1186-1205

改动前（20 行）：

```js
			const lowLabelSid = makeWellKnownSid(api, 66);
			const worldSid = makeWellKnownSid(api, 1);
			this.sidAllocations.push(lowLabelSid, worldSid);
			if (this.manageDacls) {
				if (this.writeSidPtr !== void 0) {
					for (const path of this.writableDirs) grantWrite(api, path, this.writeSidPtr, lowLabelSid, worldSid);
					if (tempDir !== null && this.tempWriteSidPtr !== void 0) {
						this.grantedPaths.push({
							path: tempDir,
							sidPtr: this.tempWriteSidPtr
						});
						grantWrite(api, tempDir, this.tempWriteSidPtr, lowLabelSid, worldSid);
					}
				}
			}
			const logonSid = findLogonSid(api, currentToken);
			this.sidAllocations.push(logonSid);
			restrictedToken = createRestrictedToken(api, currentToken, logonSid, [this.writeSidPtr, this.tempWriteSidPtr].filter((sid) => sid !== void 0), { world: worldSid }, this.mode);
			restrictTokenIntegrity(api, restrictedToken, lowLabelSid);
			this.token = restrictedToken;
```

改动后（22 行）：

```js
	        /* PATCH (dsh-sandbox-legacy-acl): no label SID is created — the
	        grants never write the directory label. */
	        const worldSid = makeWellKnownSid(api, 1);
	        this.sidAllocations.push(worldSid);
	        if (this.manageDacls) {
	            if (this.writeSidPtr !== void 0) {
	                for (const path of this.writableDirs) grantWrite(api, path, this.writeSidPtr);
	                if (tempDir !== null && this.tempWriteSidPtr !== void 0) {
	                    this.grantedPaths.push({
	                        path: tempDir,
	                        sidPtr: this.tempWriteSidPtr
	                    });
	                    grantWrite(api, tempDir, this.tempWriteSidPtr);
	                }
	            }
	        }
	        const logonSid = findLogonSid(api, currentToken);
	        this.sidAllocations.push(logonSid);
	        restrictedToken = createRestrictedToken(api, currentToken, logonSid, [this.writeSidPtr, this.tempWriteSidPtr].filter((sid) => sid !== void 0), { world: worldSid }, this.mode);
	        /* PATCH (dsh-sandbox-legacy-acl): token integrity is left at the
	        caller's Medium — the upstream downgrade call is not made. */
	        this.token = restrictedToken;
```


## 2. 补丁 B（grantWrite 只写能力 ACE）

### legacy-acl/lib/types-DxezulnA.js : 196-202

改动前（7 行）：

```js
		addMandatoryAce: bind(advapi32, "AddMandatoryAce", "int", [
			PVOID,
			"uint32",
			"uint32",
			"uint32",
			PVOID
		]),
```

改动后（0 行）：

```js

```

### legacy-acl/lib/types-DxezulnA.js : 287-294

改动前（8 行）：

```js
* Each grant applies three edits in ONE SetNamedSecurityInfoW call: the
* capability-SID allow ACE, a Deny ACE that removes the ambient
* `FILE_DELETE_CHILD` right from the world SID, and a Low no-write-up
* mandatory label ({@link buildLowLabelAcl}). The deny is what keeps one
* granted root out of another's reach: Windows also authorizes a delete from
* the parent directory's `FILE_DELETE_CHILD` right, which the token's
* write-restricted intersection does not reach, and every granted root carries
* the Low label that clears the integrity check.
```

改动后（5 行）：

```js
 * Each grant applies ONE edit in a single SetNamedSecurityInfoW call: the
 * capability-SID allow ACE. PATCH (dsh-sandbox-legacy-acl): upstream's other
 * two edits (the world-SID directory-delete deny and the integrity label) are
 * removed, so a grant is exactly the ACE-only edit of 0.1.5. See
 * PATCH-NOTES.md.
```

### legacy-acl/lib/types-DxezulnA.js : 307-310

改动前（4 行）：

```js
* removes every ACE for the trustee. `inheritance` defaults to children of
* both kinds; the ambient-delete deny narrows it to containers because
* FILE_DELETE_CHILD is meaningless on a file and its bit would otherwise
* spread through the file's inherited mask.
```

改动后（2 行）：

```js
 * removes every ACE for the trustee. `inheritance` defaults to children of
 * both kinds (the shape every capability grant uses).
```

### legacy-acl/lib/types-DxezulnA.js : 383-408

改动前（26 行）：

```js
/**
* Read the directory's current explicit DACL and mandatory label via
* GetNamedSecurityInfoW.
* Allocation contract (the POC's RevokeAccess, minus its missing checks): the
* returned ACL pointer sits INSIDE the security descriptor allocation — only
* the descriptor may be LocalFree'd, and it must not be freed before
* SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself
* corrupts the heap (verified the hard way).
* @param api - the binding table.
* @param path - the directory whose DACL and label are read.
* @returns the current explicit DACL and label ACL (null when the directory carries none) plus their owning descriptor.
*/
function readCurrentSecurity(api, path) {
	const ownerSlot = allocPtrSlot();
	const groupSlot = allocPtrSlot();
	const daclSlot = allocPtrSlot();
	const saclSlot = allocPtrSlot();
	const descriptorSlot = allocPtrSlot();
	const readResult = api.getNamedSecurityInfoW(path, 1, 20, ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot);
	if (readResult !== 0) throwWin32(api, "GetNamedSecurityInfoW", readResult, path);
	return {
		oldAcl: decodePtr(daclSlot),
		labelAcl: decodePtr(saclSlot),
		descriptor: decodePtr(descriptorSlot)
	};
}
```

改动后（27 行）：

```js
/**
 * Read the directory's current explicit DACL via GetNamedSecurityInfoW.
 * PATCH (dsh-sandbox-legacy-acl): the label (SACL) read is dropped — grants
 * no longer touch the directory's label, so only the DACL is consulted and
 * only DACL_SECURITY_INFORMATION (4) is requested.
 * Allocation contract (the POC's RevokeAccess, minus its missing checks): the
 * returned ACL pointer sits INSIDE the security descriptor allocation — only
 * the descriptor may be LocalFree'd, and it must not be freed before
 * SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself
 * corrupts the heap (verified the hard way).
 * @param api - the binding table.
 * @param path - the directory whose DACL is read.
 * @returns the current explicit DACL (null when the directory carries none) plus its owning descriptor.
 */
function readCurrentSecurity(api, path) {
	const ownerSlot = allocPtrSlot();
	const groupSlot = allocPtrSlot();
	const daclSlot = allocPtrSlot();
	const saclSlot = allocPtrSlot();
	const descriptorSlot = allocPtrSlot();
	const readResult = api.getNamedSecurityInfoW(path, 1, 4, ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot);
	if (readResult !== 0) throwWin32(api, "GetNamedSecurityInfoW", readResult, path);
	return {
	    oldAcl: decodePtr(daclSlot),
	    descriptor: decodePtr(descriptorSlot)
	};
}
```

### legacy-acl/lib/types-DxezulnA.js : 409-448

改动前（40 行）：

```js
/**
* Build the Low mandatory label applied with every write grant: one
* SYSTEM_MANDATORY_LABEL_ACE naming `lowLabelSidPtr` with the no-write-up
* policy, inheriting to subcontainers and objects so later children carry the
* same label. The caller frees the returned ACL with LocalFree
* (SetNamedSecurityInfoW copies it); every Win32 call is checked and a
* half-built ACL is released before the error is thrown.
* @param api - the binding table.
* @param lowLabelSidPtr - the Low integrity SID (S-1-16-4096) the label names.
* @returns the ACL carrying the single inheritable label ACE.
*/
function buildLowLabelAcl(api, lowLabelSidPtr) {
	const sidLength = api.getLengthSid(lowLabelSidPtr);
	if (sidLength === 0) throwLastError$1(api, "GetLengthSid", "Low mandatory label SID");
	const aclLength = 16 + sidLength;
	const acl = api.localAlloc(64, aclLength);
	if (isNullPtr$1(acl)) throwLastError$1(api, "LocalAlloc", "Low mandatory label ACL");
	if (api.initializeAcl(acl, aclLength, 2) === 0) {
		const win32Code = api.getLastError();
		api.localFree(acl);
		throwWin32(api, "InitializeAcl", win32Code, "Low mandatory label ACL");
	}
	if (api.addMandatoryAce(acl, 2, 3, 1, lowLabelSidPtr) === 0) {
		const win32Code = api.getLastError();
		api.localFree(acl);
		throwWin32(api, "AddMandatoryAce", win32Code, "Low mandatory label ACL");
	}
	return acl;
}
/**
* True when the label ACL already carries the EXACT label this module would
* add (mandatory-label ACE, OI|CI inheritance, no-write-up policy, the Low
* SID), so a re-grant can skip the eager full-tree propagation.
* @param labelAcl - the current label ACL pointer (from {@link readCurrentSecurity}).
* @param lowLabelSidPtr - the Low integrity SID to match.
* @returns whether the exact label ACE is already present.
*/
function hasExactLabel(labelAcl, lowLabelSidPtr) {
	return hasExactEntry(labelAcl, 17, 3, 1, lowLabelSidPtr);
}
```

改动后（1 行）：

```js
/** PATCH (dsh-sandbox-legacy-acl): the label-ACL builder and its exact-label probe are removed — grants never write the directory label. */
```

### legacy-acl/lib/types-DxezulnA.js : 449-487

改动前（39 行）：

```js
/**
* Shared tail of grantWrite and revokeWrite: merge `entries` into `oldAcl`
* (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
* free the descriptor before applying the merged ACL, apply the merged DACL
* together with the label edit in one SetNamedSecurityInfoW call, then free
* every ACL this call owns — checking each call and reporting with the
* caller's label. The entry count derives from the buffer, so a grant can
* carry its capability ACE and its ambient-delete deny in one merge.
* @param api - the binding table.
* @param path - the directory the DACL and label edits apply to.
* @param entries - packed EXPLICIT_ACCESS_W records to merge (grant, deny, or revoke).
* @param oldAcl - the current explicit DACL (from {@link readCurrentSecurity}).
* @param labelEdit - the label change to apply alongside the DACL.
* @param descriptor - the descriptor allocation owning `oldAcl`.
* @param label - the caller's name for error details.
*/
function mergeAndApply(api, path, entries, oldAcl, labelEdit, descriptor, label) {
	const newAclSlot = allocPtrSlot();
	const mergeResult = api.setEntriesInAclW(entries.length / 48, entries, oldAcl, newAclSlot);
	if (mergeResult !== 0) {
		if (descriptor !== null) api.localFree(descriptor);
		if (labelEdit.kind === "apply") api.localFree(labelEdit.acl);
		throwWin32(api, "SetEntriesInAclW", mergeResult, `${label}(${path})`);
	}
	const newAcl = decodePtr(newAclSlot);
	if (newAcl === null) {
		if (descriptor !== null) api.localFree(descriptor);
		if (labelEdit.kind === "apply") api.localFree(labelEdit.acl);
		throwWin32(api, "SetEntriesInAclW", api.getLastError(), `${label}(${path}): null new ACL`);
	}
	const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null;
	const applyResult = api.setNamedSecurityInfoW(path, 1, labelEdit.kind === "keep" ? 4 : 20, null, null, newAcl, labelEdit.kind === "apply" ? labelEdit.acl : null);
	const freedNew = api.localFree(newAcl);
	const freedLabel = labelEdit.kind === "apply" ? api.localFree(labelEdit.acl) : null;
	if (applyResult !== 0) throwWin32(api, "SetNamedSecurityInfoW", applyResult, `${label}(${path})`);
	if (freedDescriptor !== null && !isNullPtr$1(freedDescriptor)) throwLastError$1(api, "LocalFree", `${label}(${path}) descriptor`);
	if (!isNullPtr$1(freedNew)) throwLastError$1(api, "LocalFree", `${label}(${path}) new ACL`);
	if (freedLabel !== null && !isNullPtr$1(freedLabel)) throwLastError$1(api, "LocalFree", `${label}(${path}) label ACL`);
}
```

改动后（34 行）：

```js
/**
 * Shared tail of grantWrite and revokeWrite: merge `entry` into `oldAcl`
 * (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
 * free the descriptor before applying the merged ACL, apply it, then free the
 * merged ACL — checking every call and reporting with the caller's label.
 * PATCH (dsh-sandbox-legacy-acl): upstream's `labelEdit` parameter is gone —
 * SetNamedSecurityInfoW is always called with DACL_SECURITY_INFORMATION (4)
 * alone, so the directory label is never rewritten.
 * @param api - the binding table.
 * @param path - the directory the DACL edit applies to.
 * @param entry - the EXPLICIT_ACCESS_W to merge (grant or revoke).
 * @param oldAcl - the current explicit DACL (from {@link readCurrentSecurity}).
 * @param descriptor - the descriptor allocation owning `oldAcl`.
 * @param label - the caller's name for error details.
 */
function mergeAndApply(api, path, entry, oldAcl, descriptor, label) {
	const newAclSlot = allocPtrSlot();
	const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot);
	if (mergeResult !== 0) {
	    if (descriptor !== null) api.localFree(descriptor);
	    throwWin32(api, "SetEntriesInAclW", mergeResult, `${label}(${path})`);
	}
	const newAcl = decodePtr(newAclSlot);
	if (newAcl === null) {
	    if (descriptor !== null) api.localFree(descriptor);
	    throwWin32(api, "SetEntriesInAclW", api.getLastError(), `${label}(${path}): null new ACL`);
	}
	const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null;
	const applyResult = api.setNamedSecurityInfoW(path, 1, 4, null, null, newAcl, null);
	const freedNew = api.localFree(newAcl);
	if (applyResult !== 0) throwWin32(api, "SetNamedSecurityInfoW", applyResult, `${label}(${path})`);
	if (freedDescriptor !== null && !isNullPtr$1(freedDescriptor)) throwLastError$1(api, "LocalFree", `${label}(${path}) descriptor`);
	if (!isNullPtr$1(freedNew)) throwLastError$1(api, "LocalFree", `${label}(${path}) new ACL`);
}
```

### legacy-acl/lib/types-DxezulnA.js : 530-562

改动前（33 行）：

```js
/**
* True when the explicit DACL already carries the EXACT ambient-delete deny:
* the container-inherited Deny ACE for {@link abi.FILE_DELETE_CHILD} naming
* the world SID. It is part of the idempotent skip, so a root granted by an
* earlier build receives the deny on its next provision.
* @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
* @param worldSidPtr - the Everyone SID the deny names.
* @returns whether the exact deny ACE is already present.
*/
function hasExactDeny(oldAcl, worldSidPtr) {
	return hasExactEntry(oldAcl, 1, 2, 64, worldSidPtr);
}
/**
* True when a capability grant for a SID OTHER than `sidPtr` stands on this
* DACL — the condition under which a revoke must leave the shared Low label in
* place, or the remaining grant's child would lose its write authority.
* @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
* @param sidPtr - the capability SID being revoked.
* @returns whether another capability grant remains.
*/
function hasForeignGrant(oldAcl, sidPtr) {
	const aclSize = decodeUint16At(oldAcl, 2);
	const aceCount = decodeUint16At(oldAcl, 4);
	if (aclSize < 8 || aclSize > 1048576) return false;
	let offset = 8;
	for (let index = 0; index < aceCount; index++) {
		const aceSize = decodeUint16At(oldAcl, offset + 2);
		if (aceSize < 8 || offset + aceSize > aclSize) return false;
		if (decodeUint8At(oldAcl, offset) === 0 && decodeUint32At(oldAcl, offset + 4) === 1114454 && !sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true;
		offset += aceSize;
	}
	return false;
}
```

改动后（1 行）：

```js
/** PATCH (dsh-sandbox-legacy-acl): the world-deny probe and the foreign-grant probe are removed — the deny no longer exists and a revoke no longer depends on a shared label. */
```

### legacy-acl/lib/types-DxezulnA.js : 563-608

改动前（46 行）：

```js
/**
* Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the capability SID
* on `path`, deny the world SID the ambient `FILE_DELETE_CHILD` right, and
* apply the Low mandatory label — one merge. The deny inherits to containers
* only: the right is evaluated on directories, and inheriting its bit onto
* files would deny every `FILE_ALL_ACCESS`/`GENERIC_ALL` open inside the root
* (0x40 is a member of that mask). The capability ACE's DELETE bit is then the
* only delete authority inside the root, so a file whose own DACL grants no
* DELETE is no longer deletable through its parent's rights.
*
* Idempotent: the exact ACE, deny, and label together SKIP the
* SetNamedSecurityInfoW apply, which would otherwise re-propagate the
* identical descriptor across the whole tree (eager inheritance; minutes on
* large workspaces). Otherwise read-merge-write, so pre-existing explicit ACEs
* survive (same shape as {@link revokeWrite}). Runs under the per-path lock.
* The directory must be owned by the caller AND grant WRITE_OWNER (the label
* lives in the SACL; owner-implicit rights cover only READ_CONTROL and
* WRITE_DAC) — a Full-control workspace satisfies both.
* @param api - the binding table.
* @param path - the directory whose DACL and label gain the grant (the workspace or temp root).
* @param sidPtr - the capability SID the ACE names.
* @param lowLabelSidPtr - the Low integrity SID the mandatory label names.
* @param worldSidPtr - the Everyone SID the ambient-delete deny names.
*/
function grantWrite(api, path, sidPtr, lowLabelSidPtr, worldSidPtr) {
	withPathLock(api, path, () => {
		const { oldAcl, labelAcl, descriptor } = readCurrentSecurity(api, path);
		if (oldAcl !== null && labelAcl !== null && hasExactGrant(oldAcl, sidPtr) && hasExactDeny(oldAcl, worldSidPtr) && hasExactLabel(labelAcl, lowLabelSidPtr)) {
			if (descriptor !== null) {
				if (!isNullPtr$1(api.localFree(descriptor))) throwLastError$1(api, "LocalFree", `grantWrite(${path}) descriptor`);
			}
			return;
		}
		let label;
		try {
			label = buildLowLabelAcl(api, lowLabelSidPtr);
		} catch (error) {
			if (descriptor !== null) api.localFree(descriptor);
			throw error;
		}
		mergeAndApply(api, path, Buffer.concat([buildExplicitAccess(worldSidPtr, 3, 64, 2), buildExplicitAccess(sidPtr, 1, GRANT_MASK)]), oldAcl, {
			kind: "apply",
			acl: label
		}, descriptor, "grantWrite");
	});
}
```

改动后（28 行）：

```js
/**
 * Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the capability SID
 * on `path`, inheriting to subcontainers and objects. Idempotent: when the
 * directory's current explicit DACL already carries the exact ACE (the
 * per-session grant surviving from a previous server lifetime), the
 * SetNamedSecurityInfoW apply is SKIPPED — it would otherwise re-propagate
 * the identical ACE across the whole tree (eager inheritance; minutes on
 * large workspaces). Otherwise read-merge-write: the new ACE merges into the
 * directory's CURRENT explicit DACL (same shape as {@link revokeWrite}), so
 * pre-existing explicit ACEs survive. Runs under the per-path lock.
 * PATCH (dsh-sandbox-legacy-acl): upstream's world-SID deny and integrity
 * label are gone — this writes the capability allow ACE and nothing else.
 * @param api - the binding table.
 * @param path - the directory whose DACL gains the grant (the workspace or temp root).
 * @param sidPtr - the capability SID the ACE names.
 */
function grantWrite(api, path, sidPtr) {
	withPathLock(api, path, () => {
	    const { oldAcl, descriptor } = readCurrentSecurity(api, path);
	    if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr)) {
	        if (descriptor !== null) {
	            if (!isNullPtr$1(api.localFree(descriptor))) throwLastError$1(api, "LocalFree", `grantWrite(${path}) descriptor`);
	        }
	        return;
	    }
	    mergeAndApply(api, path, buildExplicitAccess(sidPtr, 1, GRANT_MASK), oldAcl, descriptor, "grantWrite");
	});
}
```

### legacy-acl/lib/types-DxezulnA.js : 609-636

改动前（28 行）：

```js
/**
* Remove every ACE for the capability SID from the directory DACL (REVOKE_ACCESS
* merge — other entries are preserved). The shared Low label is cleared only
* when no other capability grant remains on the directory: two grants may
* target one directory, and the surviving one still needs the label for its
* child's writes. Returns whether an ACE removal was attempted (false when the
* directory carries no DACL at all).
*
* Runs under the per-path lock (the whole get-merge-set sequence); the
* descriptor/ACL allocation contract lives on {@link readCurrentSecurity}.
* @param api - the binding table.
* @param path - the directory whose DACL loses the capability-SID ACEs.
* @param sidPtr - the capability SID whose ACEs are removed.
* @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
*/
function revokeWrite(api, path, sidPtr) {
	return withPathLock(api, path, () => {
		const { oldAcl, descriptor } = readCurrentSecurity(api, path);
		if (oldAcl === null) {
			if (descriptor !== null) {
				if (!isNullPtr$1(api.localFree(descriptor))) throwLastError$1(api, "LocalFree", `revokeWrite(${path}) descriptor`);
			}
			return false;
		}
		mergeAndApply(api, path, buildExplicitAccess(sidPtr, 4, 0), oldAcl, hasForeignGrant(oldAcl, sidPtr) ? { kind: "keep" } : { kind: "clear" }, descriptor, "revokeWrite");
		return true;
	});
}
```

改动后（27 行）：

```js
/**
 * Remove every ACE for the capability SID from the directory DACL (REVOKE_ACCESS
 * merge — other entries are preserved). Returns whether an ACE removal was
 * attempted (false when the directory carries no DACL at all).
 *
 * Runs under the per-path lock (the whole get-merge-set sequence); the
 * descriptor/ACL allocation contract lives on {@link readCurrentSecurity}.
 * PATCH (dsh-sandbox-legacy-acl): the shared label is never written, so a
 * revoke no longer inspects neighbouring grants to decide whether to keep it.
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the capability-SID ACEs.
 * @param sidPtr - the capability SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
function revokeWrite(api, path, sidPtr) {
	return withPathLock(api, path, () => {
	    const { oldAcl, descriptor } = readCurrentSecurity(api, path);
	    if (oldAcl === null) {
	        if (descriptor !== null) {
	            if (!isNullPtr$1(api.localFree(descriptor))) throwLastError$1(api, "LocalFree", `revokeWrite(${path}) descriptor`);
	        }
	        return false;
	    }
	    mergeAndApply(api, path, buildExplicitAccess(sidPtr, 4, 0), oldAcl, descriptor, "revokeWrite");
	    return true;
	});
}
```

### legacy-acl/lib/types-DxezulnA.js : 908-918

改动前（11 行）：

```js
/**
* One write SID's provider-lifetime grant materialization: the parsed SID
* pointer plus every directory whose DACL currently carries its ACE and whose
* label ACL carries the Low mandatory label. Workspace paths are added
* STANDING (their security descriptor edits are the cross-session reuse cache
* and outlive the grant — dispose() skips revoking them, or the next
* provision would re-propagate the whole tree); temp paths are revocable
* (dispose() revokes them — an inheritable ACE must not outlive its
* session's temp directory). Create with {@link AclWriteGrant.create};
* dispose revokes the revocable paths and frees every SID.
*/
```

改动后（12 行）：

```js
/**
 * One write SID's provider-lifetime grant materialization: the parsed SID
 * pointer plus every directory whose DACL currently carries its ACE.
 * Workspace paths are added STANDING (their security descriptor edits are the
 * cross-session reuse cache and outlive the grant — dispose() skips revoking
 * them, or the next provision would re-propagate the whole tree); temp paths
 * are revocable (dispose() revokes them — an inheritable ACE must not outlive
 * its session's temp directory). Create with {@link AclWriteGrant.create};
 * dispose revokes the revocable paths and frees the SID.
 * PATCH (dsh-sandbox-legacy-acl): the grant carries no label and no world
 * deny, so no extra SIDs are parsed or owned here.
 */
```

### legacy-acl/lib/types-DxezulnA.js : 923-925

改动前（3 行）：

```js
	sidPtr;
	lowLabelSidPtr;
	worldSidPtr;
```

改动后（1 行）：

```js
	sidPtr;
```

### legacy-acl/lib/types-DxezulnA.js : 928-934

改动前（7 行）：

```js
	constructor(api, sidPtr, lowLabelSidPtr, worldSidPtr, writeSid) {
		this.api = api;
		this.sidPtr = sidPtr;
		this.lowLabelSidPtr = lowLabelSidPtr;
		this.worldSidPtr = worldSidPtr;
		this.writeSid = writeSid;
	}
```

改动后（5 行）：

```js
	constructor(api, sidPtr, writeSid) {
	    this.api = api;
	    this.sidPtr = sidPtr;
	    this.writeSid = writeSid;
	}
```

### legacy-acl/lib/types-DxezulnA.js : 935-943

改动前（9 行）：

```js
	/**
	* Parse the SID string, create the Low integrity SID the grants label with
	* and the world SID their ambient-delete deny names, and open the binding
	* table (lazily, once per server). Fail-closed: any failure throws — nothing
	* is granted yet.
	* @param writeSid - the workspace (`S-1-4-x-y`) or temp (`S-1-4-x-y-1`) capability SID string.
	* @param api - optional already-resolved bindings (tests).
	* @returns the ready grant (no ACEs yet).
	*/
```

改动后（8 行）：

```js
	/**
	* Parse the SID string and open the binding table (lazily, once per
	* server). Fail-closed: any failure throws — nothing is granted yet.
	* PATCH (dsh-sandbox-legacy-acl): only the capability SID is parsed.
	* @param writeSid - the workspace (`S-1-4-x-y`) or temp (`S-1-4-x-y-1`) capability SID string.
	* @param api - optional already-resolved bindings (tests).
	* @returns the ready grant (no ACEs yet).
	*/
```

### legacy-acl/lib/types-DxezulnA.js : 944-962

改动前（19 行）：

```js
	static create(writeSid, api) {
		const bindings = api ?? win32Sync();
		const sidSlot = allocPtrSlot();
		if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0) throwLastError$1(bindings, "ConvertStringSidToSidW", writeSid);
		const sidPtr = decodePtr(sidSlot);
		if (sidPtr === null) throwLastError$1(bindings, "ConvertStringSidToSidW", `null SID for ${writeSid}`);
		try {
			const lowLabelSidPtr = makeWellKnownSid(bindings, 66);
			try {
				return new AclWriteGrant(bindings, sidPtr, lowLabelSidPtr, makeWellKnownSid(bindings, 1), writeSid);
			} catch (error) {
				bindings.localFree(lowLabelSidPtr);
				throw error;
			}
		} catch (error) {
			bindings.localFree(sidPtr);
			throw error;
		}
	}
```

改动后（13 行）：

```js
	static create(writeSid, api) {
	    const bindings = api ?? win32Sync();
	    const sidSlot = allocPtrSlot();
	    if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0) throwLastError$1(bindings, "ConvertStringSidToSidW", writeSid);
	    const sidPtr = decodePtr(sidSlot);
	    if (sidPtr === null) throwLastError$1(bindings, "ConvertStringSidToSidW", `null SID for ${writeSid}`);
	    try {
	        return new AclWriteGrant(bindings, sidPtr, writeSid);
	    } catch (error) {
	        bindings.localFree(sidPtr);
	        throw error;
	    }
	}
```

### legacy-acl/lib/types-DxezulnA.js : 963-977

改动前（15 行）：

```js
	/**
	* Grant the write ACE, the ambient-delete deny, and the Low mandatory label
	* on one directory (idempotent: an already-standing exact ACE, deny, and
	* label skip the eager full-tree re-propagation — see {@link grantWrite})
	* and record the path for {@link dispose} unless it is standing. The path is
	* recorded BEFORE the grant: a post-apply throw (a LocalFree failure after
	* SetNamedSecurityInfoW succeeded) must still revoke it, and revoking an
	* ungranted path is a no-op merge. Callers treat a throw as a failed
	* materialization and dispose the instance to revoke the paths granted so
	* far.
	* @param path - the directory whose DACL and label gain the grant.
	* @param standing - the edits outlive this grant (the workspace reuse
	*   cache; dispose() skips revoking it). Default false (revoked on
	*   dispose — the temp-directory lifecycle).
	*/
```

改动后（14 行）：

```js
	/**
	* Grant the write ACE on one directory (idempotent: an already-standing
	* exact ACE skips the eager full-tree re-propagation — see
	* {@link grantWrite}) and record the path for {@link dispose} unless it is
	* standing. The path is recorded BEFORE the grant: a post-apply throw (a
	* LocalFree failure after SetNamedSecurityInfoW succeeded) must still
	* revoke it, and revoking an ungranted path is a no-op merge. Callers treat
	* a throw as a failed materialization and dispose the instance to revoke
	* the paths granted so far.
	* @param path - the directory whose DACL gains the grant.
	* @param standing - the edits outlive this grant (the workspace reuse
	*   cache; dispose() skips revoking it). Default false (revoked on
	*   dispose — the temp-directory lifecycle).
	*/
```

### legacy-acl/lib/types-DxezulnA.js : 978-981

改动前（4 行）：

```js
	add(path, standing = false) {
		(standing ? this.standingPaths : this.revocablePaths).push(path);
		grantWrite(this.api, path, this.sidPtr, this.lowLabelSidPtr, this.worldSidPtr);
	}
```

改动后（4 行）：

```js
	add(path, standing = false) {
	    (standing ? this.standingPaths : this.revocablePaths).push(path);
	    grantWrite(this.api, path, this.sidPtr);
	}
```

### legacy-acl/lib/types-DxezulnA.js : 986-1004

改动前（19 行）：

```js
	/** Revoke every revocable grant (standing security descriptor edits stay) and free the SIDs; reports every cleanup failure. */
	dispose() {
		const failures = [];
		for (const path of this.revocablePaths) try {
			revokeWrite(this.api, path, this.sidPtr);
		} catch (error) {
			failures.push(error);
		}
		for (const [label, sidPtr] of [
			["write SID", this.sidPtr],
			["Low label SID", this.lowLabelSidPtr],
			["world SID", this.worldSidPtr]
		]) try {
			if (!isNullPtr$1(this.api.localFree(sidPtr))) throwLastError$1(this.api, "LocalFree", label);
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`);
	}
```

改动后（15 行）：

```js
	/** Revoke every revocable grant (standing security descriptor edits stay) and free the SID; reports every cleanup failure. */
	dispose() {
	    const failures = [];
	    for (const path of this.revocablePaths) try {
	        revokeWrite(this.api, path, this.sidPtr);
	    } catch (error) {
	        failures.push(error);
	    }
	    try {
	        if (!isNullPtr$1(this.api.localFree(this.sidPtr))) throwLastError$1(this.api, "LocalFree", "write SID");
	    } catch (error) {
	        failures.push(error);
	    }
	    if (failures.length > 0) throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`);
	}
```
