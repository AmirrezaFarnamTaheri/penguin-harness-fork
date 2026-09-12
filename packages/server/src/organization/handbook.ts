/**
 * The organization handbook index — `handbook/README.md`; the `handbook/` directory is the
 * company's knowledge base and this file is the one every work run reads first (progressive
 * loading: the trigger block points here, the index points at the files and documents).
 * Generated once at creation from the template of the organization's working language — the
 * two templates carry the same sections and tables, with paths, commands, ids and field
 * names ASCII in both; the CEO and HR own the file afterwards and may rewrite any of it.
 */
import type { OrgLanguage } from "../api/types.js";

export interface HandbookInput {
  orgId: string;
  name: string;
  mission: string;
  ceoAgentId: string;
  createdBy: string;
  /** The organization's working language: which of the two templates is rendered. */
  language: OrgLanguage;
}

export function renderHandbook(input: HandbookInput): string {
  return input.language === "zh" ? renderZh(input) : renderEn(input);
}

function renderEn(input: HandbookInput): string {
  const dir = `<app_data_dir>/organizations/${input.orgId}`;
  return `# ${input.name} — organization handbook

Organization id: \`${input.orgId}\` · CEO: \`${input.ceoAgentId}\` · Board (creator): \`user:${input.createdBy}\`

## Mission

${input.mission}

## Working language

This organization works in English: channel messages, tickets (title, goal, acceptance
criteria, progress, result), handbook documents, calendar prompts and employee briefs are
written in it. Commands, file names, ids and field names stay ASCII.

## How this organization runs

- Every employee is an Agent. The reporting tree lives in \`org_chart.yaml\`; the CEO is the root.
- Each employee has one standing **desk session**. Calendar events and channel mentions arrive
  there as a message that starts with an \`[org_trigger]\` block; ticket changes are listed in the
  next calendar sweep, never sent on their own. The desk session schedules work; it does not do
  the ticket work itself.
- Work is carried by **tickets** on the board. A ticket's owner opens a separate **ticket
  session** for it from its desk (\`penguin org ticket start <id>\`), tracks it, checks the result
  and writes progress back. Only the owner's desk — or a person — starts a ticket's sessions:
  work moves to another employee by reassigning the ticket
  (\`penguin org ticket assign <id> --owner agent:<employee>\`), and that desk picks it up in its
  next sweep. The owner may add \`--agent-id <colleague>\` to enlist a colleague on its own
  ticket. Several sessions and several employees may contribute to one ticket.
- Talking happens in **channels**, each a directory under \`channels/\`. \`default_channel\` is the
  all-hands channel every employee and every board member is in; anyone may open more for a stream or a
  big ticket and invite the principals that work needs. Only \`@<employee>\` and \`@all\` deliver
  a message to someone's desk, and only inside the channel's own membership; everything else is
  just recorded.
- The **calendar** is the only periodic driver: an event's prompt tells the employee what to
  look at. HR keeps every employee on exactly one recurring event at its own hour — a rota,
  not a broadcast: cadences differ by role (daily owners, 2–3 days for reviewers, weekly for
  finance) and no two desks share a start minute.
- **Budgets** are monthly caps per employee (own spend plus every subordinate). Reaching the
  warning ratio posts a system message in the all-hands channel; reaching the pause ratio stops
  that employee's calendar until the next month or a raised budget. People can always talk to a
  desk directly.

## Directory layout

\`${dir}/\`

| Path | What it is | Who writes it |
| --- | --- | --- |
| \`org_config.toml\` | name, mission, status, timezone, working language, approval mode, mention-chain and budget thresholds | people, CEO |
| \`org_chart.yaml\` | employee tree: title, reports_to, duties, workspace, budget, model | CEO, HR (\`penguin org hire\` / \`employee set\`) |
| \`handbook/\` | the knowledge base: this index (\`README.md\`) and the documents it lists | CEO, HR, employees (\`penguin org handbook …\` or file tools) |
| \`desks.toml\` | employee → current desk session (fact file) | the server |
| \`calendar/<agent_id>/<event>.toml\` | calendar events, one file each (same fields as scheduled tasks, no target) | employees (\`penguin org calendar …\`) |
| \`tickets/<yyyy-mm>/<column>/<yyyy-mm-dd>-<slug>.md\` | tickets; the column directory is the status | anyone (\`penguin org ticket …\`) |
| \`channels/<channel_id>/channel.toml\` | a channel: name, purpose, members (\`default_channel\` is everyone) | members (\`penguin org channel …\`) |
| \`channels/<channel_id>/<yyyy-mm-dd>.jsonl\` | a channel's messages, one per line | the server (\`penguin org channel send\`) |
| \`workspace/\` (or the \`workspace\` path in \`org_config.toml\`) | the shared workspace; the CEO assigns sub-directories to desks — a relative sub-directory is created by the server when it is assigned, an absolute path must already exist | employees |

Paths in prompts use \`<app_data_dir>\` placeholders; resolve them from the Environment section
of your system prompt. Never write absolute paths into files other people read.

## Principals

People and employees are named \`user:<user_id>\` and \`agent:<agent_id>\` in every structured
field (ticket headers, message senders and mentions). \`all\` in a mention means every member of
that channel — in the all-hands channel, every employee; \`system\` is the scheduler. In message
text \`@<id>\` is shorthand: employees resolve first, then Project members; write
\`@agent:<id>\` or \`@user:<id>\` when both exist.

## Ticket protocol

- Columns: \`proposed\` → \`in_progress\` → \`review\` (optional) → \`done\`, or \`rejected\` (give a reason).
- Anyone may propose. The CEO, the owner's manager or a person accepts (→ in_progress) or rejects.
- The owner moves a finished ticket to \`review\`; the CEO or a person moves it to \`done\`.
  P2 tickets may go straight to \`done\` when the acceptance criteria are plainly met.
- Before a ticket session ends it writes progress (\`penguin org ticket progress <id> -m …\`) and
  moves the ticket if the work is complete.
- Stuck (waiting for a decision, another ticket, a missing key): \`penguin org ticket block <id>
  --reason … --by …\` and stop working on it. Blocked tickets are skipped by the sweep until unblocked.
- Name every input you rely on and every deliverable you produce by its full path (absolute, or
  \`<app_data_dir>/…\`) in \`## Goal\`, \`## Acceptance criteria\`, your progress lines and \`## Result\`;
  a colleague must be able to open it without asking.
- Closing a ticket notifies its \`Notify\` list, and the initiator when it is an employee; a person
  who wants to hear about it lists themselves in \`Notify\`.

## Decisions belong to the board

The CEO proposes; the board (the creator, \`user:${input.createdBy}\`) decides. Before hiring
(which roles, budgets, models), before setting or raising a budget, before rejecting someone
else's ticket or closing a P0 / P1 ticket without review, before anything that reaches outside
the organization (publishing, accounts, money) and before changing this handbook or the
organization's structure, the CEO posts one clear proposal in the all-hands channel mentioning
the board and stops until the answer comes back. Employees raise such matters to their manager;
the CEO takes them to the board. Routine work inside an accepted plan needs no confirmation.

## Channel etiquette

- Mention someone only for a decision, a blocker, or a completion report. Never \`@all\` for chatter.
- Answer in the channel the trigger names (its \`channel:\` line):
  \`penguin org channel send --channel <id> -m …\`. During your calendar sweep read the channels
  you are in: \`penguin org channel ls\`, then \`penguin org channel tail --channel <id>\`.
- Open a channel when a thread would drown the all-hands channel — one per stream or per big
  ticket (\`penguin org channel create <id>\`), invite exactly the principals the work needs
  (\`penguin org channel invite <id> <principal>\`), and say so once in the all-hands channel.
- You read and post only in channels you are a member of, and an employee joins one only when a
  member invites it. What the board must decide goes to the all-hands channel, where they read.
- A message that mentions someone who is not in the channel is refused: invite them first.
- Mention chains stop after a few hops on purpose; a person or the calendar restarts the thread.

## Roles

- **CEO** (\`company-ceo\` skill): turns the mission into tickets, hires, partitions the shared
  workspace, opens one channel per stream and invites its owners, reviews tickets, reports to
  the board in the all-hands channel.
- **HR** (\`company-hr\` skill): keeps every employee scheduled, hires and offboards, evaluates
  and improves employees, keeps this handbook current.
- **Finance** (\`company-finance\` skill): sets budgets, audits spend daily, explains alerts and
  proposes savings.
- **Everyone** (\`company-employee\` skill): reads this handbook first, sweeps the board, opens
  and tracks ticket sessions, writes results back, blocks instead of idling, reports in its channels.

## Knowledge base

This directory (\`handbook/\`) is the company's knowledge base and this file is its index —
the one file every run reads first. Keep durable knowledge here, one Markdown file per
subject: decisions the board took (\`decisions/<yyyy-mm-dd>-<slug>.md\`), conventions,
how-tos, product and market facts, anything the next run must not have to rediscover.
List every document below with one line saying when it matters, so a run reads a document
only when its line says so. \`penguin org handbook list | show <path> | write <path>\`
reads and writes documents; the index cannot be deleted.

## Documents

_None yet._

## Command reference

See the \`company-employee\` skill for the full \`penguin org\` command surface. Inside a desk or
ticket session \`--org-id\`, \`--project-id\`, \`--agent-id\` and the current session are already
known from the environment.
`;
}

function renderZh(input: HandbookInput): string {
  const dir = `<app_data_dir>/organizations/${input.orgId}`;
  return `# ${input.name} — 组织手册

组织 id：\`${input.orgId}\` · CEO：\`${input.ceoAgentId}\` · 董事会（创建者）：\`user:${input.createdBy}\`

## 使命

${input.mission}

## 工作语言

本组织以中文开展工作：频道消息、工单（标题、目标、验收标准、进度、结果）、手册文档、
日历提示和员工简报均使用中文。命令、文件名、id 和字段名保持 ASCII。

## 组织如何运作

- 每位员工都是一个 Agent。汇报关系树保存在 \`org_chart.yaml\` 中；CEO 是根节点。
- 每位员工都有一个长期存在的 **desk session**。日历事件和频道提及会作为以
  \`[org_trigger]\` 块开头的消息送达该会话；工单变更只会在下一次日历巡检中列出，
  不会单独推送。desk session 负责安排工作，不直接执行工单工作。
- 工作通过看板上的 **tickets** 承载。工单负责人从自己的 desk 为工单打开独立的
  **ticket session**（\`penguin org ticket start <id>\`），跟踪执行、检查结果并回写进度。
  只有负责人的 desk 或真人可以启动该工单的会话。若要把工作交给其他员工，应重新
  分配工单（\`penguin org ticket assign <id> --owner agent:<employee>\`），由新的负责人在
  下一次巡检时接手。负责人也可以在自己的工单上追加 \`--agent-id <colleague>\`，邀请
  同事协作。一个工单可以由多个会话和多名员工共同完成。
- 沟通发生在 **channels** 中，每个频道对应 \`channels/\` 下的一个目录。
  \`default_channel\` 是全员频道，所有员工和董事会成员都在其中；任何人都可以为工作流
  或大型工单创建其他频道，并邀请所需主体。只有 \`@<employee>\` 和 \`@all\` 会把消息
  投递到某人的 desk，而且只能在该频道成员范围内生效；其他内容只会被记录。
- **calendar** 是唯一的周期性驱动器：事件提示会告诉员工要检查什么。HR 为每位员工
  保持恰好一个周期事件，并错开执行时间；不同角色采用不同频率（日常负责人每天、
  审核者每 2–3 天、财务每周），两个 desk 不共享同一个开始分钟。
- **Budgets** 是每位员工的月度上限（自己的花费加所有下属的花费）。达到警告比例时，
  系统会在全员频道发布系统消息；达到暂停比例时，该员工的日历会暂停到下个月，或在
  提高预算后恢复。真人仍然可以随时直接与 desk 对话。

## 目录结构

\`${dir}/\`

| 路径 | 用途 | 谁写入 |
| --- | --- | --- |
| \`org_config.toml\` | 名称、使命、状态、时区、工作语言、审批模式、mention-chain 和预算阈值 | 真人、CEO |
| \`org_chart.yaml\` | 员工树：title、reports_to、duties、workspace、budget、model | CEO、HR（\`penguin org hire\` / \`employee set\`） |
| \`handbook/\` | 知识库：本索引（\`README.md\`）及其列出的文档 | CEO、HR、员工（\`penguin org handbook …\` 或文件工具） |
| \`desks.toml\` | 员工 → 当前 desk session（事实文件） | 服务器 |
| \`calendar/<agent_id>/<event>.toml\` | 日历事件，每个事件一个文件（字段与 scheduled tasks 相同，但没有 target） | 员工（\`penguin org calendar …\`） |
| \`tickets/<yyyy-mm>/<column>/<yyyy-mm-dd>-<slug>.md\` | 工单；column 目录即状态 | 任何人（\`penguin org ticket …\`） |
| \`channels/<channel_id>/channel.toml\` | 频道：name、purpose、members（\`default_channel\` 包含所有人） | 成员（\`penguin org channel …\`） |
| \`channels/<channel_id>/<yyyy-mm-dd>.jsonl\` | 频道消息，每行一条 | 服务器（\`penguin org channel send\`） |
| \`workspace/\`（或 \`org_config.toml\` 中的 \`workspace\` 路径） | 共享工作区；CEO 将子目录分配给 desk。相对子目录由服务器在分配时创建，绝对路径必须已存在 | 员工 |

提示中的路径使用 \`<app_data_dir>\` 占位符；请从系统提示的 Environment 部分解析它。
不要把绝对路径写进其他人会读取的文件。

## 主体标识

真人和员工在所有结构化字段（工单头、消息发送者和提及）中分别使用
\`user:<user_id>\` 和 \`agent:<agent_id>\`。提及中的 \`all\` 表示该频道的所有成员；
在全员频道中即所有员工。\`system\` 表示调度器。消息正文中的 \`@<id>\` 是简写：
先解析员工，再解析 Project 成员；如果两者同名，请写 \`@agent:<id>\` 或 \`@user:<id>\`。

## 工单协议

- 列状态：\`proposed\` → \`in_progress\` → \`review\`（可选）→ \`done\`，或 \`rejected\`（必须给出原因）。
- 任何人都可以提出工单。CEO、负责人的经理或真人可以接受（→ in_progress）或拒绝。
- 负责人完成工作后把工单移到 \`review\`；CEO 或真人将其移到 \`done\`。
  当验收标准显然满足时，P2 工单可以直接进入 \`done\`。
- ticket session 结束前必须写入进度（\`penguin org ticket progress <id> -m …\`）；
  如果工作已经完成，还要移动工单状态。
- 如果卡住（等待决策、另一个工单、缺失密钥）：执行 \`penguin org ticket block <id>
  --reason … --by …\` 并停止处理。被阻塞的工单在解除阻塞前会被巡检跳过。
- 在 \`## Goal\`、\`## Acceptance criteria\`、进度行和 \`## Result\` 中，用完整路径
  （绝对路径或 \`<app_data_dir>/…\`）写明依赖的每个输入和产出的每个交付物；同事应当
  不用询问就能直接打开它们。
- 关闭工单会通知其 \`Notify\` 列表；如果发起者是员工，也会通知发起者。真人若希望收到
  通知，应把自己加入 \`Notify\`。

## 决策归董事会

CEO 提案；董事会（创建者 \`user:${input.createdBy}\`）决策。在招聘（角色、预算、模型）、
设置或提高预算、拒绝他人的工单、未经 review 关闭 P0 / P1 工单、执行任何触达组织外部的
动作（发布、账号、资金），以及修改本手册或组织结构之前，CEO 都必须在全员频道发布一条
清晰提案并提及董事会，然后停止执行，直到收到答复。员工将此类事项上报经理；CEO 再提交
董事会。在已获批准计划范围内的日常工作不需要再次确认。

## 频道礼仪

- 只在需要决策、报告阻塞或报告完成时提及他人。不要用 \`@all\` 闲聊。
- 在触发器指定的频道（其 \`channel:\` 行）回复：
  \`penguin org channel send --channel <id> -m …\`。日历巡检期间，先用
  \`penguin org channel ls\` 查看自己所在频道，再用
  \`penguin org channel tail --channel <id>\` 阅读消息。
- 当一个话题会淹没全员频道时，为每个工作流或大型工单单独创建频道
  （\`penguin org channel create <id>\`），只邀请工作真正需要的主体
  （\`penguin org channel invite <id> <principal>\`），并在全员频道说明一次。
- 只能读取和发送自己所属频道的消息；员工只有在现有成员邀请后才能加入频道。
  必须由董事会决定的事项应发送到全员频道，董事会在那里阅读。
- 如果消息提及了不在频道中的人，发送会被拒绝：先邀请对方。
- mention chain 会在少量跳数后有意停止；真人或日历可以重新启动对话链。

## 角色

- **CEO**（\`company-ceo\` skill）：把使命拆成工单，招聘员工，划分共享工作区，为每个
  工作流创建频道并邀请负责人，审核工单，并在全员频道向董事会汇报。
- **HR**（\`company-hr\` skill）：保证每位员工都有调度，负责招聘和离职，评估并改进
  员工，并维护本手册。
- **Finance**（\`company-finance\` skill）：设置预算，每日审计花费，解释告警并提出节省方案。
- **Everyone**（\`company-employee\` skill）：首先阅读本手册，巡检看板，打开并跟踪 ticket
  session，回写结果；遇到阻塞时显式 block，而不是空转，并在所属频道汇报。

## 知识库

本目录（\`handbook/\`）是公司的知识库，本文件是其索引，也是每次运行最先读取的文件。
把长期有效的知识保存在这里，每个主题一个 Markdown 文件：董事会决策
（\`decisions/<yyyy-mm-dd>-<slug>.md\`）、约定、操作方法、产品和市场事实，以及下一次运行
不应重新探索的任何信息。在下方为每个文档列一行，并说明何时需要读取它；这样运行只会在
对应说明适用时加载该文档。\`penguin org handbook list | show <path> | write <path>\`
用于读写文档；本索引不能删除。

## 文档

_暂无。_

## 命令参考

完整的 \`penguin org\` 命令面请参阅 \`company-employee\` skill。在 desk 或 ticket session 内，
\`--org-id\`、\`--project-id\`、\`--agent-id\` 和当前 session 已经从环境中获知。
`;
}
