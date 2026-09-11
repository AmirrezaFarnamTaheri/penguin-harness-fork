/**
 * Steering Reminder Engine.
 * Absorbed from cherry-studio steerReminder.ts.
 *
 * Injects periodic concise steering reminders into long-running agent execution
 * to prevent drift, maintain focus on the user's primary goal, and enforce critical project rules.
 */

export interface SteeringConfig {
  intervalTurns?: number;
  reminderPrompt?: string;
  enabled?: boolean;
}

export const DEFAULT_STEERING_INTERVAL = 6;
export const DEFAULT_STEERING_REMINDER =
  "[SYSTEM REMINDER]: Keep focused on the user's primary objective. Adhere strictly to the requested scope, verify all changes against typecheck/lint standards, avoid placeholders, and ensure no side-effects.";

export class SteeringReminderEngine {
  private turnCount = 0;
  private readonly intervalTurns: number;
  private readonly reminderPrompt: string;
  private readonly enabled: boolean;

  constructor(config: SteeringConfig = {}) {
    this.intervalTurns = config.intervalTurns ?? DEFAULT_STEERING_INTERVAL;
    this.reminderPrompt = config.reminderPrompt ?? DEFAULT_STEERING_REMINDER;
    this.enabled = config.enabled ?? true;
  }

  recordTurn(): void {
    this.turnCount++;
  }

  isReminderDue(): boolean {
    if (!this.enabled) return false;
    return this.turnCount > 0 && this.turnCount % this.intervalTurns === 0;
  }

  getReminder(): string | null {
    if (this.isReminderDue()) {
      return this.reminderPrompt;
    }
    return null;
  }

  reset(): void {
    this.turnCount = 0;
  }
}
