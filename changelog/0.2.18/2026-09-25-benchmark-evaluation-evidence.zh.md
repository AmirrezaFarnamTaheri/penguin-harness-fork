# 新增只读的 Benchmark 评测证据接口

- **Date:** 2026-09-25
- **Type:** feature
- **Scope:** `server`, `docs`

[English](2026-09-25-benchmark-evaluation-evidence.md)

`GET /api/projects/:p/agents/:a/benchmarks/:benchmarkId/evaluations/:evaluationIndex/evidence` 现在会实时从磁盘重读、而不是照抄记分板，报告某条记分板记录背后的实际产物。它回答记分板本身回答不了的问题：这些数字是否仍被当初产生它们的产物支撑？

## 细节

- 该次评测的每一轮都会返回：记分板成绩、Trace 分片路径与 SHA-256 摘要（`verified`、`missing`、`unreadable`、`too_large`），以及按当前价格计算的令牌总量与成本（`verified`、`missing`；模型没有带日期的价格表时为 `uncosted`）。并由这两路来源推导出每轮的 `state`：`complete`、`missing_trace`、`missing_usage`、`uncosted` 或 `incomplete`。
- 在组装结果前会先对齐 Agent 的 Trace 索引，因此不会因为索引过期而把分片确实在磁盘上的轮次误报为缺失。只解析该 Project 与该 Agent 所属的会话；位于该 Agent 轨迹根目录之外的分片会被标为 `unreadable` 而不是照样计算摘要。文件数量与总字节数都有上限，超限的轮次标为 `too_large` 而不是被静默截断。
- 全程不写入任何内容：记分板、Trace 分片与用量账本均按原样读取；缺失或无法校验的产物就如实报告，不会被回填。
- 该路由对任意成员可读，对非成员返回 404，与其他 Benchmark 读取路由一致。
