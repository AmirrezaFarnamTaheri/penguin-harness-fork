PenguinHarness fork 0.2.14 引入了统一 Agent Cockpit 驾驶舱套件、自主多智能体协同集群（Swarm Coordinator）、实时 AST 语法拓扑监控、大模型密钥集群（Key Fleet）健康探测，以及全栈运行时效率与资源包体积优化。

## 安装

推荐直接使用此 Fork 的 Release 构件。桌面安装程序与独立二进制包均已内嵌运行环境；npm 安装要求 Node.js 24 或更高版本。

## 核心特性

- **统一 Agent 驾驶舱（Cockpit）**：基于 WebSocket（`/api/cockpit/stream`、`/ws/cockpit`）与 REST 的实时遥测多路复用器，全面整合集群协作、Mailbox 消息队列、Turn Ledger 执行账本、看门狗心跳、密钥集群健康度、轨迹回放与系统资源监控。
- **自主多智能体集群协同器**：编排 5 类专职角色（`orchestrator`、`coder`、`reviewer`、`tester`、`researcher`），支持线程安全的 Mailbox 租约传递、Quorum 法定人数共识机制以及不可变执行历史。
- **跨平台自适应命令沙箱**：深度联动 ShellGuardian 安全策略，在 macOS（Seatbelt）、Linux（Bubblewrap）与 Windows（隔离进程树管控）上提供防御性安全隔离。
- **增量式 AST 代码图谱监听器（CodeGraph Watcher）**：实时捕获代码编辑事件，免全量扫描即时提取语法符号并推送拓扑流变更。
- **多模型密钥集群管理**：支持多厂商 API 密钥轮换、健康探测、延迟追踪、冷却恢复与容灾切换。
- **桌面系统托盘与全局 HUD 悬浮窗**：支持全局快捷键（`CommandOrControl+Shift+P`）快速唤起/隐藏 Cockpit HUD，与系统托盘常驻守护。

## 性能与体积优化

- **双语字典代码拆分与按需加载**：重构多语言字典架构，使 Web 初始入口脚本体积从 394.72 kB（136.26 kB gzip）大幅下降至 80.14 kB（22.75 kB gzip），**首屏脚本体积直降 80%**。
- **桌面构建跨入口代码去重**：开启 tsup 代码分块机制，提取服务端与命令行之间的重复第三方依赖，使桌面构建总包体积**缩减 7.0 MB（减少 32.8%）**，构建速度提升 3.5 倍。
- **流式对话渲染节流与状态记忆**：基于 WeakMap 在 `MessageItem` 与 `WorkGroup` 层实现已完成回合的渲染跳过，彻底消除高频流式输出下的全量界面重绘卡顿。
- **JSON 传输动态压缩**：为大于 1 KB 的 API JSON 响应启用 gzip 压缩，同时严密保障 SSE 流式通道即时传输不受影响。
- **拓扑画布渲染优化**：利用 `requestAnimationFrame` 节流平移计算，并引入视距细节（LOD）裁切，在远景缩放视角下剔除耗时滤镜与文字渲染。

## 环境要求

Linux / macOS（x64 / arm64）或 Windows 10+（x64）。
