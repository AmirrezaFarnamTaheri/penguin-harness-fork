import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ConsensusPage, type ConsensusPageProps } from "../src/features/consensus/consensus-page";
import { S, setActiveStrings } from "../src/lib/strings";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";

import { QuorumConsensusEngine } from "@prismshadow/penguin-core/browser";
import { QuorumBoard } from "../src/features/consensus/quorum-board";
import { MailboxBureau } from "../src/features/consensus/mailbox-bureau";
import { HandoffTimeline } from "../src/features/consensus/handoff-timeline";

describe.each(["en", "zh"] as const)("Coordination panels %s", (locale) => {
  const chinese = locale === "zh";
  const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => {
    setActiveStrings(chinese ? zh : en);
    return renderToStaticMarkup(element);
  };

  it("renders empty decisions and populated decision statuses", () => {
    expect(render(createElement(QuorumBoard))).toContain(chinese ? "提出决策" : "Propose decision");
    expect(render(createElement(QuorumBoard))).toContain(
      chinese
        ? "此视图中没有决策。提出决策以收集同行反馈。"
        : "No decisions in this view. Propose a decision to collect peer feedback.",
    );
    const engine = new QuorumConsensusEngine();
    engine.proposeTopic({
      topic: "sample-topic",
      proposerId: "agent-a",
      policy: { threshold: 2, requireGrounded: true, refutationCap: 1 },
    });
    const html = render(createElement(QuorumBoard, { engine } as never));
    for (const text of chinese
      ? ["讨论中", "提案者：", "同行赞同：", "证据与异议", "附证据赞同", "反驳"]
      : [
          "debating",
          "Proposer:",
          "Peer endorsements:",
          "Evidence and objections",
          "Endorse with evidence",
          "Refute",
        ])
      expect(html).toContain(text);
    expect(html).toContain("sample-topic");
  });

  it("renders empty live and demo mailboxes", () => {
    expect(render(createElement(MailboxBureau, { entries: [] }))).toContain(
      chinese ? "消息（实时）" : "Messages (live)",
    );
    const html = render(createElement(MailboxBureau));
    for (const text of chinese
      ? ["消息（本地演示）", "编写演示消息", "最近消息", "高", "普通"]
      : ["Messages (local demo)", "Compose demo message", "Recent messages", "high", "normal"])
      expect(html).toContain(text);
  });

  it("renders live mailbox states and countdowns", () => {
    const html = render(
      createElement(MailboxBureau, {
        entries: [
          {
            agentName: "a",
            queueDepth: 2,
            pendingReplies: 1,
            leaseState: "acquired",
            leaseRemainingSec: 12,
          },
          { agentName: "b", queueDepth: 0, pendingReplies: 0, leaseState: "expired" },
          { agentName: "c", queueDepth: 0, pendingReplies: 0, leaseState: "idle" },
          { agentName: "d", queueDepth: 0, pendingReplies: 0, leaseState: "acquired" },
        ],
      }),
    );
    for (const text of chinese
      ? ["持有租约", "已过期", "空闲", "队列深度：", "待回复：", "剩余 12 秒", "未知"]
      : [
          "LEASE HELD",
          "EXPIRED",
          "IDLE",
          "Queue Depth:",
          "Pending replies:",
          "12s remaining",
          "Unknown",
        ])
      expect(html).toContain(text);
  });

  it("renders empty, populated live and demo handoffs", () => {
    expect(render(createElement(HandoffTimeline, { handoffs: [] }))).toContain(
      chinese
        ? "此连接中尚未观察到任务启动或指令。"
        : "No task starts or directives observed in this connection.",
    );
    const live = render(
      createElement(HandoffTimeline, {
        handoffs: [
          {
            messageId: "m1",
            source: "task_started",
            taskId: "task-1",
            from: "a",
            to: "b",
            timestamp: 1,
          },
          { messageId: "m2", from: "b", to: "c", timestamp: 2 },
        ],
      }),
    );
    for (const text of chinese
      ? [
          "交接（实时）",
          "任务已启动",
          "已派发",
          "任务：",
          "计划目标；此事件不报告任务分配是否送达。",
        ]
      : [
          "Handoffs (live)",
          "Task started",
          "Dispatched",
          "Task:",
          "Planned target; assignment delivery is not reported by this event.",
        ])
      expect(live).toContain(text);
    const demo = render(createElement(HandoffTimeline));
    for (const text of chinese
      ? ["交接（本地演示）", "模拟下一阶段", "已完成", "进行中", "待处理"]
      : ["Handoffs (local demo)", "Simulate Next Stage", "completed", "in_progress", "pending"])
      expect(demo).toContain(text);
  });
});

const originalStrings = S;
afterEach(() => setActiveStrings(originalStrings));

const locales = [
  {
    locale: "en",
    dictionary: en,
    title: "Agent coordination",
    navigation: "Coordination views",
    tabs: ["Decisions", "Messages", "Handoffs"],
    demo: "Try proposals, messages and handoffs with local sample data. Changes are not sent to agents or saved after leaving this page.",
    live: "Live feeds reflect the current project where connected. Decisions remain a local demo.",
  },
  {
    locale: "zh",
    dictionary: zh,
    title: "智能体协作",
    navigation: "协作视图",
    tabs: ["决策", "消息", "交接"],
    demo: "使用本地示例数据体验提案、消息和交接。更改不会发送给 Agent，离开此页面后也不会保存。",
    live: "已连接的实时数据反映当前项目的情况。决策仍为本地演示。",
  },
];

const modes: { name: string; props: ConsensusPageProps; live: boolean }[] = [
  { name: "local demo", props: {}, live: false },
  { name: "mailbox only", props: { mailboxEntries: [] }, live: true },
  { name: "handoffs only", props: { handoffs: [] }, live: true },
  {
    name: "both feeds embedded",
    props: { embedded: true, mailboxEntries: [], handoffs: [] },
    live: true,
  },
];

describe.each(locales)("ConsensusPage $locale rendered copy", (locale) => {
  it.each(modes)("renders the shell for $name", (mode) => {
    setActiveStrings(locale.dictionary);
    const html = renderToStaticMarkup(createElement(ConsensusPage, mode.props));
    const header = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
    expect(header).toMatch(new RegExp(`<h1[^>]*>${locale.title}</h1>`));
    expect(header).toContain(mode.live ? locale.live : locale.demo);
    expect(header).not.toContain(mode.live ? locale.demo : locale.live);
    const navigation = html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0];
    expect(navigation).toContain(`aria-label="${locale.navigation}"`);
    expect(navigation?.match(/<button\b/g)).toHaveLength(3);
    locale.tabs.forEach((label, index) => {
      expect(navigation).toMatch(
        new RegExp(`<button[^>]*aria-pressed="${index === 0}"[^>]*>${label}</button>`),
      );
    });
  });
});
