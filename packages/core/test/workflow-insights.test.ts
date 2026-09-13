import { describe, it, expect } from "vitest";
import {
  isBehavioralCall,
  behavioralCallCount,
  isBehavioralTurn,
  behavioralTurnCount,
  scanUserCorrections,
  sessionTimeToFirstEditMs,
  medianTimeToFirstEditMs,
  aggregateFileChurn,
  type WorkflowSession,
} from "../src/hud/workflow-insights.js";

describe("workflow-insights", () => {
  it("weighs calls and turns correctly excluding supplementary accounting", () => {
    const call1 = { supplementaryAccounting: false };
    const call2 = { supplementaryAccounting: true };
    const call3 = {};

    expect(isBehavioralCall(call1)).toBe(true);
    expect(isBehavioralCall(call2)).toBe(false);
    expect(isBehavioralCall(call3)).toBe(true);

    expect(behavioralCallCount([call1, call2, call3])).toBe(2);

    const turn1 = { assistantCalls: [call2] }; // supplementary only
    const turn2 = { assistantCalls: [call1, call2] };

    expect(isBehavioralTurn(turn1)).toBe(false);
    expect(isBehavioralTurn(turn2)).toBe(true);
    expect(behavioralTurnCount([turn1, turn2])).toBe(1);
  });

  it("scans user corrections accurately across session turns", () => {
    const sessions: WorkflowSession[] = [
      {
        sessionId: "s1",
        turns: [
          { userMessage: "revert the last change from earlier", assistantCalls: [] }, // Opener: should NOT count as correction
          { userMessage: "that's wrong, you missed the export", assistantCalls: [] }, // Follow-up: counts!
          { userMessage: "thanks, looks great", assistantCalls: [] },
        ],
      },
      {
        sessionId: "s2",
        turns: [
          { userMessage: "build me a parser", assistantCalls: [] },
          { userMessage: "still broken on line 10", assistantCalls: [] }, // Follow-up: counts!
        ],
      },
    ];

    const stats = scanUserCorrections(sessions);
    expect(stats.corrections).toBe(2);
    expect(stats.userTurns).toBe(5);
    expect(stats.correctionRate).toBe(0.4);
  });

  it("measures session time-to-first-edit and median", () => {
    const session1: WorkflowSession = {
      sessionId: "s1",
      turns: [
        { timestamp: "2026-09-11T10:00:00Z", assistantCalls: [] },
        {
          assistantCalls: [
            { timestamp: "2026-09-11T10:01:00Z", tools: ["read"] },
            { timestamp: "2026-09-11T10:02:00Z", tools: ["write_to_file"] },
          ],
        },
      ],
    };

    const session2: WorkflowSession = {
      sessionId: "s2",
      turns: [
        { timestamp: "2026-09-11T11:00:00Z", assistantCalls: [] },
        {
          assistantCalls: [{ timestamp: "2026-09-11T11:04:00Z", tools: ["replace_file_content"] }],
        },
      ],
    };

    const ms1 = sessionTimeToFirstEditMs(session1);
    expect(ms1).toBe(120000); // 2 minutes

    const ms2 = sessionTimeToFirstEditMs(session2);
    expect(ms2).toBe(240000); // 4 minutes

    const median = medianTimeToFirstEditMs([session1, session2]);
    expect(median).toBe(180000); // 3 minutes
  });

  it("aggregates file churn by sessions and edit occurrences", () => {
    const sessions: WorkflowSession[] = [
      {
        sessionId: "s1",
        projectPath: "C:/app",
        turns: [
          {
            assistantCalls: [
              {
                toolSequence: [
                  [{ name: "write_to_file", args: { TargetFile: "C:/app/src/index.ts" } }],
                  [{ name: "replace_file_content", args: { TargetFile: "C:/app/src/index.ts" } }],
                  [{ name: "replace_file_content", args: { TargetFile: "C:/app/src/utils.ts" } }],
                ],
              },
            ],
          },
        ],
      },
      {
        sessionId: "s2",
        projectPath: "C:/app",
        turns: [
          {
            assistantCalls: [
              {
                toolSequence: [
                  [{ name: "replace_file_content", args: { TargetFile: "C:/app/src/index.ts" } }],
                ],
              },
            ],
          },
        ],
      },
    ];

    const churn = aggregateFileChurn(sessions, { projectPath: "C:/app" });
    expect(churn.length).toBe(2);
    expect(churn[0]!.path).toBe("src/index.ts");
    expect(churn[0]!.sessions).toBe(2);
    expect(churn[0]!.edits).toBe(3);

    expect(churn[1]!.path).toBe("src/utils.ts");
    expect(churn[1]!.sessions).toBe(1);
    expect(churn[1]!.edits).toBe(1);
  });
});
