# dsh-memory-vault

把个人记忆库做成一个 **宿主插件**（Host bundle）：一个 system prompt 段负责「什么时候查、什么不能外泄、写完怎么回报」，四个工具负责检索、写入、体检与维护。它替代原来的三件套——`~/.dsh/AGENTS.md` 里的「个人记忆库」段落 + `personal-memory` 技能 + `memory.py` 脚本，规则从此写在代码里，对每个 workspace、每个会话都生效。

## 提供的工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `memory_search` | `query`（必填）、`include_credentials`（可选） | 加权检索，返回 `路径:行号` + 摘要 + 原文摘录；凭据文件需显式开启 |
| `memory_write` | `path`、`text`（必填）、`append`（可选） | 写入并重建索引，返回 `committed` 报告 |
| `memory_health` | 无 | lint 前 20 条问题 + 篇数 + 库路径 |
| `memory_maintain` | `op: index\|lint\|new`（必填）、`type`、`title`（可选） | 重建索引 / 全量 lint / 从模板新建到 inbox |

`memory_write` 会同时刷新 `updated:`、重建 `INDEX.md` 与 `MEMORY.md` 覆盖段、追加 `CHANGELOG.md`。`memory_maintain` 的 `new` 从 `templates/` 里取模板（找不到就用 `通用.md`），建到 `inbox/`。

## 设置页

**设置 → 记忆库** 里只有一个「库目录」输入框（外加保存状态）。它是本插件自己注册的 `settings.section` 页，通过 `ctx.configForms.get('dsh-memory-vault')` 读写本插件的 Config：读 `getSnapshot()`，写 `set('vault', path)`（带 revision 栅栏，保存被拒会显示失败而不是悄悄覆盖）。因为 Host 侧字段是 `.volatile()`，保存后插件原地重新 `apply`，工具与提示段立刻使用新路径。

## 自动 git 同步

库本身是一个 git 仓库时，插件自己保持多台机器一致：

| 时机 | 动作 |
| --- | --- |
| 插件挂载（应用启动 / 保存设置后重挂） | 拉取一次远程 |
| 每隔 `syncIntervalSeconds`（默认 300 秒） | 先 pull，再 commit + push |

配置项（同样是 `.volatile()`，改完立即生效）：

- `syncEnabled`（默认 `true`）——关掉后既不定时同步也不做启动拉取
- `syncIntervalSeconds`（默认 `300`）——小于 60 按 60 处理

三条约束写在 `lib/git.js` 里，都是为了让同步**永远不损坏库**：

1. **先 pull 后 push**。远程有新提交时先 push 会被拒（non-fast-forward），顺序反了会让每个 tick 都失败。
2. **失败自动 abort**。冲突的 rebase、`--autostash` 恢复时产生的 `UU` 冲突都会被检测并回滚（`reset --merge` + `stash drop`），库不会被留在 mid-rebase。
3. **commit 先于 push**。commit 是本地操作、必然成功；push 需要网络。推送失败时工作已记录，不会丢。

工作区有未提交改动时 pull 会**跳过并报告**，不会 rebase 覆盖你的编辑。

### commit 描述

自动提交的标题来自**实际发生过的写入**，不调用模型：`memory_write` 成功后把「写了哪一篇、是写入还是追加」记进一个待提交列表，同步时用它拼出标题。

| 情形 | 标题 |
| --- | --- |
| 只动了一篇 | `memory: 追加 me/偏好与习惯.md` |
| 动了好几篇 | `memory: 写入 me/Tailscale.md 等 3 篇` |
| 同一篇写了多次 | 合并成一条，取最后一次的动作 |
| 没有记录（手工改的文件） | 回退到 `memory: 自动同步` |

标题**不带时间**：git 本身就给每个 commit 记了作者与提交时间（`git log --format=%ad`），写进标题只是重复。

推送失败时这条描述会**保留**，下次同步继续带着它，不会因为网络问题丢失。

同步失败不抛错、不影响工具：结果记在 `memory_health` 输出的最后一行，例如

```
同步（2026-11-06T08:42:01.525Z，每 300 秒）：pull 成功（拉取 1 个提交） · push 成功（已推送）
```

远程不可达时按超时（20 秒）失败并报告，不会让工具调用挂住。

## 常驻提示词段

插件注册一个 system prompt section：name `memory-vault`，order `9600`——位于 file references（`9000`）之后、structured output（`9900`）之前，`interpolate: false`（库路径含 `\`，而渲染器会把 `{{` 当变量）。内容只有五条：判断标准、检索方式、凭据纪律、写入回报、自检。它替代了原 `AGENTS.md` 的「个人记忆库」整节。

## 库结构约定

一级目录固定为 `me` / `work` / `life` / `memory` / `inbox`，`me/credentials/` 是明文凭据目录。

frontmatter 字段：`title` / `type` / `domain` / `scope` / `summary` / `keywords` / `status` / `created` / `updated`。

| 字段 | 取值 |
| --- | --- |
| `type` | `credential` `device` `network` `service` `project` `problem` `career` `finance` `preference` `memory` `note` |
| `scope` | `instance` `method` `reference` |
| `status` | `active` `superseded` `draft` |

`INDEX.md`、`MEMORY.md`（`<!-- coverage:start -->` / `<!-- coverage:end -->` 之间的段）和 `CHANGELOG.md` 由工具维护，**不要手改**。

## 写入流程

1. 新笔记自动生成 frontmatter 模板（`domain: inbox`、`status: draft`）；路径与内容先校验，非法直接 `committed: false`。
2. `append: true` 时追加在 frontmatter **之后**。
3. 读回校验 → 刷新 `updated:` → 重建 `INDEX.md` 与覆盖段 → 追加 `CHANGELOG`。
4. 返回 `{ committed, path, line, verify, index }`。`line` 是刷新 `updated:` **之后**的最终行号，可直接拿去局部读取。

`committed: false` 时要原样把 `reason` 报给用户。

## 凭据纪律

`me/credentials/` 是明文目录，检索时照原样返回命中行（与其它笔记一致），agent 才能把用户要的密码、token 或密钥取出来。唯一的分层是**检索范围**：默认不搜凭据文件，必须显式带 `include_credentials: true` 才纳入，避免普通问题顺手带出秘密。拿到值后的使用侧纪律由常驻提示段约束：只用于用户要办的事或原样回给用户，不进日志、不进 commit、不主动多列。

## 修改库路径

打开 **设置 → 记忆库**，在「库目录」里填绝对路径，点保存。**立即生效，不用重启**：`vault` 字段是 `.volatile()`，保存时 Host 会把值写进 profile 的 `cordis.patch.yml` 并原地重新应用本插件，工具与常驻提示段随即使用新路径。

Config 字段（都可在设置页改）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `vault` | 空 | 记忆库文件夹绝对路径；为空时插件照常加载，只是工具关掉、提示段说明「记忆库不可用」 |
| `searchLimit` | 5 | 检索最多返回多少条命中 |
| `maxExcerpt` | 120 | 摘录截断长度 |
| `promptOrder` | 9600 | 常驻提示段排序 |

`cordis.patch.yml` 里**故意不写** `vault`：值是用户在本机选的，写进 bundle 会变成所有 profile 的默认值。

### 库目录的校验规则

配置值必须是**绝对路径字符串**（也接受设置写入端偶尔给的 `{ value: '…' }` 对象）。下面这些情况一律按「未配置」处理，四个工具不注册，并在 Host 日志里留一条 warn：

- 取不到字符串（例如被 `String()` 成 `[object Object]` 的对象）
- 相对路径（不允许按 `process.cwd()` 解析）
- 路径不存在

`lib/vault.js` 里还有一道独立的护栏 `vaultRootReason()`：`write()`、`rebuildIndex()`、`memory_health`、`memory_maintain` 都会先确认根目录**存在、是文件夹、且带有 `MEMORY.md` / `INDEX.md` / `CHANGELOG.md` / `templates` 之一**，否则拒绝写入。这条是补一个真实事故：早期版本对不存在的根目录直接 `mkdir -p`，把配置里的坏值 `[object Object]` 真建成了一个目录，并在里面写出一篇笔记和一份 `INDEX.md`。

## 与 memory.py 的差异

四点是 bug 修复：

- `line` 在刷新 `updated:` 之后计算（旧脚本偏 1 行）。
- `append` 落在 frontmatter 之后，不再产生第二段 frontmatter。
- 凭据摘录照原文返回（曾一度只给标签，结果 agent 拿到行号后仍需自行读文件，与「永不返回值」的说明互相矛盾）。
- 原子写：临时文件 + rename。

检索把 query 按空白拆成多个词，规则有两条：

- **任一命中即可**。早先要求每个词都出现，结果「PT 登录」在 `me/credentials/PT站点.md` 上整篇落空。现在只要有一个词命中就进候选，但按覆盖率排序：命中词占比平方后乘到基础分上，命中全部词的笔记远高于只命中一个词的。
- **短语额外加分**。整句短语在路径、标题、正文里字面出现时加 9 分，摘录也优先取含短语的那一行（`matchedIn: 'phrase'`）。
- 路径（去掉 `.md`、`/` 与 `_` 视作空格）也参与计分，权重 2，所以文件名能回答查询词。

`MEMORY.md` 覆盖段的篇名顺序沿用 `memory.py` 的效果：按路径的**大小写不敏感**顺序（Python 的 `rglob` 产出 `WindowsPath`，比较时折叠大小写），所以 `me/credentials/*` 排在 `me/Tailscale.md` 之前。

## 测试

```bash
node --test "test/*.test.js"
```

Node 24 下**不能**写成 `node --test test/`，那会被当作要 require 的模块。等价性测试会把真实库复制到临时目录，比对 `INDEX.md` 与 `MEMORY.md` 覆盖段是否逐字节一致；可用环境变量 `DSH_MEMORY_VAULT` 指向别的库。

## 安装与回滚

用 `plugin_manager` 的 `install_bundle`，指向本目录的绝对路径。

依赖：`@deepseek-ai/schemastery`（Config 必须是真正的 schemastery schema，否则设置页看不到本插件）。它装在本包自己的 `node_modules/` 里——profile 用 `link:` 安装本包，Node 会把符号链接真实化到工作区目录，因此**不会**走 profile 的 `node_modules`。换机器或删掉 `node_modules` 后，在本目录跑一次 `pnpm install`。

回滚有两种：移除 bundle，或只把 `cordis.patch.yml` 里的 row 设为 `disabled: true`。无论哪种，**库文件本身都不会被插件删除**。

## 迁移说明

原 `~/.dsh/AGENTS.md` 的「个人记忆库」节与 `~/.agents/skills/personal-memory/` 已退役；`memory.py` 保留在 `~/.agents/skills/_retired/personal-memory/scripts/` 仅作逃生工具。
