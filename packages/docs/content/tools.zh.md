---
title: 工具与审批
description: 极简内置工具集的设计与执行契约、Environment 统一收尾规则，以及逐调用审批与 Trace 审计。
---

## 设计取向

PenguinHarness 刻意维持一个极小的内置工具集：文件的精确读取与编辑交给专门的文件工具（`read_file` / `edit_file` / `write_file`）——带行号的输出与精确字符串替换比拼 `sed` 命令更可靠；Shell（`exec_command`）仍是通用兜底接口，负责运行程序、搜索、装依赖等其余一切。保留下来的每个工具都对得起它占用的 schema Token。

## 执行契约

所有内置工具实现同一个 `BuiltinTool` 接口(`packages/core/src/environment/tools/types.ts`):

```ts
interface BuiltinTool {
  name: string;
  definition: ToolDefinitionConfig;
  execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): AsyncGenerator<OmniMessage, ToolResult | void>;
}

interface ToolExecutionContext {
  workspaceDir: string;
  toolCallId: string;
  signal?: AbortSignal;
  approve?: ApproveFn; // 供需要派生子 Session 的工具转发(审批继承)
}

interface ToolResult {
  stopReason?: StopReason; // 工具自报终态(优先级最低,见下)
  note?: string; // 追加在输出预算之外的终止标记(如退出码)
  images?: string[]; // data URL 图像,附加在文本输出之后
}
```

工具本身只需 yield 增量的 `partial_tool_call_output`，收尾由 Environment 集中处理：

- 流式分帧(start / stop)与 `tool_call_id` 贯穿；
- 超时归并；输出超过 `maxOutputLength`(默认 16000 字符)时按头尾双窗截断：预算对半开，头窗照常流式转发，尾窗在收尾时随 `[output truncated: kept first H and last T of C chars]` 标记补出——总量 C 供模型判断是否值得读 recovery 文件；超出头窗但未超预算的输出则在收尾时原样补出、不加标记；
- stop_reason 按优先级归并：用户中断 > 超时 > 工具抛错 > 工具自报；
- 输出永不为空：没有任何输出时补 `[no output]`;
- `note`(如退出码)与图像附加在输出预算之外，长输出被截断时终止标记不会丢失。

工具与 Environment 从不向引擎抛异常：错误一律折叠为 `tool_call_output` 消息，交给模型阅读并调整下一步。参数不合工具定义的调用以 `fatal` 收尾，整段输出即一份纠错指引：出错之处、实际收到的参数名（点出 schema 未声明的名字）、按 schema 重述的全部参数，以及一次正确调用的形态——仅凭这段输出就能改对再发。消息结构见 [OmniMessage 协议](/omni-message)。

### 过长输出恢复

工具文本超过 `maxOutputLength`，或符合条件的成功结果被压缩时，Environment 会保留可用的可见内容并附上 Session 级 recall id。fatal 结果不会被压缩；其头尾窗口与终止失败标记仍直接显示。这里的原文仅指 **Environment 实际收到的文本**：命令或子 Agent Session 等生产者可能已在自身的有界未读缓冲区中用 `[..., N chars of earlier output dropped ...]` 标记替换溢出内容，下游归档无法恢复此前已经丢失的文本。

Session 有 scratchpad 时，`recall_output` 会自动加入该 Session 的工具列表。使用结果中的 id 和 `offset: 0` 调用，再按返回的 `next_offset` 读取后续页面。id 只在所属 Session 中有效，工具不会返回文件系统路径。新 id 长 32 个十六进制字符；为兼容，已有的 12 字符 id 仍可读取。每页最多 12,000 个 UTF-16 代码单元，页面边界不会拆开代理项；依次拼接页面正文即可还原归档文本。

提示中的 JSON 元数据为 `{recallId,sizeBytes,tokenCount}`。`tokenCount` 仅按 `ceil(sizeBytes / 4)` 粗略估算，并非模型提供方的 token 计数。recall 返回凭据脱敏后的 UTF-8 文本，不会恢复归档时移除的秘密。

归档存放于 `scratchpad/<session-id>/truncated-tool-output/recall/`，平台支持时使用私有目录与文件权限。写入前会脱敏可识别的凭据格式。单次捕获上限略低于 8 MiB；超限时只保留有界头尾，并明确标出中间缺失。每个 Session 最多保存 200 条、合计 64 MiB，条目最长保留 30 天。达到容量时拒绝新保存，不会提前驱逐已经发给模型的 id；过期条目及 Session 删除会清除文件。相同 Session scratchpad 可在重新创建 Environment 后继续解析 id。保存失败时仍保留有界的内联输出，并且只报告简短错误码。

## 配置字段

每个工具由一条 `ToolDefinitionConfig` 描述：

| 字段 | 说明 |
| --- | --- |
| `name` | 工具名，对应模型产出的 `tool_call.name` |
| `description` | 提供给模型的工具说明 |
| `parameters` | 参数 JSON Schema |
| `permission` | `"r"` 只读 / `"rw"` 读写 |
| `forModel` | `"vision"` / `"text-only"`：按 Session 模型类别装配；缺省对所有模型可用（内置条目均不设——`read_file` 同时服务两类模型） |
| `timeoutMs` | 单次调用超时(ms)，默认 120000;`<=0` 关闭 |
| `maxOutputLength` | 输出长度上限(字符);`<=0` 关闭 |
| `call_description` | 条目级开关：控制 `parameters` 中声明的 `description` 调用参数（开启时为必填）；缺省保留，`false` 时装配阶段将其连同 `required` 项从 schema 滤除 |

## 内置工具

共 12 个内置工具(装配入口 `packages/core/src/environment/tools/registry.ts`):

| 工具 | 权限 | 超时(ms) | 用途 |
| --- | --- | --- | --- |
| `web_search` | r | 30000 | 通过宿主配置的 SearXNG 实例搜索实时 Web |
| `exec_command` | rw | 120000 | 在 Workspace 内以 `bash -lc` 运行命令，流式返回 stdout/stderr |
| `input_command` | rw | 120000 | 按 `process_id` 驱动命令会话：写 stdin、发 Ctrl-C、轮询输出，或终止（`kill: true`） |
| `read_file` | r | 60000 | 按 `cat -n` 风格带行号读取文本文件（以 offset/limit 分页），或读取图片（路径或 URL）作为图像内容返回——text-only 模型则由 `vision_model` 代读为文字 |
| `edit_file` | rw | 30000 | 对既有文件做精确字符串替换，回显校验片段 |
| `write_file` | rw | 30000 | 新建或整体覆写文件，按需创建父目录 |
| `run_subagent` | rw | 600000 | 把自包含子任务委派给同 Workspace 的子 Agent |
| `input_subagent` | rw | 600000 | 轮询后台 Subagent、运行中插话、停止其当前轮，或在其空闲时追加后续 Prompt |
| `environment_info` | r | 10000 | 报告宿主机的平台 / shell / 路径形态，可选解析单个路径字符串 |
| `resource_pressure` | r | 10000 | 报告内存与各路径磁盘压力；只观测，不做拒绝 |
| `knowledge_graph` | rw | 30000 | 记录带出处的 findings、按需检索，并管理其生命周期（confirm / refute / supersede / link） |
| `code_graph` | r | 60000 | 一次索引 Workspace，随后查询符号、调用者/被调用、影响半径与结构——与驾驶舱拓扑视图同一套引擎 |

注意：既有 Agent 已落盘的 `tools.builtin` 列表按原样冻结（设置页只能编辑行、不能增行）：较早创建的 Agent 不会自动获得后来新增的工具（如文件工具）与新增参数（`run_in_background`、`kill`、`abort`），已移除工具（`kill_command`、`kill_subagent`、`read_image`、`describe_image`）的存量条目则不再装配——模型按旧名调用得到标准的未知工具报错；读图之前落盘的 `read_file` 条目保留旧描述与旧超时（其背后的实现已能读图）。采纳当前定义需手工编辑该 Agent 的 `system_config.yaml`（可从 `packages/core/src/state/default-config.ts` 的默认定义复制），或走「更新内核」。

### 调用描述

搜索 / 命令 / Subagent 类工具（`web_search`、`exec_command`、`input_command`、`run_subagent`、`input_subagent`）带 `description` 参数：由模型写一句"本次调用在做什么"，CLI 与 Web 在调用运行期间展示给用户。该参数作为普通的 `description` 属性直接写在各条目的 `parameters` 中（工具 schema 完全存于可编辑配置），并且是**必填**的——提供该参数的工具每次调用都会带上它，前端据 schema 即可确定这次调用的展示形态，无需在参数流式过程中猜测；同时要求模型最先输出它。整个参数由条目级 `call_description` 字段控制——缺省保留，写 `call_description: false` 时装配阶段将该属性连同其 `required` 项一起从 schema 中滤除（仅内存内，不改写 YAML）。文件工具不带此参数——其 `file_path` 参数本身已说明用途。

### Web 搜索

`web_search` 调用 SearXNG 的 JSON `/search` 端点，最多返回 10 条规范化结果。参数包括
必填的 `query`、`limit`（1–10，默认 5）、`language`、`safesearch`（0–2）以及
`time_range`（`day` / `month` / `year`）。响应上限为 2 MiB，只保留 HTTP(S) 结果
URL 并按 URL 去重；标题与摘要明确标为不可信外部内容。

SearXNG 端点属于宿主配置，不是工具参数。优先级依次为 SDK 的
`EnvironmentServices.webSearch.endpoint` 覆盖、Agent Vault 中的 `SEARXNG_ENDPOINT`、
进程环境中的 `SEARXNG_ENDPOINT`，最后是 `http://127.0.0.1:8080`。SearXNG 实例须在
`search.formats` 中启用 `json`；HTTP 403 错误会给出这一诊断。

### 知识图谱

`knowledge_graph` 是 findings 平面（`packages/core/src/knowledge/`）面向 Agent 的入口。
一次 `report` 记录一条耐久断言——标题、类型、正文、主题（文件 / 模块 / 符号）、带审计层级的证据、标签——其余交给图谱：重复上报会并入同一条 finding（先按确定性 id，再按 Jaccard 措辞相似度），近似断言变为 `related` 链接，同一 Agent 的再次上报**替换**其先前叙述而不是追加。出处来自宿主记录的 attribution 而非模型参数，Prompt 无法伪造"谁报的"。

`query` 返回按 状态 → 严重度·置信度 → 新近度 排序的结果，可按文本、主题路径前缀、类型、标签、状态过滤；被驳回与被取代的断言默认不出现。Findings 是需要核实的断言。`query` 与 `snapshot` 返回 `authoredBy`（`agent`、`user`、`system` 或 `legacy-unknown`）、宿主认证的作者、状态及证据层级。新记录会保存首次创建时由宿主认证的作者，即使事件日志轮换或记录移入有限归档，作者信息仍会保留。旧快照优先使用仍保留的 ingest 事件；两者都没有时显示为 `legacy-unknown`。作者与来源中的自由文本标签分开。查询正文不会自动加入简报。

生命周期允许 open → confirmed/refuted/superseded，以及 confirmed → refuted/superseded。确认必须有 runtime 或 implementation 证据；已认证的 HTTP 用户可用 `override: true` 和非空 `note` 明确豁免证据门槛，Agent 工具不能豁免。取代操作要求替代断言仍为 open 或 confirmed，并拒绝环路及超过 64 跳的链。重新上报已驳回的断言会建立确定性的矛盾修订，而不会改写原有证伪。只有用户能通过单独的 HTTP `reopen` 操作并填写理由重新打开已驳回的断言；重新打开会把状态改回 `open`，但保留已记录的证据，因此下一次 `confirm` 仍需自行满足证据门槛。已取代的断言保持终态。`events` 记录宿主提供的身份、操作入口与理由；`snapshot` 导出当前保留的图谱和有上限的事件日志。

状态保存为每个 Workspace 一份权威快照 `.penguin/knowledge/findings-graph.json`。工具与 HTTP 路由使用同一存储实现，但作用域路径独立。这两个权威始终分离：Workspace 工具存储与 HTTP Project 存储属于不同作用域，不会合并，即使二者显示名称相同或其中一方被重命名。若要统一，需要显式且可审计的绑定，而该绑定并未启用。工具的 `recovery` 操作会标明它回答的是哪个作用域。变更通过跨进程锁串行处理，只有原子写入成功后才返回成功；工具的可选 `revision` 与 HTTP `If-Match` 可拒绝旧版本变更。内容指纹能检测长度相同的外部替换，读取缓存最多保留八个作用域。锁与恢复文件位于权威快照旁。保留的 finding 上限为 5,000 条，UTF-8 JSON 写入上限为 32 MiB；达到 24 MiB 时恢复状态标记高水位，HTTP 读取返回 `X-Findings-High-Water: 1`。淘汰顺序为 refuted、superseded、open，最后才是 confirmed，同一状态按最久未更新优先。完整被淘汰记录与 operation ID 和活动 finding 保存在同一份原子快照里。归档上限为 1,000 条、4 MiB、90 天；轮换可能丢弃更早记录。快照写入失败时活动图谱与归档同时保持原状。活动 related 链接会移除已淘汰 ID；替代 finding 被归档时保留可解析的归档墓碑 ID。恢复状态会返回归档数量、字节数、最早时间与限制。`archive` 可分页读取墓碑，`recall` 可取回完整记录。单独的内存图谱不保证文件持久性。事件日志最多保留 2,000 条，并公开最新序号供客户端判断缺口。强度仅用于读取时展示，由自最近更新起的置信度加权指数衰减，以及基于创建时间的附加项构成。它不追踪访问，也不决定查询排序或淘汰顺序。

工具的 `recovery` 操作返回作用域、版本、容量、归档与恢复状态；`raw` 通过 `offset` / `nextOffset` 分页导出原始字节的 base64。损坏、版本不受支持或无法读取的快照拒绝正常变更。损坏字节保存在唯一命名且保留权限的隔离副本中；隔离失败仍然拒绝写入。文件不存在时可以从空图谱开始，已删除文件的内容不会从缓存重新出现。

已认证的 HTTP 操作者可向 `/api/projects/:projectId/findings/recovery/reset`、`/restore` 或 `/prune` 提交 `acknowledge: true`、当前 `revision` 与非空 `reason`。恢复还需要 JSON 字符串 `snapshot`；裁剪需要终态 finding 的 `ids`。操作会保留完整备份，并将身份、理由、先前版本及备份路径写入审计日志。Agent 内建工具不能执行重置、恢复或裁剪。已超出字节上限的文件仍可分页导出原始字节，再用较小的已核实快照替换，或在明确确认后重置。

此存储仅属于工具上下文提供的 Workspace。服务端 HTTP findings 路由使用独立的 Project ID 文件（`.findings_graph.json`）；名称或路径相同也不会自动绑定或同步两个存储。

`query`、`snapshot`、`events` 与 `archive` 默认返回 version 2 JSON 分页信封，包含作用域版本、最新事件序号、续页游标、截断标记、剩余数量与高水位状态。游标绑定哈希作用域、规范化过滤条件、版本和稳定排序键；续页时须保持过滤条件与 limit 不变。版本变化或游标不匹配会给出明确重启错误；事件缺口会报告最早保留序号。输出上限按 UTF-8 字节计算。单条过大的内容会缩为摘要并附 recall ID；`recall` 以 base64 分块返回原始 JSON 字节，客户端拼接后再解码。`outputVersion: 1` 可显式选择旧版 query、snapshot 或 events 形状，仅在完整结果放得下时返回；它不支持游标，结果过大时会报错。默认使用 version 2。

### 代码图谱

`code_graph` 是原生代码智能入口（`packages/core/src/codegraph/*` 加上 watcher 的遍历器与符号索引器——与驾驶舱拓扑视图同一套引擎）。一次 `index` 遍历 Workspace（沿用标准忽略表：`node_modules`、`.git`、`dist`、`.venv` …）构建符号图，结果缓存 60 秒——一串查询只付一次遍历；`index` 带 `refresh: true` 可强制重扫。对同一 Workspace 的并发 `index` 请求共享一次扫描；LRU 缓存最多保留 8 个 Workspace，`index` 会报告缓存大小和驱逐次数。工具只调用 `scanWorkspace()`（该方法不安装文件 watcher；只有 `init()` 会安装），因此不会创建 watcher 句柄。

随后即可查询：`search` 按名字片段找符号与文件，`callers` / `callees` 以有界深度遍历调用图，`impact` 计算改动某节点的爆炸半径，`explore` 返回围绕某词条的小子图，`files` 列出已索引文件集，`hubs` 给出连接度最高的节点。该工具只读，也不会写入文件。

### 命令会话

`exec_command` 先在前台等待；命令超过 `yield_time_ms` 仍未结束时转入后台，返回已有输出和一个 `process_id`，之后用 `input_command` 驱动。传 `run_in_background: true` 则完全跳过前台窗口：调用立即返回 `process_id`，进程退出时其结果以自动 user message 送达（见[后台完成回报](#后台完成回报)）。两种方式启动的会话都可用 `input_command` 的 `kill: true` 终止——进程是真实的 OS 对象、确会销毁，终止因此是访问工具的一个参数而非独立工具：

```text
exec_command(cmd)
  ├─ 前台窗口(yield_time_ms,默认 60000)内结束 ──► 完整输出 + 退出码
  ├─ 未结束 ──► 转入后台,返回已有输出 + process_id
  │                  │
  │  input_command(process_id[, chars]) ──► 写 stdin / 发 Ctrl-C / 轮询
  │                  └─ 循环驱动,直至命令退出
  └─ run_in_background: true ──► 立即返回 process_id
                     └─ 退出时:完成回报以 user message 送达
     input_command(process_id, kill: true) ──► 对进程组 SIGTERM（宽限后 SIGKILL）
```

各工具的参数（明确键名）：

```ts
// exec_command
{
  cmd: string;             // 必填:要执行的 shell 命令(也接受别名 `command`;schema 只声明 `cmd`)
  workdir?: string;        // 工作目录;缺省为 Workspace 根,相对路径按其解析
  yield_time_ms?: number;  // 前台等待时长;默认 60000,最小 250,上限受工具超时约束
  run_in_background?: boolean; // true = 立即返回 process_id;完成回报以 user message 送达
  description: string;     // 开关开启时必填:一句话说明,最先输出,调用运行期间展示给用户
}

// input_command
{
  process_id: string;      // 必填:exec_command 返回的命令会话 id
  chars?: string;          // 写入 stdin 的字符;单独发送 "\u0003" 传递 Ctrl-C;缺省仅轮询
  yield_time_ms?: number;  // 等待时长;有写入默认 250,空轮询默认 110000(一次轮询等完多数构建;想快速查看可传更小值)
  description: string;     // 开关开启时必填
}

```

POSIX 上 Ctrl-C 向会话进程组发送 `SIGINT`，中断前台命令。Windows 无法向管道子进程投递控制台信号，Ctrl-C 因此退化为整棵命令会话进程树的强杀（`taskkill /t /f`）——前台命令及其启动的所有子进程一并终止，而不是仅中断前台命令。

### 文件工具

`read_file` / `edit_file` / `write_file` 与 Shell 工具一样以用户完整权限运行：相对路径按 Workspace 解析，也接受绝对路径。软链接路径会被解析到它指向的文件——读取、编辑、写入都落在该文件上，链接本身仍然是链接。三者均为非流式（一次性输出最终结果），从不抛异常——失败以解释性文本收尾，`stop_reason` 为 `failed`。

`read_file` 也读图片。png/jpeg/gif/webp 文件（不超过 5MB，先按魔数、再按扩展名识别）或 `file_path` 里的 http(s) URL（URL 只作图片来源，优先看响应的 content-type）走读图分支，返回什么取决于 Session 模型的 vision 标记：接受图片的模型拿到图片本身作为图像内容（文本输出只有一行 `image/png, 123.4 kB`）；text-only 模型拿到的是 Project 配置的 `vision_model` 对 `prompt`（缺省为详细描述）的回答，以流式文本作为工具输出——图片不进入该 Session 的历史。未配置 `vision_model` 时，text-only Session 的读图以解释性错误失败，请用户到模型设置中选一个。见 [模型与 Provider](/models)。分支由 SDK 仅为 text-only Session 注入 Environment 的 `VisionDescriberService` 决定，因此同一条配置条目（不带 `forModel`）同时服务两类模型。

```ts
// read_file — 文本文件按 cat -n 风格输出(行号、制表符、内容);超长单行会被截断,
// 不是受支持图片的二进制内容(含 NUL 字节)被拒绝并提示改用 Shell。图片(或 http(s) URL)
// 则返回图像内容或文字描述,并忽略 offset/limit。
{
  file_path: string;       // 必填:绝对路径,或相对 Workspace 的路径;图片亦可为 http(s) URL
  offset?: number;         // 起始行号(1 起);默认 1
  limit?: number;          // 最多返回的行数;默认 2000——未读完时尾部注记提示续读
  prompt?: string;         // 对图片的提问,text-only 模型时由 vision_model 回答;缺省为详细描述
}

// edit_file — 文件必须已存在;old_string 必须恰好出现一次(或设 replace_all);
// 成功时回显 "Replaced N occurrence(s)" 及改动区域的 git 风格 unified diff
// (每个替换点一个 hunk,相邻替换点合并;replace_all 大量命中时截断为少量 hunk
// 并附 "…and N more replacements" 注记)。
{
  file_path: string;       // 必填
  old_string: string;      // 必填:要替换的原文,须与文件内容(含空白/缩进)完全一致
  new_string: string;      // 必填:替换文本,须与 old_string 不同
  replace_all?: boolean;   // 替换全部出现处;默认 false
}

// write_file — 按需创建父目录;报告 "Created" 或 "Overwrote" 及行数/字节数。
// 覆写时还会附上与旧内容的小型 unified diff;改动过大时改为一行 +X/−Y 摘要。
{
  file_path: string;       // 必填
  content: string;         // 必填:完整文件内容;空字符串创建空文件
}
```

### Subagent

`run_subagent` 把一段能一次说清的子任务交给子 Agent 执行，同样是两段式：前台窗口(默认 300000ms)过后转入后台并返回 `subagent_id`，由 `input_subagent` 驱动；子 Agent 的待审批项会在轮询等待期间浮出。`input_subagent` 覆盖五种手势：`prompt` 为空仅轮询；子会话**运行中**发 `prompt` 即中途插话（与用户对主会话的运行中 steering 同一机制——在子会话下一步以 `[user_steering]` 消息送达，写入子 Trace、sender 记为 `parent_agent`）；空闲时发 `prompt` 即在同一会话上续跑一轮；`abort: true` 只停止子会话**当前这一轮**——会话保留、可继续插话、恢复或续跑；`resume: true` 则从中断或失败位置**断点续跑**子会话（可同时附带 `prompt` 进行重定向或补充说明）。`input_subagent` 每次访问的模型面输出是子会话**最近一条完整回复**——「它最后说了什么」的幂等快照，而非增量排空。传 `run_in_background: true` 则启动即返回 `subagent_id`，模型发起的每轮完成都以自动 user message 送达（面板发起的轮与被显式 abort 的轮不回报；见[后台完成回报](#后台完成回报)）。**Subagent 没有 kill**：与主 Agent 一样，子会话永不销毁——释放空闲会话只是腾出并发额度，已释放的 `subagent_id` 在再次收到消息时**自动复活**（模型访问与面板走同一条 resume 路径）。中断或失败的子代理会完整保留上下文与运行历史，随时可供恢复。

Web App 的智能体面板用**与主对话相同的 composer**（子会话变体）驱动选中的子会话：正文、技能与 slash 技能命令、思考等级选择器（钉在子会话上，从其下一个模型上下文生效）、上下文圆环（子会话自身用量）、锁定模型徽标，以及审批模式选择——它读写的是父会话的模式，子会话审批本就按其判定。发消息就是对子会话的一次用户输入，无论其状态如何：运行中即插话，空闲即续跑一轮，失败或中断时可点击**恢复**（Resume）按钮断点续跑，会话已被释放则**复活**——服务端按 resume 口径恢复该子 Session（沿用其历史、模型与 Workspace）并重新纳管，对话直接继续。操作按钮的停止面只中止子会话当前这一轮。这一切与 `input_subagent` 收敛到 core 的同一通道；面板的运行标识以服务端实况为准，不再从对话文本推断。

```ts
// run_subagent
{
  prompt: string;          // 必填:完整的子任务(含全部上下文与期望的最终产出)
  agent_id?: string;       // 子 Agent;缺省复用当前 Agent
  model_id?: string;       // 子 Session 模型,须与 provider 成对给出;两者都缺省时继承父 Session 的模型
  provider?: string;       // model_id 所属的 provider 组;给出 model_id 时必填
  thinking_level?: string; // "low" | "medium" | "high" | "xhigh" | "max";缺省继承父 Session 的思考等级
  yield_time_ms?: number;  // 前台等待时长;默认 300000
  run_in_background?: boolean; // true = 立即返回 subagent_id;完成回报以 user message 送达
  description: string;     // 开关开启时必填
}

// input_subagent
{
  subagent_id: string;     // 必填:run_subagent 返回的后台 Subagent id
  prompt?: string;         // 运行中即插话(steering);空闲时即续跑一轮;断点恢复时提供追加指引;缺省仅轮询
  abort?: boolean;         // 停止子会话当前这一轮(会话保留,被中止的轮不发完成回报);与 prompt 同给即打断并改道
  resume?: boolean;        // true = 从中断或失败位置断点恢复子会话运行
  yield_time_ms?: number;  // 等待时长;有追加默认 300000,空轮询默认 10000
  description: string;     // 开关开启时必填
}

```

- 深度上限为 1:Subagent 不能再派生 Subagent。
- 子 Session 跟随父 Session:模型(除非以 `model_id`/`provider` 显式指定)、thinking level(除非以 `thinking_level` 显式指定——机械性子任务可调低，深度分析可调高)与 Workspace 均继承父级，而非 Project 默认值。
- 子 Session 继承父 Agent 的审批回调，审批模式随父生效。
- 子 Session 拥有独立 Trace，父 Trace 以 `subagent` 指针事件链接；子消息带 `origin` 标记回流到父级消息流。见 [Session 与 Trace](/sessions-and-traces)。

### 后台完成回报

以 `run_in_background: true` 启动的任务，以及用户在 Web App 的工具调用行上转入后台的调用，都在结束时以**Harness 注入的 user message** 回报完成——模型无需轮询。消息以 `[background_task_done]` 标记块开头（kind、id、status、一行 detail），其后是任务内容与尚未送达输出的尾部（上限 4000 字符；Web App 将标记块折叠为一行提示）。其 `text` payload 带 `sender: "harness"`，在 Trace 中与真人输入相区分（见 [OmniMessage](/omni-message)）。

送达时机：Task 进行中时，回报搭乘下一个 turn 边界——即使最终回复已在流式输出，Task 也会为回应它再延续一个 turn。Session 空闲时，托管 Server 自动以该回报发起新 Task（SDK 嵌入方可订阅 `Session.onBackgroundNotice` / `takeBackgroundNotices`，否则回报并入下一次 run 的输入）。经 `input_command` 的 `kill` 终止的命令不发回报——该调用自身的结果已说明结局；被显式 `abort` 结束的子会话轮同样不发（打断者当场读到结局）。回报只覆盖**模型自己发起的轮**——`run_in_background` 的启动轮与 `input_subagent` 的续跑轮；用户从智能体面板发起的轮是用户与子会话自己的对话，不发回报（该轮答案文本留在模型面缓冲，下次轮询照常取得）。

停止照样回报，只是不算失败。被人主动结束的命令回报 `status: stopped`——用户在 Web App 进程列表按下的「停止」、从外部递来的停止信号（`SIGTERM`/`SIGINT`/`SIGHUP`：同进程组终端里的 Ctrl-C、`pkill`、停掉 dev server 的管理进程），以及 Harness 自己强制的停止（容量淘汰、空闲回收）——其标记块直白地告知模型：无人要求就不要重启它。对话确实需要知道自己启动的 dev server 已经不在了；但若措辞为 `failed`，它读起来就像崩溃，而面对崩溃的 dev server，模型合理的反应正是把它重新拉起来，把别人刚做的停止撤销。`failed` 留给无人要求的结局：spawn 错误、非零退出、硬杀与故障信号（OOM 杀进程、段错误）。

后台 Subagent 的生命周期与发起它的调用解耦：中止范围只属于它自己（逐轮 `abort` 只结束一轮；会话只随父 Session 终结，容量释放的也可复活），其消息经发起 Session 实时流向前端（与前台窗口转发同一条 origin 通道），工具审批经发起调用自身的审批回调作为常驻 sink 解决——`allow-all` 下即发即忘可全程无人值守，失败也以 `status: failed` 的回报收尾，而不是子会话永久卡住。

### 后台会话上限

| 会话类型 | 上限 | 淘汰策略 |
| --- | --- | --- |
| 命令会话 | 64 | 满时优先淘汰已退出者，否则对空闲会话按 LRU 淘汰 |
| Subagent 会话 | 8 | 只淘汰已完成者；运行中的从不淘汰，无空位则拒绝派生 |

## 审批

每个完整的 `tool_call` 触发且只触发一次审批决策：

```ts
type ApprovalDecision = "allow" | "deny" | "forbidden"; // "forbidden" = 命令策略的拦截
type ApproveFn = (toolCall: OmniMessage<ToolCallPayload>) => Promise<ApprovalDecision>;
```

| 使用面 | 行为 |
| --- | --- |
| SDK | 每次 `session.run` 传入 `approve` 回调；未注入时引擎默认全部拒绝(保守策略，避免无人值守下误放行) |
| CLI | `--approve` 四种模式：allow-all(默认)/ deny-all / read-only / always-ask;read-only 自动放行 `permission: "r"` 的工具，其余转人工 |
| Web / Server | 同样四种模式，按 Session 设置；每次决策前从数据库重读审批模式（修改即刻生效）；工具的 `r`/`rw` 取自运行中上下文的工具集——权限修改在下一次轮换（压缩）生效；人工决策经 API 送达 |

deny 会合成一条 `aborted` 的 `tool_call_output` 供模型据此调整策略——`Tool call denied by user.`，被[命令策略](/configuration#沙箱安全策略)拒绝时为 `Tool call denied by policy.`，策略命中因此不会被读成「有人取消了」。见 [ApproveFn](/interfaces#approvefn)。每次决策都以 `approval_decision` 事件写入 Trace（策略拦截即记 `forbidden`），构成完整的审计记录。审批发生在 [Agent 运行循环](/agent-loop) 的工具执行阶段。

子会话的审批不会因父任务结束而被自动拒绝。Web 服务端为每个会话运行时挂一个**会话生命周期的兜底审批出口**：没有活跃轮询窗口、也没有后台启动常驻出口的子会话审批请求直接上报用户（父会话空闲时亦然）；父任务结束或被停止时只收敛**主会话**自身的未决审批——带 origin 的子会话审批保持待决、审批卡持续显示，直到用户决定。未挂兜底出口的宿主（CLI）保持旧口径：子会话请求排队，等 `run_subagent` / `input_subagent` 调用活跃时透传。

## 自定义与 MCP

`system_config.yaml` 的 `tools.builtin` 数组以 `ToolDefinitionConfig` 同构条目声明工具集。注意语义是**整体替换而非合并**：整段省略时使用完整默认工具集；一旦写出，默认列表即被替换，要保留的每个工具都必须携带完整定义（含 `parameters` JSON Schema——工具的参数 schema 完全来自配置）。`tools.mcpServers` 承载 MCP Server 配置，见下节。另见 [配置参考](/configuration)。

```yaml
tools:
  # 写出 builtin 即整体替换默认工具集(此例刻意只保留一个最小工具集)。
  builtin:
    - name: exec_command
      description: Run a shell command in the workspace.
      permission: rw
      # 可选的条目级开关:false 时从 schema 滤除 parameters.properties 里声明的
      # description 调用参数(缺省保留)。
      call_description: false
      timeoutMs: 120000
      maxOutputLength: 16000
      # parameters: 必须携带完整 JSON Schema(默认定义见
      # packages/core/src/state/default-config.ts),此处从略。
  mcpServers: []
```

### MCP Server

`tools.mcpServers` 的每个条目是 `{ name, config }`：`name` 限字母/数字/`_`/`-`（作为工具名前缀），`config` 描述 transport，支持三种：

- `stdio`——本地进程（`command` / `args` / `env` / `cwd`）。进程环境为 SDK 安全继承环境叠加条目 `env`（后者覆盖前者）；Agent vault **不**注入 MCP Server 进程（与命令子进程不同）——Server 需要的变量须在条目 `env` 中显式列出。`cwd` 缺省为本次 Session 的 Workspace。
- `http`——Streamable HTTP，当前规范的远程 transport（`url` / `headers`）。
- `sse`——旧版 HTTP+SSE，仅为未迁移的服务保留（`url` / `headers`）。

`transport` 字段可省略：有 `command` 推断为 `stdio`、有 `url` 推断为 `http`；`sse` 必须显式。三种 transport 共享可选的 `connectTimeoutMs`（连接 + 工具发现预算，默认 10000）、`timeoutMs` / `maxOutputLength`（作用于该 Server 全部工具的执行约束，缺省用 Environment 默认值）与 `permission`（`auto` / `r` / `rw`，缺省 `auto`，见下方权限条目）。`headers` 附加到该 Server 的每个 HTTP 请求（含 SSE 流），可承载 `Authorization` 等认证头。

```yaml
tools:
  # direct（默认）：全部原生；auto：大型 MCP 目录走网关；lazy：全部走网关。
  toolExposure: direct
  # 仅用于 auto；0 表示始终启用网关。默认按 2048 个估算 token。
  toolExposureThresholdTokens: 2048
  mcpServers:
    - name: filesystem
      config:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
    - name: linear
      config:
        transport: http
        url: https://mcp.linear.app/mcp
        headers: { Authorization: "Bearer ..." }
        permission: r        # auto（缺省）| r | rw
```

行为口径：

- 三种暴露模式下，连接都采用**懒加载**：Session 创建即时返回，首个 `run()` 才并行连接全部 Server 并发现工具目录——连接期间流式发出一对 `mcp_connect_begin` / `mcp_connect_end` 事件（前端显示连接状态；end 带总体 status 与逐 Server 结果），完成后以 `tool_list_ready` 事件下发完整工具定义（见 [OmniMessage](/omni-message)）；这三条消息在 Trace 中写在本轮输入之后，归属新轮次。运行中打断即**取消**本次连接，下次 `run()` 重新连接。Direct 模式把首次发现结果作为 Session 生命周期内的快照；Auto 选中网关或使用 Lazy 时监听 `tools/list_changed`，只刷新私有目录；压缩开启下一个上下文时，Server 按当时的配置重新连接并调和（见[上下文压缩](/agent-loop)）。连接失败或条目非法只产生 stderr 警告并跳过该 Server，**不阻塞会话**。
- `toolExposure: direct`（默认）在 `tool_list_ready` 和每次模型请求中携带全部内置工具及首次发现的 MCP 定义。`auto` 保留内置工具；当初始 MCP 定义达到 `toolExposureThresholdTokens`（默认 2,048）时，将 MCP 部分放入固定的 `search_tools` 和 `call_tool` 网关；设为 `0` 时始终启用网关。这个选择在 Session 内不再改变。`lazy` 把内置和 MCP 工具都放入私有目录，模型只看到同一组固定网关。模型显式搜索目录、选择返回的工具契约，再把引用和符合 Schema 的参数交给执行网关。网关模式下，MCP 工具新增、删除或更新只改变私有目录；相同契约沿用原引用，Schema、权限或描述变化会使旧引用失效并返回替代契约，删除则返回 `tool_removed`。网关会解析实际权限，并沿用目标工具的超时和输出限制。人工审批展示的是服务端按引用解析出的真实目标（`call_tool → mcp__server__tool (rw)`），不信任模型提交的展示名称。这样可以减少 Schema 上下文并避免工具列表变化导致前缀失效，代价是首次发现冷工具可能多一次模型请求。
- 同一 Session 内不会随工具目录变化切换暴露模式。工具数量不能准确代表成本，因为不同 Schema 的体积差异很大；`auto` 因此按初始序列化 Schema 的估算体积决策，并在第一次模型请求前冻结。工具较少且会频繁使用时可选 `direct`；大多数场景可选 `auto`；只有明确希望内置工具也按需加载时才使用 `lazy`。
- 2026-09-30 对 11 个默认配置 Schema 的测量（紧凑 JSON，不含 Provider 请求封装）：`direct` 为 18,405 个字符（约 4,602 个 chars/4）；新增的 `knowledge_graph` 与 `code_graph` 共 4,704 个字符（约 1,176 个 chars/4）。`lazy` 固定暴露两个网关 Schema，共 1,309 个字符（约 328 个 chars/4），加入这两个工具后不变；匹配的目录定义只会按需返回。这些是粗略估算，并非 Provider tokenizer 的实际计数。
- Direct 模式会跳过不符合常见模型 API 函数命名限制的 MCP 工具；Lazy 模式把原生名称作为普通字符串传递，因此仍可通过网关调用这类工具。
- 发现的工具以 `mcp__<server>__<tool>` 进入统一工具命名空间，与内置工具走同一条[执行契约](#执行契约)（超时、截断、打断）与[审批](#审批)流程。
- 权限映射：缺省的 `permission: auto` 下，Server 注解 `readOnlyHint: true` 的工具为 `r`（read-only 审批模式自动放行），其余一律 `rw`——注解是未受信 hint，缺省取限制方向。把条目的 `permission` 设为 `r` 或 `rw`，则该 Server 的**全部**工具一律按此取值，覆盖注解——大量 Server 从不设置 `readOnlyHint`、因而整体落到 `rw`，这个字段就是为它们准备的。
- `permission` 的边界：它固定该 Server 每个工具对外报出的等级，而读这个等级的审批模式只有一个。`read-only` 下 `r` 工具自动放行、`rw` 工具需人工确认；`allow-all` / `deny-all` / `always-ask` 根本不查询它，标成 `rw` 的条目在这些模式下也不会多出一次审批。除此之外该字段什么都不做：不为 Server 提供沙箱，不限制其工具运行时的行为，不会发给 Server、也不向 Server 核验，Server 依旧拥有其 transport 赋予的全部能力。把一个实际能写的 Server 标为 `r`，撤掉的就是 `read-only` 本会索要的那次确认。
- 结果映射：text 块拼接为输出文本；image 块作为图片（data URL）随输出附带；audio 与二进制 resource 折叠为占位行；仅有 `structuredContent` 时将其序列化为 JSON；Server 报 `isError` 时落实为 `stop_reason: "failed"`，内容即 Server 给出的错误说明。
- Session 结束（`Environment.dispose`）关闭全部 MCP 客户端，stdio 子进程一并退出。
