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

/**
 * Shared sub-patterns for the destructive-delete rules.
 *
 * These are extracted because three rules reason about the same shell grammar.
 * The shape matters more than the letters: a *flag word* is anything the shell
 * would hand to a tool as an option, and the recursion/force content is matched
 * separately so that `-rf`, `-r -f`, `--recursive --force` and every ordering of
 * the two all reach the same conclusion.
 */
const FLAG_WORD = String.raw`--?[A-Za-z][A-Za-z0-9-]*`;
const RM_RECURSE_FLAG = String.raw`(?:-[A-Za-z]*r[A-Za-z]*|--recursive)`;
const RM_FORCE_FLAG = String.raw`(?:-[A-Za-z]*f[A-Za-z]*|--force)`;

/**
 * Recursive *and* forced deletion, in one token (`-rf`, `-fr`, `-Rf`), split
 * across tokens (`-r -f`), as long options (`--recursive --force`), or any
 * mixture of the two orderings, with unrelated options tolerated in between.
 */
const RM_RF_FLAGS = String.raw`(?:-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|${RM_RECURSE_FLAG}(?:[ \t]+${FLAG_WORD})*[ \t]+${RM_FORCE_FLAG}|${RM_FORCE_FLAG}(?:[ \t]+${FLAG_WORD})*[ \t]+${RM_RECURSE_FLAG})`;

/**
 * A target word that means "everything reachable from here", not a scoped path.
 * Dots and slashes only: `.`, `./`, `..`, `../..`, `~` and the filesystem root
 * qualify; `./dist`, `../build` and `packages/core/dist` do not. The boundary
 * test in the rules is what separates them — `.` followed by `dist` is a
 * directory name, `.` followed by nothing is the whole tree.
 */
const ROOT_TARGET = String.raw`['"]?(?:[/~]|\.(?:[/.]*\.)*|\.\*|\*)(?:\*+|/+|/\*+)?['"]?`;

/** End of the command, or a shell token that cannot continue a path. */
const TARGET_BOUNDARY = String.raw`(?=$|[\s;&|#<>])`;

const CRITICAL_RULES: SafetyRule[] = [
  {
    id: "destructive-root-delete",
    severity: "critical",
    // Options may precede or follow the recursive/force pair (`--no-preserve-root`
    // is itself an option), and the target may be quoted — the shell strips the
    // quotes, so the pattern must see through them.
    pattern: new RegExp(
      String.raw`\brm\b(?:[ \t]+${FLAG_WORD})*[ \t]+${RM_RF_FLAGS}(?:[ \t]+${FLAG_WORD})*(?:[ \t]+--)?[ \t]+${ROOT_TARGET}${TARGET_BOUNDARY}`,
      "i",
    ),
    description: "Recursive forced deletion of root or wildcards (/ or ~ or . or ..)",
    requiresApproval: true,
  },
  {
    id: "destructive-win-root-delete",
    severity: "critical",
    // `rmdir /s /q` is orderless and may be run together; the drive root may be quoted.
    pattern: /\b(?:rmdir|rd)\b[ \t]+(?:\/[sq][ \t]*){2,}["']?[a-zA-Z]:\\/i,
    description: "Recursive quiet deletion of Windows system drive root",
    requiresApproval: true,
  },
  {
    id: "destructive-pwsh-root-delete",
    severity: "critical",
    // PowerShell parameters are named and orderless, and the path may precede or
    // follow them. Two lookaheads assert both parameters are present anywhere in
    // the command; the match then locates a bare drive or POSIX root. The
    // `(?<![A-Za-z0-9-])` preceding edge is what keeps a bash `--force` long
    // option from satisfying PowerShell's `-Force` parameter.
    pattern: new RegExp(
      String.raw`\b(?:Remove-Item|rm|del)\b(?=[^|;&\n]*(?<![A-Za-z0-9-])-Recurse\b)(?=[^|;&\n]*(?<![A-Za-z0-9-])-Force\b)[^|;&\n]*?['"]?(?:[a-zA-Z]:\\|\/)['"]?${TARGET_BOUNDARY}`,
      "i",
    ),
    description: "PowerShell recursive forced deletion of drive root",
    requiresApproval: true,
  },
  {
    id: "disk-raw-write",
    severity: "critical",
    // The device-name list covers the spellings a cloud or desktop host actually
    // exposes — SCSI/SATA, virtio, Xen, NVMe, macOS raw disks and eMMC — and the
    // output file may be quoted. `of=` may sit anywhere in the argument list.
    pattern:
      /\bdd\b[^|;&\n]*?\bof\s*=\s*['"]?\/dev\/(?:sd[a-z]|vd[a-z]|xvd[a-z]|hd[a-z]|rdisk\d|nvme\d|mmcblk\d|disk\d)/i,
    description: "Raw block device overwriting via dd",
    requiresApproval: true,
  },
  {
    id: "fork-bomb",
    severity: "critical",
    // The classic is spelled with `:`, but the bomb is the *shape* — a function
    // that pipes two copies of itself into the background and then runs. The
    // backreference ties the three occurrences to one name, so `foo(){ ls|ls& };foo`
    // does not match while `:(){ :|:& };:` and any named variant do.
    pattern:
      /([:A-Za-z_][:A-Za-z0-9_]*)\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1(?![A-Za-z0-9_])/i,
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
    // ncat's `-c`/`--sh-exec` are the same feature as `-e`; the interpreter may
    // be named bare (`sh`) or given a path. Only interpreters are listed, so
    // `ncat -e cat` stays uncaught.
    pattern:
      /\b(?:nc|ncat|netcat)\b[^|;&\n]*?(?:-[ecC]|--sh-exec|--exec)\s+['"]?(?:[^\s]*\/)?(?:bash|sh|zsh|dash|ksh|busybox|cmd\.exe|powershell)\b/i,
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
