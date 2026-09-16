/**
 * Shell Guardian and Execution Barrier.
 * Ported and synthesized from DeepSeek-Reasonix shellsafe, permission contracts, and cline security guards.
 */

export type ShellRiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export interface ShellFinding {
  ruleId: string;
  severity: ShellRiskLevel;
  description: string;
  matchedText: string;
}

export interface ShellSafetyAssessment {
  command: string;
  riskLevel: ShellRiskLevel;
  isSafe: boolean;
  requiresApproval: boolean;
  findings: ShellFinding[];
  suggestedAction?: "allow" | "prompt_user" | "block";
}

export interface SafetyRule {
  id: string;
  severity: ShellRiskLevel;
  pattern: RegExp;
  description: string;
  requiresApproval: boolean;
}

const CRITICAL_RULES: SafetyRule[] = [
  {
    id: "destructive-root-delete",
    severity: "critical",
    pattern:
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+([/~]|\/\*|\*)/i,
    description: "Recursive forced deletion of root or wildcards (/ or ~ or *)",
    requiresApproval: true,
  },
  {
    id: "destructive-win-root-delete",
    severity: "critical",
    pattern: /\b(rmdir|rd)\s+\/[sq]\s+\/[sq]\s+[a-zA-Z]:\\/i,
    description: "Recursive quiet deletion of Windows system drive root",
    requiresApproval: true,
  },
  {
    id: "destructive-pwsh-root-delete",
    severity: "critical",
    pattern: /\b(Remove-Item|rm|del)\s+.*-Recurse.*-Force\s+['"]?([a-zA-Z]:\\|\/)/i,
    description: "PowerShell recursive forced deletion of drive root",
    requiresApproval: true,
  },
  {
    id: "disk-raw-write",
    severity: "critical",
    pattern: /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme[0-9]|hd[a-z]|disk[0-9])/i,
    description: "Raw block device overwriting via dd",
    requiresApproval: true,
  },
  {
    id: "fork-bomb",
    severity: "critical",
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    description: "Bash fork-bomb pattern detected",
    requiresApproval: true,
  },
  {
    id: "reverse-shell-tcp",
    severity: "critical",
    pattern: /\/dev\/tcp\/[0-9a-zA-Z._-]+\/[0-9]+/i,
    description: "Direct bash TCP socket reverse shell",
    requiresApproval: true,
  },
  {
    id: "netcat-exec-shell",
    severity: "critical",
    pattern: /\b(nc|ncat|netcat)\s+.*-[eec]\s+(\/bin\/[a-z]*sh|cmd\.exe|powershell)/i,
    description: "Netcat spawned command shell",
    requiresApproval: true,
  },
];

const HIGH_RULES: SafetyRule[] = [
  {
    id: "pipe-remote-to-shell",
    severity: "high",
    pattern: /\b(curl|wget|fetch)\s+.*\|\s*(bash|sh|zsh|python|perl)/i,
    description: "Piping remote web download directly into shell interpreter",
    requiresApproval: true,
  },
  {
    id: "pwsh-download-iex",
    severity: "high",
    pattern:
      /\b(Invoke-Expression|iex)\s+.*(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|DownloadString)/i,
    description: "PowerShell remote script download executed via Invoke-Expression",
    requiresApproval: true,
  },
  {
    id: "credential-file-access",
    severity: "high",
    pattern:
      /\b(cat|type|Get-Content|gc)\s+.*(\.aws\/credentials|\.ssh\/id_|\.kube\/config|\.env\.production)/i,
    description: "Accessing sensitive credential or SSH private key files",
    requiresApproval: true,
  },
  {
    id: "env-secret-exfiltration",
    severity: "high",
    pattern: /\b(env|printenv|Get-ChildItem\s+env:)\s*\|\s*(curl|wget|nc|Invoke-RestMethod)/i,
    description: "Piping environment variables to network egress utilities",
    requiresApproval: true,
  },
  {
    id: "privilege-escalation-sudo",
    severity: "high",
    pattern: /\b(sudo|doas|su\s+-)\b/,
    description: "Superuser privilege escalation",
    requiresApproval: true,
  },
  {
    id: "pwsh-unrestricted-exec",
    severity: "high",
    pattern: /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i,
    description: "Disabling PowerShell script execution policy",
    requiresApproval: true,
  },
];

const MEDIUM_RULES: SafetyRule[] = [
  {
    id: "git-hard-reset",
    severity: "medium",
    pattern: /\bgit\s+reset\s+--hard\b/i,
    description: "Uncommitted changes may be permanently lost via git reset --hard",
    requiresApproval: false,
  },
  {
    id: "git-force-push",
    severity: "medium",
    pattern: /\bgit\s+push\s+.*(-f|--force)\b/i,
    description: "Remote commit history overwrite via git force push",
    requiresApproval: true,
  },
  {
    id: "kill-all-processes",
    severity: "medium",
    pattern: /\b(killall|pkill|taskkill\s+\/f)\s+.*(node|python|chrome|code|pnpm)/i,
    description: "Mass process termination targeting core runtimes",
    requiresApproval: false,
  },
];

export class ShellGuardian {
  private customRules: SafetyRule[] = [];

  constructor(additionalRules: SafetyRule[] = []) {
    this.customRules = [...additionalRules];
  }

  public setCustomRules(rules: SafetyRule[]): void {
    this.customRules = [...rules];
  }

  public getCustomRules(): readonly SafetyRule[] {
    return this.customRules;
  }

  /**
   * Evaluates a command string against safety rules and returns a structured risk assessment.
   */
  public analyzeCommand(rawCommand: string): ShellSafetyAssessment {
    const command = rawCommand.trim();
    const findings: ShellFinding[] = [];

    const allRules = [...CRITICAL_RULES, ...HIGH_RULES, ...MEDIUM_RULES, ...this.customRules];

    for (const rule of allRules) {
      const match = rule.pattern.exec(command);
      if (match) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          description: rule.description,
          matchedText: match[0],
        });
      }
    }

    let overallRisk: ShellRiskLevel = "safe";
    if (findings.some((f) => f.severity === "critical")) {
      overallRisk = "critical";
    } else if (findings.some((f) => f.severity === "high")) {
      overallRisk = "high";
    } else if (findings.some((f) => f.severity === "medium")) {
      overallRisk = "medium";
    } else if (findings.some((f) => f.severity === "low")) {
      overallRisk = "low";
    }

    const requiresApproval =
      overallRisk === "critical" ||
      overallRisk === "high" ||
      findings.some((f) => {
        const foundRule = allRules.find((r) => r.id === f.ruleId);
        return foundRule?.requiresApproval === true;
      });

    let suggestedAction: "allow" | "prompt_user" | "block" = "allow";
    if (overallRisk === "critical") {
      suggestedAction = "block";
    } else if (requiresApproval) {
      suggestedAction = "prompt_user";
    }

    return {
      command,
      riskLevel: overallRisk,
      isSafe: overallRisk === "safe" || overallRisk === "low",
      requiresApproval,
      findings,
      suggestedAction,
    };
  }

  /**
   * Helper to quickly check if a command can proceed without user intervention.
   */
  public canExecuteUnattended(command: string): boolean {
    const assessment = this.analyzeCommand(command);
    return !assessment.requiresApproval && assessment.riskLevel !== "critical";
  }
}
