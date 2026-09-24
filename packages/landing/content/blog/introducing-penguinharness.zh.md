---
title: PenguinHarness 正式发布：让 Agent 为你构建 Agent
date: 2026-07-17
category: news
pinned: true
excerpt: PenguinHarness 是一款用于构建与进化 Agent 的开源 Harness，提供 CLI、Web UI，并支持多种模型。
---

今天，我们正式发布 **PenguinHarness**——一个为构建与进化 Agent 而生的开源 Harness：零代码的 Harness CLI 与 Web UI，连接 1000+ 模型。它要讲的故事只有一句话：

> 使用 LangChain，以 1 倍速度人工构建 Agent；使用 PenguinHarness，以 100 倍速度用 Agent 构建 Agent。

## 从 GDPevo 到 PenguinHarness：我们的初心

在 PenguinHarness 之前，我们团队发布了 [GDPevo Benchmark](https://prism-shadow.github.io/GDPevo/)。在 GDPevo 中，我们系统性地验证了一件事：**Agent 可以自我进化**——让 Agent 评估自己的表现、定位失分原因、改写自己的提示词与技能，分数随版本一路上升。

能力验证了，问题就变成了：怎么让每个人都用上它？自我进化不该只是论文里的曲线，而应该是每个开发者桌面上开箱即用的基础设施。**让每个人都能使用 Efficient Self-Improving Harness，这就是我们构建 PenguinHarness 的初心**——它也因此得名：Efficient Self-Improving Harness for Everyone.

## 为什么是 PenguinHarness

三个递进的理由——从任务效果，到构建方式，再到进化能力。

### 1. 面向复杂任务构建

精简的工具集和清晰的底层接口，旨在支持跨模型的 Agent 工作流。我们正在准备公开 Benchmark；此前的对比数字缺少足够证据，无法复现或核验，因此已撤下。正式发布时会同时提供题目、评分规则、原始结果、运行产物和成本计算所用的带日期价格。

### 2. 一句话，让 Agent 构建 Agent 应用

输入一句话，Agent 为你构建完整的 Agent 应用——脚手架、代码、运行说明，一步到位：

```text
收集 https://github.com/ericbuess/claude-code-docs 的文档，做一个化身 Claude Code 配置专家、回答带来源引用的 RAG 问答应用。
```

这是做出来的成品——一个文档专家：检索增强、引用可点击直达原文、内置示例问题：

![生成的 RAG 应用成品：Claude Code 配置专家，回答带可点击的来源引用与示例问题](/blog-assets/rag-app-zh-light.webp)

**而生成整个 RAG 应用，仅消耗了 0.2 元（$0.02）的 token——使用 DeepSeek V4 Pro 模型。**

### 3. 自进化，越用越强

借助 PenguinHarness 技能库，Agent 自己评估、自己优化：Optimizer 组织多个 Evaluator 并行打分，依据分数与运行轨迹定位失分原因，把 Agent 从版本 N 优化到版本 N+1——每轮之前自动快照，每个请求都可在轨迹观测中回放。自进化演示视频即将上线。

## 进化有界，安全先行

自我进化最大的疑虑是失控。PenguinHarness 用一份契约（CONTRACT.md）回答这个问题：

- 进化严格限制在 Workspace 与 Skill 之内，不修改 Harness 核心安全边界；
- 工具调用先经批准，每次批准皆留审计；
- 风险修改之前先留版本快照，任何一次进化都可回退；
- 完全开源、本地部署，数据不出域，满足企业级数据安全。

## 支持的模型

| 模型             | 可用供应商                                                                       |
| ---------------- | -------------------------------------------------------------------------------- |
| DeepSeek V4      | DeepSeek, OpenRouter, Fireworks AI, SiliconFlow, Qwen Token Plan                 |
| Kimi K3          | Moonshot AI, OpenRouter, Qwen Pay-As-You-Go                                      |
| GLM 5.2          | Z.AI, OpenRouter, Fireworks AI, SiliconFlow, Qwen Token Plan, Qwen Pay-As-You-Go |
| Hunyuan 3        | OpenRouter                                                                       |
| Qwen 3.8 Max     | Qwen Token Plan（预览）                                                          |
| GPT 5.5          | OpenAI, OpenRouter                                                               |
| Gemini 3.5 Flash | Google Gemini, OpenRouter                                                        |
| Claude Opus 4.8  | Anthropic, OpenRouter                                                            |

只要是 OpenAI 协议的端点都可以接入：从上表选择预置，或用自定义端点连接 1000+ 在线与本地模型。

## 如何使用

一行命令安装（Linux / macOS，x64 / arm64，内嵌 Node 运行时），然后启动 Web 界面：

```bash
curl -fsSL https://penguin.ooo/install.sh | sh
penguin web        # 打开 http://127.0.0.1:7364（首次登录：admin，初始密码见首次启动输出）
```

进入「模型仓库」页，在 DeepSeek 或 OpenRouter 分组里粘贴 API key 并设为默认；回到对话页，把第一个任务交给 Agent——例如「分析 data.csv，输出各季度销售额汇总」。

## 发展计划

- Benchmark 套件正式发布；
- 推出桌面端（Desktop）应用；
- 支持 Windows 系统；
- 更多规划，敬请期待。

## 加入社区，一起共建

自我进化的 Harness，也需要一个不断进化的社区。欢迎加入讨论、提出需求、贡献代码——你的第一个 Issue 就是最好的开始：

- [Discord](https://discord.gg/eFHKqqcU3D)：与我们和其他开发者实时交流；
- [X（Twitter）](https://x.com/code_hiyouga)：关注最新动态；
- [微信群](https://github.com/Prism-Shadow/penguin-harness-community/blob/main/wechat/group.jpg)：中文社区讨论；
- [GitHub](https://github.com/Prism-Shadow/penguin-harness)：Star、Issue 与 PR 都欢迎。

让每个人都用上会自我进化的 Agent 基础设施——从今天开始。
