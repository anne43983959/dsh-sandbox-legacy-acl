# dsh-sandbox-legacy-acl

> DSH 宿主插件：让 **0.1.7 的 Windows ACL 沙箱回退到 0.1.5 的授权行为** —— 授权工作区时只写能力 SID 的允许 ACE，不再降级令牌完整性、不再写 world 删除拒绝。
>
> ⚠️ vendor = **0.1.7-rc.2 的包 + 两处补丁**，**不是** 0.1.5 的包 —— 0.1.5 没有 control fd 支持，
> 换上去会让 `run_code` 的 worker 起不来（整条工具链瘫痪）。来龙去脉见 §7.0。

---

## 0. 版本支持（2026-10-02 实测判定）

| DSH | 可用性 | 依据 |
| --- | --- | --- |
| `0.1.5-rc.3` | ✅ **不需要**本插件 | 0.1.5 原生就是「只写能力 ACE」档 |
| `0.1.7-rc.2` | ✅ **实测在用** | vendor = 0.1.7-rc.2 整包 + 补丁 A/B；两处改点均已生效 |
| `0.2.0-rc.2` | ✅ **同一份 vendor 通用，不做版本分流** | 见下 |

**为什么 0.2.0 可以直接用同一份 vendor**（静态判据，2026-10-02 核对）：

1. 本插件的接管方式是**进程内两处改点**，**不替换 npm 包解析**（vendor 经 `import(pathToFileURL(...))` 动态加载）；
2. 两个锚点在两代**原样存在**：`materializeAclGrant` 2/2、`internals.windowsAclRunnerArgs` 1/1、`internals` 13/13；
3. 被替换的核心符号计数**逐项一致**：`AclSandbox` 17/17、`AclWriteGrant` 6/6、`grantWrite` 9/9、`restrictTokenIntegrity` 2/2、`workspaceWriteSid` 4/4；`runner.js` 两代 189 行**逐字相同**（只差 import 别名）；
4. 0.2.0 的 `dsh-sandbox-windows-acl` 真正的增量是**诊断技能**（`ACL_DIAGNOSIS_SKILL` + `registerAclDiagnosisSkill`），与其三件套写入逻辑无关。

> **0.2.0 上的一个已知共存现象**：0.2.0 的 provider 在 `process.platform === "win32" && this.runnerCommand === void 0` 时注册 `diagnose-windows-sandbox-acl` 技能。
> 本插件改的是 `internals.windowsAclRunnerArgs`（**另一个字段**），故该技能**仍会注册**；沙箱退档后它没有三件套可诊断，属**无害空转**。

---
## 1. 为什么存在

DSH 在 Windows 上用「受限令牌 + ACL」实现沙箱。从 **0.1.7-alpha.1** 起，每次对工作区根授权时会一次性写入三条 Windows 安全设置（以下简称**三件套**）：

| 组成 | 形态 | 作用 | 从哪一版开始 |
| --- | --- | --- | --- |
| 能力 SID 允许 ACE | `S-1-4-x-y:(OI)(CI)(W,D,DC)` | 写白名单本体 | 0.1.5 就有 |
| world 删除拒绝 | `Everyone:(CI)(DENY)(DC)` | 挡住「靠父目录 FILE_DELETE_CHILD 删文件」 | **0.1.7 新增** |
| 低完整性标签 | `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` | no-write-up 强制策略 | **0.1.7 新增** |

后两条**写在用户的工作区根目录上，且永不自动撤销**，实际后果：

- 文件在资源管理器里**删不掉**（回收站也走不动）；
- Explorer **预览失败**，或提示「这些文件可能有害」；
- 标签**继承外溢**到之后新建的每一个文件/子目录。

作者（使用者）决定**接受固有安全缺陷**，回到 0.1.5 的行为。本插件就是那个回退。

---

## 2. ⚠️ 接受的安全缺陷（这是一个**降级**，不是修复）

去掉后两件之后，**下面两条官方论证描述的防护全部消失**。原文出自 deepseek-ai/deepseek-harness 仓库的
`.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md`：

> WRITE_RESTRICTED 只对写访问做交集检查……该交集只覆盖对象自身的那次访问检查，而 Windows 也会依据父目录的
> FILE_DELETE_CHILD 权限批准写入或删除——**只要调用者的环境 SID 持有 Modify，`cmd /c del` 就能删除工作区之外的文件**。
> 所以令牌还会被降级为 Low 完整性，每个被授权目录都在添加 ACE 的同一次调用中收到 Low 禁止上调强制标签……
> 无论权限来自哪一项，内核都会在访问检查内部执行该策略。

> 由于每个授权根目录都被标记为 Low，仅靠完整性检查仍会让一个受限子进程删除另一个授权根目录内的文件，
> 因此每次授权还会向 world SID 拒绝 FILE_DELETE_CHILD。

两条论证合起来就是本插件主动放弃的两项属性：

1. **工作区之外的删除**：受限子进程可能越过写白名单，删除工作区之外的、调用者本来就有权删除的文件；
2. **授权根之间的互删**：一个受限子进程可能删除**另一个**已授权根目录内的文件（0.1.5 时代就有的固有属性，
   0.1.7 用 world 删除拒绝补上了它）。

**写白名单本身仍然有效**：能力 SID 允许 ACE 照写，`WRITE_RESTRICTED` 受限令牌照建（自检里断言了
`WRITE_RESTRICTED` / `restricting` 仍在）。被放弃的只有「完整性降级」与「world 删除拒绝」这两层加固。

> 这是使用者的**知情取舍**：他明确选择用「更弱的沙箱」换「Explorer 里能正常删文件」。

---

## 3. 它改了什么（两个改点，**原子**生效）

三件套的代码全部封闭在 `@deepseek-ai/dsh-sandbox-windows-acl` 一个包里，但**运行时由两个不同的执行体分别写入**，
所以必须同时改两处：

| # | 改点 | 改前（0.1.7） | 改后（本插件） |
| --- | --- | --- | --- |
| ① | **ACE 写入**（seam 进程内） | `LocalSandboxProvider.materializeAclGrant()` → `AclWriteGrant.add()`：写能力 ACE **+ Low 标签 + world 删除拒绝** | 换成 vendor 里**打过补丁的 `AclWriteGrant`**（补丁 B）：`add()` 只写能力 ACE |
| ② | **令牌完整性降级**（runner 进程内） | `lib/runner.js` → `AclSandbox.init()` 里 `restrictTokenIntegrity(...)` 是**裸调用**，不受 `manageDacls` 影响 | 把 `internals.windowsAclRunnerArgs` 指向 **vendor 里那同一个补丁包的 `lib/runner.js`**（补丁 A 已把降级调用删掉） |

> **seam 与 runner 同源**：两处改点指向的都是同一份 vendor（0.1.7-rc.2 + 补丁 A/B），
> 不存在「seam 走 0.1.5 语义、runner 走 0.1.7 语义」这种混搭。**前置检查里有一条硬门槛**：
> vendor 的 runner 必须支持 control fd（源码里出现 `controlFileDescriptor`），不支持就**拒绝接管** ——
> 绝不允许「接管了但 `run_code` 坏掉」。

⚠️ **必须成对**：只改 ① 会让目录有 ACE 却没有 Low 标签，而令牌仍被降到 Low —— no-write-up 之下**写入静默失败**，
比不改还糟。所以本插件是**原子**的：任一前置检查不通过，**一处都不改**，并在报告里写明原因（fail-closed）。

> `manageDacls: false` **不能**用来实现本目标：它只跳过 DACL 写入，`restrictTokenIntegrity(...)` 那行是裸调用，
> 令牌照样被降级。

---

## 4. 安装

与其它本地插件同款（符号链接 + `cordis.patch.yml` 的 `- insert` 段）：

1. 在目标 home 的 profile 下建符号链接：
   `<home>\profiles\<profile>\node_modules\dsh-sandbox-legacy-acl` → 本目录；
2. 在该 profile 的 `cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: sandbox-legacy-acl
         name: dsh-sandbox-legacy-acl
   ```

3. **重启实例**（宿主半在启动时装载；刷新页面无效）。

**关闭 / 回滚**（两级）：

- 运行时开关：环境变量 `DSH_LEGACY_ACL=0` → 插件**完全不接管**（不注入、不改任何东西，只落一条 disabled 报告）；
- 彻底卸载：删掉 insert 段与符号链接。

> 本插件**只对 0.1.7 有意义**。装在 0.1.5 上无害（0.1.5 的 provider 也有同名方法与同一个 `internals` seam，
> 覆盖后写出的 ACE 与原生完全一致），但没必要装。

---

## 5. 生效与验证

### 5.1 报告文件（实机核对入口）

全部结论落盘到 **`$DSH_HOME/sandbox-legacy-acl/report.json`**（`DSH_HOME` 缺失时退到 cwd）。
**不注册 `/api` 路由**：少一个失败面，且那条路由本来就要会话令牌（shell 里 curl 会吃 401）。
报告带 `probeVersion`（当前 `2`；v2 新增 `vendor.patched` / `preflight.fields.controlFd`），字段结构一变就 +1。

关键字段：

| 字段 | 含义 |
| --- | --- |
| `status` | `installed` / `refused` / `disabled` / `error` / `uninstalled` |
| `reason` | 人话原因（拒绝时写明差在哪几项） |
| `preflight.problems` | 前置检查逐条结果（为空才算通过） |
| `preflight.fields` | provider 形状探针（方法/Map/internals 是否存在） |
| `override.runnerArgs` | 实际写进去的 runner 覆盖值 |
| `override.granted` | **实机证据**：每次真正用 legacy 路径授权时追加一条（workspace / temp + SID + `aceOnly: true`） |
| `decisions` | 时间线（apply / installed / already-installed / refused / uninstalled + 每次授权） |

`override.granted` 是刻意加的：「装上了但没生效」和「真的在走 legacy 路径」必须能从报告里区分开 ——
跑一条命令后再看这个数组有没有新条目即可。

### 5.2 期望形态（只读核对）

回退生效后，工作区根的 ACL 应该长这样（本次已在 **0.1.5 写入的工作区**上实测作为基线）：

```powershell
icacls "<工作区根>"
# 期望：Mandatory Label\Medium Mandatory Level:(NW)      ← 普通目录的默认标签
#       **没有** Everyone:(CI)(DENY)(DC) 这一行
#       **没有** Low Mandatory Level
```

### 5.3 实机验证清单（装完 + 重启后）

1. 读 `$DSH_HOME/sandbox-legacy-acl/report.json` → `status` 应为 `installed`，`preflight.problems` 为空；
2. 在该 home 里跑任意一条被沙箱包的 `pwsh` 命令（触发一次工作区授权）→ 报告 `override.granted` 应出现
   `kind: "workspace"` 的条目（`aceOnly: true`）；
3. `icacls <工作区根>` → 应有 Medium 标签、**无** Low 标签、**无** Everyone 拒绝 ACE；
4. 资源管理器里试删一个工作区内文件 → 应该**能删**（不再是 0.1.7 的删不掉）；
5. 反例：把 `DSH_LEGACY_ACL=0` 传进实例环境后重启 → 报告 `status: "disabled"`，`icacls` 回到 0.1.7 形态。

---

## 6. 已经写进去的残留**不会**自动撤销

本插件只阻止**新的**三件套写入。**在它生效之前 0.1.7 已经写上去的 Low 标签与 world 删除拒绝会留在原地**，
而且标签会沿着新建文件继续继承。清理需要针对**每一个**被授权过的工作区根目录手工做。

先看现状（只读）：

```powershell
icacls "<工作区根>" | Select-String 'Mandatory|Everyone'
```

参考做法（**本次未实测**，先拿一个可弃目录试；Low → Medium 是普通目录的默认标签，等于把 no-write-up 解除）：

```powershell
# 1) 去掉 world 删除拒绝（Everyone = S-1-1-0）
icacls "<工作区根>" /remove:d "*S-1-1-0"
# 2) 把 Low 标签改回普通目录的 Medium（标签 ACL 会被替换为 Medium）
icacls "<工作区根>" /setintegritylevel Medium
```

> ⚠️ 这两条属于**不可逆的系统状态改动**（`/remove:d` 删的是安全描述符里的 ACE），执行前请按使用者的
> 「先呈报后执行」规则走一遍。**在写这份 README 时它们没有被实机验证**，见 §9。

---

## 7. vendor 里是什么

插件**自包含**，不依赖任何 home / 版本目录一直在。

### 7.0 版本策略（2026-09-30 修正：从 0.1.5 换成 0.1.7 + 两处补丁）

早先 vendor 放的是 **0.1.5-rc.3 整包**。那是个错误：0.1.7 的 `run_code` worker 是独立 Node 进程，
靠 **fd 7（control channel）** 与主进程通信，而 0.1.5 的 `spawnSandboxedInherited` **不支持
`controlFileDescriptor`**（0.1.5 整包命中 **0** 次）→ 受限 spawn 出来的 worker 拿不到合法 fd，
`node:net` 抛 `ERR_INVALID_FD_TYPE`，**整条工具链（read / write / pwsh 全走 `run_code`）瘫痪**。

现在 vendor = **0.1.7-rc.2 的包 + 两处补丁 + import 改写**。逐行前后对照见
[`vendor/legacy-acl/PATCH-NOTES.md`](vendor/legacy-acl/PATCH-NOTES.md)（由打补丁脚本自动生成，非手工转录）。

| vendor 目录 | 来源 | 版本 | 说明 |
| --- | --- | --- | --- |
| `vendor/legacy-acl/` | `@deepseek-ai/dsh-sandbox-windows-acl` | 0.1.7-rc.2 | **补丁 A + 补丁 B 打在这里** |
| `vendor/win32-process/` | `@deepseek-ai/dsh-win32-process` | 0.1.7-rc.2 | 仅 import 改写 |
| `vendor/lazy-require/` | `@deepseek-ai/dsh-lazy-require` | 0.1.7-rc.2 | 0.1.7 新增的依赖（0.1.5 没有） |
| `vendor/subprocess/` | `@deepseek-ai/dsh-subprocess` | 0.1.7-rc.2 | 只取 `lib/control.js`（control fd 的常量 7 与 `DSH_SUBPROCESS_CONTROL`）；主入口会拉 `@deepseek-ai/cordis`，**未**复制 |
| `vendor/koffi/` | `koffi` | 3.3.1 | 与 0.1.5 那份同版本，未动 |
| `vendor/@koromix/koffi-win32-x64/` | `@koromix/koffi-win32-x64` | 3.3.1 | 同上（兄弟目录布局，见 §7.3） |

复制时**不带 `node_modules/`**（pnpm 在包目录下放的是依赖链接与 `.bin`，不属于包自身）。

### 7.1 两处补丁（逐行对照在 PATCH-NOTES.md）

| 补丁 | 位置 | 做了什么 |
| --- | --- | --- |
| **A · 令牌完整性** | `lib/types-DxezulnA.js` 的 `restrictTokenIntegrity()` 定义 + `AclSandbox.init()` 里的调用 | 两处一起删 → 令牌保持 Medium |
| **B · 只写能力 ACE** | 同文件的 `grantWrite` / `revokeWrite` / `mergeAndApply` / `readCurrentSecurity` / `AclWriteGrant` / abi 表 | Low 标签与 Everyone 删除拒绝的**构造代码全部删除**（`.js` 面 0 命中，自检守着），`grantWrite` 只写能力 SID 的 allow ACE |

**保留不动**：`WRITE_RESTRICTED` 令牌与 restricting SID 列表（含 Everyone —— 它是 keep-alive 组成员，
与「Everyone 的删除拒绝 ACE」是两回事）、`hasExactGrant` 幂等跳过、per-path `LockFileEx` 互斥、
**control fd 相关的一切**。

### 7.2 import 说明符改写（让包自包含）

vendor 里没有 `node_modules`，所以把裸包名改成包内相对路径：

| 文件 | 原 | 改为 |
| --- | --- | --- |
| `vendor/legacy-acl/lib/types-DxezulnA.js` | `from "@deepseek-ai/dsh-win32-process"` | `from "../../win32-process/lib/index.js"` |
| `vendor/legacy-acl/lib/types-DxezulnA.js` | `from "@deepseek-ai/dsh-lazy-require"` | `from "../../lazy-require/lib/index.js"` |
| `vendor/legacy-acl/lib/types-DxezulnA.js` | `createLazyRequire("koffi", …)` | `createLazyRequire("../../koffi/index.cjs", …)` |
| `vendor/legacy-acl/lib/runner.js` | `from "@deepseek-ai/dsh-subprocess/control"` | `from "../../subprocess/lib/control.js"` |
| `vendor/win32-process/lib/index.js` | `from "@deepseek-ai/dsh-lazy-require"`、`createLazyRequire("koffi", …)` | 同上的两条相对路径 |

> `koffi` 必须指向 **CJS 入口** `index.cjs`：0.1.7 改用 `createLazyRequire(...)`（内部是
> `createRequire`），加载不了 ESM-only 的入口。0.1.5 那份走的是 `import`，所以当时写 `index.js` 是对的。

**为什么选「改写 import 路径」而不是加载器垫片**：

- 零 Node API 依赖、零全局副作用（`module.registerHooks` 会影响整个进程后续所有 import，且要求
  Node ≥ 22.15，还要处理注册时机）；
- Node 原生 ESM 解析即可验证 —— `node .smoke/vendor-test.mjs` 直接 import 一次就算验完；
- 行数固定、有明确断言守着，漂移可见。

### 7.3 为什么把 koffi 也 vendor 进来

koffi 用**包内相对位置**找原生库：`${import.meta.dirname}/../../../@koromix/koffi-${platform}-${arch}`
（`vendor/koffi/src/koffi/index.js:176`）。也就是说，**只有**把 koffi 放在
`vendor/koffi/`、平台包放在 `vendor/@koromix/koffi-win32-x64/`（兄弟目录）时它才能加载 ——
反过来若走宿主解析，就要去改 koffi 自己的查找逻辑，更脆。约 2.9 MB 换「零依赖、零链接、搬运不失效」。

---

## 8. 离线自检

```powershell
cd <本目录>
node --check lib/index.js

# ① vendor 侧（90 断言）：文件与改写 / 安全目标防线 / 回归防线 / 可加载 / SID 一致 / 真实 FFI 冒烟
node .smoke/vendor-test.mjs

# ② 宿主半（78 断言）：桩 ctx + 桩 provider 跑真源码，含 control-fd 门槛的正反两面
node .smoke/host-test.mjs

# 可选：把参照包喂进来（不设则自动从 <工作区根>/versions/* 探测）
$env:LEGACY_ACL_REF_017 = "<…>/0.1.7-rc.2/…/dsh-sandbox-windows-acl"   # 未打补丁的 0.1.7：符号必须大量命中
$env:LEGACY_ACL_REF_015 = "<…>/0.1.5-rc.3/…/dsh-sandbox-windows-acl"   # 0.1.5：controlFileDescriptor 必须为 0
```

两条自检的纪律：

- **绝不写真实 ACE**：覆盖实现的行为用「假 legacy 模块 + 真 `buildMaterialize`」验证（假 `AclWriteGrant`
  记录每一次调用），所以跑多少遍都不动系统 ACL；真实 vendor 只在 install 阶段被 import（那一步只加载 koffi）。
- **不污染实机报告**：宿主自检把 `DSH_HOME` 指到 `.smoke/.tmp/`（自检产物，可随时删）。

### 8.1 两条防线（换版后新增）

| 防线 | 断言在哪 | 内容 | 反向控制 |
| --- | --- | --- | --- |
| **(i) 回归防线** | `vendor-test.mjs` C 组 + `host-test.mjs` 2b 组 | vendor 的 ACL 包里 `controlFileDescriptor` 必须 ≥3 命中，且传递形态在场 | 0.1.5 参照包必须 **0** 命中；`controlFdProblems({hits:0})` 必须产出拒绝理由 |
| **(ii) 安全目标防线** | `vendor-test.mjs` B 组 | 16 个符号（`S-1-16-4096` / `TokenIntegrityLevel` / `buildLowLabelAcl` / `addMandatoryAce` / `FILE_DELETE_CHILD` / `restrictTokenIntegrity` / `lowLabelSidPtr` / `worldSidPtr` …）在 `.js` 实现里 **0 命中** | 未打补丁的 0.1.7 参照包里同一批符号必须 **≥10** 命中（检测面失效会先红） |

宿主半的 control-fd 门槛是**拒接条件**：不满足时 `status=refused`，一处都不改，DSH 保持 0.1.7 原生行为。

---

## 9. 限制与未验证项

> 🧪 **0.2.0-rc.2 兼容性（2026-10-01 代码核对，未在本机 0.2.0 实例实测）**：`@deepseek-ai/dsh-sandbox-windows-acl` 在 `0.2.0-rc.2` 与 `0.1.7-rc.2` **除新增随包技能 `diagnose-windows-sandbox-acl` 外逐字节相同**（`grantWrite` 三件套、`restrictTokenIntegrity`、`AclWriteGrant` 均未变），`dsh-sandbox-local` 的 `materializeAclGrant` 覆盖点仍在 ⇒ 本插件的两处补丁前提在 0.2.0 上依然成立。**注意**：`0.2.0-rc.2` 的 `profiles/web` 目前为空、未装任何插件；若要在该实例启用本插件，先按 §8 跑离线自检，再观察宿主日志中的 `sandbox-legacy-acl: installed`。

- **未实机验证**：本插件是在离线状态下写成的（自检全绿），**没有**在真实 0.1.7 实例里装载过。
  首次上机请按 §5.3 逐条核对；
- **依赖 provider 私有字段**：覆盖实现读写 `this.workspaceGrants` / `this.tempCapabilities` /
  `this.removeTempDir`（出自 0.1.7 `dsh-sandbox-local/lib/index.js:392-478`）。字段若改名，
  前置检查会拒绝接管（不是静默失效）；
- **只影响新的授权**：见 §6；
- **§6 的清理命令未实测**；
- 报告里的 `vendor.aclVersion` 读自 vendor 的 `package.json`，**不是**宿主版本；本插件不探测 DSH 版本；
- **换版后的实机验证尚未做**：本轮的结论全部来自离线自检（90 + 78 断言全绿）+ 静态对照。
  首次上机请按 §5.3 逐条核对，**并且**额外确认 `run_code` 正常（即 read / write / pwsh 都能用）——
  这正是上一轮翻车的地方；
- `.d.ts` 未同步：vendor 的 `lib/types/*.d.ts` 仍是上游原文（含 `FILE_DELETE_CHILD` 常量、
  `lowLabelSidPtr` 等），运行时不加载它们，**以 `.js` 为准**。自检把 `.d.ts` 的这份漂移显式断言出来。
