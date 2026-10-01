# AGENTS.md · dsh-sandbox-legacy-acl

> 面向要读/改这个插件的 agent。使用者自述在 `README.md`。只写占位符，不写本机绝对路径。

## 1. 30 秒看懂

**纯宿主半**的 DSH 插件，做一件事：把 0.1.7 的 Windows ACL 沙箱**回退到 0.1.5 的授权行为** ——
授权时只写能力 SID 允许 ACE，不写 Low 完整性标签、不写 Everyone 的 `FILE_DELETE_CHILD` 拒绝。

⚠️ **vendor 不是 0.1.5 的包**：vendor = **0.1.7-rc.2 + 两处补丁**。0.1.5 的包没有 control fd 支持，
换上去会让 `run_code` 的 worker 起不来（`ERR_INVALID_FD_TYPE` → read / write / pwsh 全瘫）。
详见 README §7.0 与 `vendor/legacy-acl/PATCH-NOTES.md`。

源码目录约定：`<工作区根>\plugins\<包名>`。

## 2. 文件

| 路径 | 是什么 |
| --- | --- |
| `lib/index.js` | **宿主半（真源码，单文件）**：唯一的实现 |
| `vendor/legacy-acl/` | **0.1.7-rc.2** 的 `@deepseek-ai/dsh-sandbox-windows-acl` 副本 + **补丁 A/B**（逐行对照在它自己的 `PATCH-NOTES.md`） |
| `vendor/win32-process/` | **0.1.7-rc.2** 的 `@deepseek-ai/dsh-win32-process` 副本（仅 import 改写） |
| `vendor/lazy-require/` | **0.1.7-rc.2** 的 `@deepseek-ai/dsh-lazy-require`（0.1.7 新增依赖；koffi 靠它加载） |
| `vendor/subprocess/` | `@deepseek-ai/dsh-subprocess` 的 **`lib/control.js` 一份**（control fd 常量；主入口未复制） |
| `vendor/koffi/` + `vendor/@koromix/koffi-win32-x64/` | koffi 3.3.1 与其原生二进制（**必须**保持兄弟目录布局，见 README §7.3） |
| `.smoke/vendor-test.mjs` | 离线自检①：vendor 侧（90 断言；含安全目标防线与回归防线） |
| `.smoke/host-test.mjs` | 离线自检②：宿主半（78 断言；含 control-fd 门槛的反向控制） |
| `.smoke/.tmp/` | 自检产物（测试用 `DSH_HOME`），可随时删 |
| `package.json` | `type: module` · `main: lib/index.js` · `files: ["lib","vendor"]` |

## 3. 契约速查（改代码前先记住）

> **跨版本（2026-10-02）**：0.1.7-rc.2 与 0.2.0-rc.2 的接管契约**相同**，同一份 vendor 通用、不做版本分流。
> 两处改点的锚点位置：`@deepseek-ai/dsh-sandbox-local/lib/index.js:396`（`materializeAclGrant`）与 `:540`（`windowsAclRunnerInvocation()` 读 `this.internals.windowsAclRunnerArgs`）。
> ⚠️ 别把它与 `this.runnerCommand` 搞混 —— 那是构造函数配置（Linux/bwrap 链用），0.2.0 新增的诊断技能注册判的就是它。

| 主题 | 约定 |
| --- | --- |
| 服务名 | `sandbox`（`SandboxProvider extends Service`，构造里 `super(ctx, "sandbox")`，0.1.5 `dsh-sandbox/lib/index.js:198`） |
| 注入 | `export const inject = ["sandbox"]` + `ctx.inject(["sandbox"], sctx => sctx.effect(...))`；**用 `sctx.get("sandbox")` 取实例** |
| 改点① | 覆盖 **实例自有属性** `provider.materializeAclGrant`（不动原型）；实现逐行对位 0.1.7 `dsh-sandbox-local/lib/index.js:392-440`，`AclWriteGrant` 取自 **vendor 里同一份补丁包**（补丁 B 后它的 `add()` 只写能力 ACE） |
| 改点② | `provider.internals.windowsAclRunnerArgs = [process.execPath, <vendor>/legacy-acl/lib/runner.js]`；0.1.7 的 `windowsAclRunnerInvocation()` 第一行就返回这个 override（`…/index.js:535-537`）。**与改点① 同源**（同一个 vendor 目录） |
| **为什么必须成对** | 补丁 A 把 `AclSandbox.init()` 里那条裸调用 `restrictTokenIntegrity(...)` 删掉了；若只覆盖 ① 而 runner 仍是未打补丁的官方 runner，令牌照样被降到 Low → **写入静默失败**。两处必须来自同一份补丁包 |
| **control-fd 硬门槛** | preflight 扫 vendor 的 `.js`：`controlFileDescriptor` 命中 < `CONTROL_FD_MIN_HITS`(3) 或缺传递形态 → `status=refused`，**一处都不改**。防的是「接管了但 run_code 坏掉」（0.1.5 的包命中 0） |
| provider 私有字段 | `this.workspaceGrants`（Map，按 workspaceRoot）、`this.tempCapabilities`（Map，key = `JSON.stringify([sessionId, workspaceRoot])`）、`this.removeTempDir(dir)`、`this.internals` —— 出处同上文件 :392-478 |
| SID 派生 | 两版**逐字相同**：`workspaceWriteSid = S-1-4-${sha256(root)[0..4]%…+1}-${[4..8]%…+1}`；`tempWriteSid` 多一个 `"temp\0"` 域前缀与尾缀 `-1`。自检里有跨版本一致性断言 |
| runner argv 契约 | `[node, runner.js, --workspace <dir>, --temp <dir>, --mode <read-only|workspace-write>, [--write-sid <S>, --temp-write-sid <S>], --, <argv…>]`；0.1.5 与 0.1.7 **完全一致**，自检里有断言守着 |
| 失败签名 | runner 侧任何失败打印 `windows-acl-run: <detail>` 并以 127 退出（seam 的 failure rules 认这个签名） |
| 关闭开关 | `DSH_LEGACY_ACL=0` → `apply` 直接返回，**不注册注入**（完全等于没装） |
| 报告 | `$DSH_HOME/sandbox-legacy-acl/report.json`；`probeVersion: 2`（v2 加 `vendor.patched` / `preflight.fields.controlFd`）；`override.granted` 是「真的走了 legacy 路径」的实机证据 |
| 依赖边界 | **不要 import `@deepseek-ai/*`**（profile 的 `node_modules` 里没有该 scope）。vendor 也只用**相对路径**引用；0.1.7 新增的两个依赖（`dsh-lazy-require`、`dsh-subprocess/control`）已一并 vendor 进来 |
| koffi 的加载方式 | 0.1.7 用 `createLazyRequire("../../koffi/index.cjs", import.meta.url)`（内部是 `createRequire`）—— **必须指向 CJS 入口**，ESM-only 的 `index.js` 加载不了 |

## 4. 改完必跑（离线，不碰任何工作区）

```powershell
cd <工作区根>\plugins\dsh-sandbox-legacy-acl
node --check lib/index.js
node .smoke/vendor-test.mjs        # 期望 ALL OK (90 passed, 0 failed, 0 skipped)
node .smoke/host-test.mjs          # 期望 ALL OK (78 passed, 0 failed)
# 参照包默认自动探测 <工作区根>/versions/*；也可显式喂：
$env:LEGACY_ACL_REF_017 = "<0.1.7 的 dsh-sandbox-windows-acl 目录>"   # 符号必须大量命中（反向控制）
$env:LEGACY_ACL_REF_015 = "<0.1.5 的 dsh-sandbox-windows-acl 目录>"   # controlFileDescriptor 必须为 0
```

⚠️ **用 pwsh 直接跑**：不要在 node 里 `execFileSync(..., { stdio: "pipe" })` —— 沙箱下会 `EPERM`。

## 5. 红线

1. **绝不抛**：宿主半抛错会让**整棵插件树装载失败**。所有失败路径 try/catch + 落盘（`recordFailure`），
   `apply` 里任何一个入口都不许把异常放出去。
2. **不接管就一个字都不改**：前置检查失败 → 保持 DSH 原生（0.1.7）行为。**不要**为了「总能生效」而放宽检查。
3. **两处改点必须原子**：只改一处的组合（ACE 有了、令牌还在 Low）会让写入静默失败，比不做还糟。
4. **自检不许写真实 ACE**：覆盖实现的行为必须用假 legacy 模块验证；真实 vendor 只在 install 阶段 import。
   宿主自检必须把 `DSH_HOME` 指到 `.smoke/.tmp/`，**不许**覆盖实机报告。
5. **不要改 vendor 的字节**，除了（a）那几行 import 说明符（README §7.2 有表）与（b）`PATCH-NOTES.md` 记录的两处补丁
   （补丁脚本在 `.sandbox/acl-vendor-upgrade-*` 下，重打会覆盖）。改了就要同步自检里的断言 ——
   尤其 **不要**把 `controlFileDescriptor` 或 `WRITE_RESTRICTED` 一起删掉。
6. **不要把 koffi 挪出 `vendor/`**：它的原生库查找是相对 `import.meta.dirname` 的，
   `vendor/koffi` 与 `vendor/@koromix/koffi-win32-x64` 的**兄弟关系**是它唯一能工作的布局。

## 6. 实机验证清单（装完 + 重启实例后）

1. 读 `$DSH_HOME/sandbox-legacy-acl/report.json`：`status` 应为 `installed`、`preflight.problems` 为空、
   `override.runnerArgs` 指向本插件的 vendor runner、`preflight.fields.controlFd.hits >= 3`、`vendor.patched === true`；
2. **先验 run_code 活没活**：随便调一次 `pwsh` / `read` / `write`（它们全走 `run_code`）。这是上一轮翻车的点 ——
   若 `status=installed` 但工具链报 `ERR_INVALID_FD_TYPE`，说明 vendor 换错了版本，立刻 `DSH_LEGACY_ACL=0` + 重启回滚；
3. 跑一条被沙箱包的 `pwsh` 命令（触发一次授权）→ `override.granted` 出现 `kind: "workspace"`、`aceOnly: true`；
4. `icacls <工作区根>` → `Mandatory Label\Medium Mandatory Level:(NW)`，**无** Low 标签、**无** Everyone 拒绝；
5. 资源管理器里删一个工作区内文件 → **能删**；
6. 反例：`DSH_LEGACY_ACL=0` + 重启 → 报告 `status: "disabled"`，`icacls` 回到 0.1.7 形态（三件套齐）。

## 7. 安装 / 生效 / 卸载

- 安装：① `<home>/profiles/<profile>/node_modules/` 建符号链接指向本目录；
  ② 该 profile 的 `cordis.patch.yml` 加 `- insert: [{ id: sandbox-legacy-acl, name: dsh-sandbox-legacy-acl }]`。
- 生效：**重启实例**（宿主模块在启动时装载；刷新页面无效）。
- 卸载：删 insert 段 + 删链接（插件的 effect disposer 会把两处改点还原）。
