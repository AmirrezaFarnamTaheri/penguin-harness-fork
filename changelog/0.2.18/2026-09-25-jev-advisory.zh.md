# 增加由宿主持有的 Jev 顾问集成

- **Date:** 2026-09-25
- **Type:** feature
- **Scope:** `core`, `server`, `docs`

[English](2026-09-25-jev-advisory.md)

PenguinHarness 现在可以在模型拟执行工具调用时，向 TypeSafe AI Jev 请求一个有界的顾问观察结果。集成使用已验证的 `@typesafe-ai/sdk` System One 客户端，并通过现有的 pre-tool-use Trace 事件路径记录 `choice`、`score` 和 `noul` 结果。

## 细节

- 顾问由宿主通过 `createAgent({ jevAdvisor })` 组合；服务端只有显式设置 `PENGUIN_JEV_API_KEY` 环境变量时才启用。Agent 可写的配置不能选择端点或凭证。
- 默认请求只包含工具元数据，不包含参数值。只有宿主显式选择时才会发送经过清理的参数值；请求有严格截止时间和本地熔断器，提供方失败时回到原有工具路径。
- 宿主传输固定使用官方 HTTPS 端点（本地测试替身仅允许回环 HTTP）、拒绝重定向，把协议无效响应当作熔断失败，并只记录白名单诊断。安装式 hook 和交互式终端都不会继承 harness 的 `PENGUIN_*` 凭证。
- 被截断的工具输出在写入恢复归档前会先做凭证清理。这一步暴露出凭证清理器的 URI 规则会在长字符段的每个位置重试协议名扫描，使清理耗时随输入长度平方增长——256 KiB 的内容要 28 秒，满 8 MiB 则永远跑不完。该规则现在使用带边界保护、长度受限的协议名，匹配结果不变，耗时回到线性（8 MiB 约 16 毫秒）。
- Jev 结果仅作为事件：不能允许、拒绝或替代项目命令策略、Environment 权限或人工审批回调。顾问关闭或不可用时不会产生任何决定。
- Jev 适配器从 `@prismshadow/penguin-core/jev` 发布，配置与 SDK 组合方式已补充中英文文档。
