# 原生网页搜索与网页访问路线图

- **Date:** 2026-08-11
- **Type:** feature
- **Scope:** `core`, `tooling`

[English](2026-08-11-native-web-search.md)

PenguinHarness 新增了基于 SearXNG 的原生 `web_search` 工具。它向主机配置的端点发送有界搜索请求，返回规范化的标题、HTTP(S) URL、摘要及发布日期。搜索输出明确标记为不可信的外部内容。模型可以选择查询、结果数量、语言、安全搜索等级及时间范围，但不能选择服务端点，也不能把该工具用于任意 URL 请求。

端点按以下顺序解析：SDK 注入的服务覆盖值、Agent Vault 中的 `SEARXNG_ENDPOINT`、进程环境中的 `SEARXNG_ENDPOINT`，最后是 `http://127.0.0.1:8080`。SearXNG 必须在 `search.formats` 中启用 JSON。

`web_search` 使用现有的只读（`r`）权限，因此 CLI 和 Server 在 `read-only` 模式下自动允许调用。工具权限模型仍为现有的 `r` / `rw` 两级。

新建及重置的 Agent 会在默认工具列表中获得 `web_search`。已有 Agent 保留已保存的列表，需要恢复默认值或手动添加工具定义。后续原生网页功能规划包括静态 `web_fetch`、面向动态页面的可选 Playwright 回退，以及严格限制范围的 `web_crawl`。Firecrawl 仍是可选集成，而非必需的运行时依赖。由安装器管理的本地 SearXNG 部署和健康检查仍属于独立的规划阶段；本次发布提供了原生客户端及默认端点，但不会启动搜索服务。
