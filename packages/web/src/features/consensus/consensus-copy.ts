import type { Locale } from "../../state/locale";

const copy = {
  en: {
    title: "Agent coordination",
    introDemo:
      "Try proposals, messages and handoffs with local sample data. Changes are not sent to agents or saved after leaving this page.",
    introLive: (parts: string) =>
      `${parts} reflect the current project. Decisions remain a local demo.`,
    decisions: "Decisions",
    messages: "Messages",
    handoffs: "Handoffs",
    propose: "Propose decision",
    proposeTitle: "Propose a decision",
    newTopic: "New topic",
    createProposal: "Create Proposal",
    cancel: "Cancel",
    messagesDemo: "Messages (local demo)",
    messagesLive: "Messages (live)",
    composeMessage: "Compose demo message",
    fromAgent: "From agent",
    addDemoMessage: "Add demo message",
    handoffsDemo: "Handoffs (local demo)",
    handoffsLive: "Handoffs (live)",
    simulate: "Simulate Next Stage",
    advancing: "Advancing...",
  },
  zh: {
    title: "智能体协作",
    introDemo:
      "在本地示例数据中体验提案、消息和交接。离开此页面后，变更不会发送给 Agent，也不会保存。",
    introLive: (parts: string) => `${parts}反映当前项目状态。决策仍为本地示例。`,
    decisions: "决策",
    messages: "消息",
    handoffs: "交接",
    propose: "提出决策",
    proposeTitle: "提出决策",
    newTopic: "新主题",
    createProposal: "创建提案",
    cancel: "取消",
    messagesDemo: "消息（本地演示）",
    messagesLive: "消息（实时）",
    composeMessage: "编写演示消息",
    fromAgent: "发送 Agent",
    addDemoMessage: "添加演示消息",
    handoffsDemo: "交接（本地演示）",
    handoffsLive: "交接（实时）",
    simulate: "模拟下一阶段",
    advancing: "正在推进…",
  },
} as const;

export function consensusCopy(locale: Locale) {
  return copy[locale];
}
