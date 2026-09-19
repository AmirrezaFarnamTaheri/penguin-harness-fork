/**
 * Syscall filter — the virtualization policy a hardware-isolated sandbox enforces.
 *
 * Ports the syscall dispatch table and the path prefix router from the donors'
 * userspace syscall virtualizer. That implementation is a Linux seccomp
 * `USER_NOTIF` supervisor: a one-instruction BPF program (`RET_USER_NOTIF`)
 * intercepts *every* syscall after `PR_SET_NO_NEW_PRIVS` is set, a `notify` fd
 * hands each one to this table, and the reply is one of four dispositions.
 *
 * What is ported is the *policy*, which is the part that is a security decision:
 * the table of syscalls and their dispositions, the path router that decides which
 * filesystem backend a path belongs to, and the component-boundary prefix matching
 * that keeps `/tmpfoo` from being treated as a child of `/tmp`. What is not ported
 * is the kernel plumbing — BPF instruction layout, the notify fd, the pidfd memory
 * bridge that reads the guest's path string, the 44 handlers' Linux errno
 * arithmetic. None of that runs outside Linux with CAP_SYS_PTRACE, and porting it
 * verbatim would have carried a build dependency this harness does not have.
 *
 * The dispositions themselves are the valuable invariant, and they are unchanged:
 * network is outbound-only (bind/listen/accept are denied), every escape and
 * privilege-raising syscall is denied, resource ceilings cannot be raised from
 * inside, and anything unimplemented fails closed as ENOSYS rather than being
 * passed through on the assumption it is harmless.
 */

/**
 * What the filter does with a syscall.
 *
 * The two deny values are distinct on purpose and the distinction is a security
 * one: `deny_eperm` is used for things the guest could legitimately try and must
 * simply be told "no" (binding a port), while `deny_enosys` is used for things
 * whose mere availability changes what an exploit can reach (loading a module,
 * raising a limit, installing a filter of its own). ENOSYS says "this kernel does
 * not have this syscall", which is what an exploit checking capability wants to
 * hear, and is also what a legitimate program's fallback path expects.
 */
export type SyscallDisposition =
  "virtualize" | "passthrough" | "deny_eperm" | "deny_enosys" | "unsupported";

/** Which filesystem backend owns a path. */
export type FsBackend = "cow" | "tmp" | "proc" | "passthrough";

/** The outcome of routing a path. */
export type RouteResult =
  | { readonly kind: "block" }
  | { readonly kind: "handle"; readonly backend: FsBackend; readonly normalized: string };

/**
 * Syscalls the sandbox virtualizes: the guest sees a controlled, per-sandbox answer
 * rather than the host's. These are the 44 the donor implemented handlers for. The
 * ones that matter for containment are the filesystem set — every one is routed
 * through the path router before it touches a backend — and the process set, which
 * is what makes a sandbox's PID namespace convincing.
 */
const VIRTUALIZED_SYSCALLS: ReadonlySet<string> = new Set([
  "openat",
  "close",
  "read",
  "write",
  "readv",
  "writev",
  "dup",
  "dup3",
  "fstat",
  "fstatat64",
  "newfstatat",
  "stat",
  "lstat",
  "uname",
  "sysinfo",
  "lseek",
  "getcwd",
  "chdir",
  "fchdir",
  "faccessat",
  "faccessat2",
  "pipe2",
  "fcntl",
  "socket",
  "socketpair",
  "connect",
  "shutdown",
  "ioctl",
  "recvfrom",
  "sendto",
  "sendmsg",
  "recvmsg",
  "getdents64",
  "mkdirat",
  "unlinkat",
  "symlinkat",
  "readlinkat",
  "eventfd2",
  "utimensat",
  "fchmodat",
  "getpid",
  "getppid",
  "gettid",
  "kill",
  "tkill",
  "exit",
  "exit_group",
  "execve",
]);

/**
 * Syscalls passed through to the kernel unchanged. Every entry here is a deliberate
 * decision that the syscall carries no cross-tenant information and cannot be used
 * to escape: user identity (read-only), process-local memory management, signals,
 * time (read-only), futexes, and randomness. `clone`, `wait4` and `waitid` are here
 * because the supervisor lazily discovers child processes rather than virtualizing
 * their creation.
 */
const PASSTHROUGH_SYSCALLS: ReadonlySet<string> = new Set([
  "clone",
  "clone3",
  "wait4",
  "waitid",
  "getuid",
  "geteuid",
  "getgid",
  "getegid",
  "brk",
  "mmap",
  "mprotect",
  "munmap",
  "mremap",
  "madvise",
  "rt_sigaction",
  "rt_sigprocmask",
  "rt_sigreturn",
  "rt_sigsuspend",
  "rt_sigpending",
  "rt_sigtimedwait",
  "sigaltstack",
  "restart_syscall",
  "clock_gettime",
  "clock_getres",
  "gettimeofday",
  "nanosleep",
  "clock_nanosleep",
  "futex",
  "futex_wait",
  "futex_wake",
  "futex_requeue",
  "futex_waitv",
  "getrandom",
  "set_robust_list",
  "set_tid_address",
  "rseq",
]);

/**
 * Denied with EPERM: the network-server syscalls. The sandbox permits outbound
 * connections (subject to the egress allow-list) and forbids listening, because a
 * listening socket is how a sandboxed process becomes a service reachable by every
 * other tenant on the host.
 */
const DENY_EPERM_SYSCALLS: ReadonlySet<string> = new Set(["bind", "listen", "accept", "accept4"]);

/**
 * Denied with ENOSYS: escape, privilege, and resource-control syscalls. This is the
 * list the plan names explicitly — `ptrace`, `bpf`, `reboot`, `mount` — plus the
 * rest of the donor's table. `setrlimit` and `prlimit64` are here because a guest
 * that can raise its own limits defeats every memory and process ceiling the
 * sandbox was configured with; `personality` is here because it is an
 * execution-domain exploit primitive; `seccomp` is here because a guest that can
 * install its own filter can install a permissive one.
 */
const DENY_ENOSYS_SYSCALLS: ReadonlySet<string> = new Set([
  "ptrace",
  "mount",
  "umount2",
  "chroot",
  "pivot_root",
  "reboot",
  "setns",
  "unshare",
  "seccomp",
  "bpf",
  "process_vm_readv",
  "process_vm_writev",
  "kexec_load",
  "kexec_file_load",
  "init_module",
  "finit_module",
  "delete_module",
  "setrlimit",
  "prlimit64",
  "personality",
]);

/**
 * Known but unsupported: present in the table so the deny/allow accounting is
 * honest. `getrlimit` and `getrusage` leak resource configuration and usage in a
 * multitenant setting, so they are not passed through and not virtualized —
 * they fail closed.
 */
const UNSUPPORTED_SYSCALLS: ReadonlySet<string> = new Set(["getrlimit", "getrusage"]);

/** Full deny set, for the audit log and for policy presets that want it as data. */
export const DENIED_SYSCALLS: readonly string[] = [
  ...DENY_EPERM_SYSCALLS,
  ...DENY_ENOSYS_SYSCALLS,
  ...UNSUPPORTED_SYSCALLS,
].sort();

/**
 * The verdict the filter returns for a syscall, in the shape the donor's supervisor
 * replied with: a return value for allowed and virtualized calls, or an errno for
 * denied ones.
 */
export interface SyscallVerdict {
  readonly disposition: SyscallDisposition;
  /** Errno name for a denial; undefined otherwise. */
  readonly errno?: string;
  /** The syscall the verdict was reached for. */
  readonly syscall: string;
  /** The routed path, when the syscall carried one. */
  readonly path?: string;
  /** The backend the routed path was assigned to. */
  readonly backend?: FsBackend;
  /** Why this verdict was reached, for the audit log. */
  readonly reason: string;
}

/**
 * Decide a syscall's disposition. An unknown syscall is `unsupported` — never
 * passthrough — because "we have not thought about this one" and "this one is safe"
 * are different claims, and only the second earns passthrough.
 *
 * Note the absence of any `syscall` whitelist-derived decision from *arguments*: a
 * filter that inspects pointer arguments needs to read guest memory, which is
 * exactly the pidfd memory bridge that was not portable. Argument-level policy
 * lives in the path router below, which is consulted by the filesystem handler.
 */
export function classifySyscall(syscall: string): SyscallVerdict {
  const name = syscall;
  if (VIRTUALIZED_SYSCALLS.has(name)) {
    return { disposition: "virtualize", syscall: name, reason: "implemented handler" };
  }
  if (PASSTHROUGH_SYSCALLS.has(name)) {
    return { disposition: "passthrough", syscall: name, reason: "process-local or read-only" };
  }
  if (DENY_EPERM_SYSCALLS.has(name)) {
    return {
      disposition: "deny_eperm",
      syscall: name,
      errno: "EPERM",
      reason: "network is outbound-only; listening is forbidden",
    };
  }
  if (DENY_ENOSYS_SYSCALLS.has(name)) {
    return {
      disposition: "deny_enosys",
      syscall: name,
      errno: "ENOSYS",
      reason: "escape, privilege, or resource-control primitive",
    };
  }
  if (UNSUPPORTED_SYSCALLS.has(name)) {
    return {
      disposition: "unsupported",
      syscall: name,
      errno: "ENOSYS",
      reason: "not implemented; fails closed to avoid information disclosure",
    };
  }
  return {
    disposition: "unsupported",
    syscall: name,
    errno: "ENOSYS",
    reason: "unknown syscall; unimplemented syscalls fail closed",
  };
}

/**
 * Decide a syscall's disposition for a *path-carrying* syscall, which additionally
 * routes through the path table. A path that routes to `block` turns an otherwise
 * virtualized syscall into a denial — the donor's handlers all did this switch
 * before touching a backend.
 */
export function classifyPathSyscall(syscall: string, cwd: string, path: string): SyscallVerdict {
  const base = classifySyscall(syscall);
  if (base.disposition !== "virtualize") return base;
  const route = resolveAndRoute(cwd, path);
  if (route.kind === "block") {
    return {
      disposition: "deny_eperm",
      syscall,
      errno: "EPERM",
      path,
      reason: `path is outside the sandbox's permitted prefixes`,
    };
  }
  return {
    ...base,
    path: route.normalized,
    backend: route.backend,
    reason: `${base.reason}; routed to ${route.backend} backend`,
  };
}

/**
 * The routing table. A *prefix tree as a flat rule list*: each rule is a prefix and
 * either a terminal result or a branch with subrules and its own default. Matching
 * is longest-prefix-wins by rule order, which is what makes `/dev/null` passthrough
 * while `/dev/sda` is blocked even though both match the `/dev` branch.
 *
 * The default for a path that matches nothing is the `cow` backend — copy-on-write —
 * which is the containment property: an unclassified path gets the *most*
 * isolating backend, not the most permissive one.
 */
export interface RoutingRule {
  readonly prefix: string;
  readonly node:
    | { readonly kind: "terminal"; readonly result: RouteTerminal }
    | {
        readonly kind: "branch";
        readonly subrules: readonly RoutingRule[];
        readonly default: RouteTerminal;
      };
}

export type RouteTerminal =
  { readonly kind: "block" } | { readonly kind: "handle"; readonly backend: FsBackend };

const DEFAULT_ROUTE: RouteTerminal = { kind: "handle", backend: "cow" };

/** Name of the sandbox-private state directory under /tmp. */
export const PRIVATE_STATE_DIR_NAME = ".sandbox";

/** Maximum path length the router will normalize, mirroring the donor's 512-byte buffer. */
export const MAX_ROUTE_PATH_LENGTH = 512;

/**
 * The factory routing table. Hard-blocked prefixes are host control surfaces
 * (`/sys`, `/run`) and the sandbox's own private state directory; `/dev` is blocked
 * except for the four harmless devices; `/proc` is virtualized so the guest sees
 * the sandbox's process list, not the host's; `/tmp` is per-sandbox ephemeral.
 *
 * The private-state prefix is named for this harness, not for the donor, and is
 * configurable below precisely because a deployment may need a different one — but
 * the *rule* (the guest must not reach the sandbox's own state) is not optional.
 */
const DEFAULT_ROUTING_RULES: readonly RoutingRule[] = [
  { prefix: "/sys", node: { kind: "terminal", result: { kind: "block" } } },
  { prefix: "/run", node: { kind: "terminal", result: { kind: "block" } } },
  { prefix: "/proc", node: { kind: "terminal", result: { kind: "handle", backend: "proc" } } },
  {
    prefix: "/dev",
    node: {
      kind: "branch",
      default: { kind: "block" },
      subrules: [
        {
          prefix: "null",
          node: { kind: "terminal", result: { kind: "handle", backend: "passthrough" } },
        },
        {
          prefix: "zero",
          node: { kind: "terminal", result: { kind: "handle", backend: "passthrough" } },
        },
        {
          prefix: "random",
          node: { kind: "terminal", result: { kind: "handle", backend: "passthrough" } },
        },
        {
          prefix: "urandom",
          node: { kind: "terminal", result: { kind: "handle", backend: "passthrough" } },
        },
      ],
    },
  },
  {
    prefix: "/tmp",
    node: {
      kind: "branch",
      default: { kind: "handle", backend: "tmp" },
      subrules: [
        { prefix: PRIVATE_STATE_DIR_NAME, node: { kind: "terminal", result: { kind: "block" } } },
      ],
    },
  },
];

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/**
 * Match a path against a prefix as a *directory* prefix: an exact match or a match
 * at a component boundary. `/tmpfoo` does not match `/tmp`, and `/devnull` does not
 * match `/dev` — the single most common way a naive prefix check gets this wrong,
 * and the thing the donor's test suite enumerated explicitly.
 *
 * Returns the remainder after the prefix (with the separating `/` consumed), which
 * a branch needs in order to match its subrules against the *rest* of the path.
 */
export function matchesPrefix(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  if (path.length === prefix.length) return "";
  if (path[prefix.length] === "/") return path.slice(prefix.length + 1);
  return null;
}

function routeByPrefix(
  path: string,
  rules: readonly RoutingRule[],
  fallback: RouteTerminal,
): RouteTerminal {
  for (const rule of rules) {
    const remainder = matchesPrefix(path, rule.prefix);
    if (remainder === null) continue;
    if (rule.node.kind === "terminal") return rule.node.result;
    return routeByPrefix(remainder, rule.node.subrules, rule.node.default);
  }
  return fallback;
}

/**
 * Normalize a path (resolving `..`, which is what makes a traversal attempt
 * harmless — it is resolved *before* any rule sees it) and route it.
 */
export function routePath(
  path: string,
  rules: readonly RoutingRule[] = DEFAULT_ROUTING_RULES,
): RouteResult {
  if (path.length > MAX_ROUTE_PATH_LENGTH) {
    throw new RouteError(`path exceeds ${MAX_ROUTE_PATH_LENGTH} bytes (ENAMETOOLONG)`);
  }
  if (path.includes("\0")) {
    throw new RouteError("path contains a null byte");
  }
  const normalized = normalizeRoutePath(path);
  const terminal = routeByPrefix(normalized, rules, DEFAULT_ROUTE);
  if (terminal.kind === "block") return { kind: "block" };
  return { kind: "handle", backend: terminal.backend, normalized };
}

/**
 * Resolve a path against a cwd, then route.
 *
 * An absolute path must replace the cwd rather than be joined under it: this is
 * `openat(dirfd, path)` semantics, where an absolute path ignores `dirfd` entirely. The
 * previous join meant `resolveAndRoute("/tmp", "/sys/x")` produced `/tmp/sys/x` and routed
 * to the `tmp` backend, so a blocked prefix was unreachable by absolute path from any cwd
 * other than the root — the policy was bypassed by construction, not by exploit.
 */
export function resolveAndRoute(
  cwd: string,
  path: string,
  rules?: readonly RoutingRule[],
): RouteResult {
  const normalized = normalizeRoutePath(path.startsWith("/") ? path : `${cwd}/${path}`);
  const routed = routePath(normalized, rules);
  return routed.kind === "block" ? routed : { kind: "handle", backend: routed.backend, normalized };
}

/**
 * Path normalization for routing: resolve `.` and `..` lexically, ensure a leading
 * `/`, drop trailing slashes. Pure — deliberately does not consult the filesystem,
 * because the router runs *before* a backend is chosen, and consulting one backend
 * to route to another would be a category error.
 */
export function normalizeRoutePath(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = withLeading.split("/").filter((p) => p && p !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}` || "/";
}

/**
 * A snapshot of the filter's decisions, for the audit log and the cockpit telemetry
 * panel. Kept as data rather than emitted as a log line so a UI can render it and a
 * test can assert on it.
 */
export interface FilterAuditEntry {
  readonly timestamp: number;
  readonly syscall: string;
  readonly disposition: SyscallDisposition;
  readonly errno?: string;
  readonly path?: string;
  readonly backend?: FsBackend;
  readonly reason: string;
}

/**
 * The filter's audit buffer: records every decision, capped so a hostile workload
 * cannot turn the audit itself into a memory-exhaustion vector.
 */
export class SyscallAuditLog {
  private readonly entries: FilterAuditEntry[] = [];
  private readonly dispositionCount = new Map<SyscallDisposition, number>();

  constructor(private readonly capacity = 4096) {}

  record(entry: FilterAuditEntry): void {
    if (this.entries.length >= this.capacity) this.entries.shift();
    this.entries.push(entry);
    this.dispositionCount.set(
      entry.disposition,
      (this.dispositionCount.get(entry.disposition) ?? 0) + 1,
    );
  }

  /** Record a decision for a plain (non-path) syscall. */
  recordSyscall(syscall: string, timestamp = Date.now()): FilterAuditEntry {
    const verdict = classifySyscall(syscall);
    const entry: FilterAuditEntry = {
      timestamp,
      syscall: verdict.syscall,
      disposition: verdict.disposition,
      errno: verdict.errno,
      reason: verdict.reason,
    };
    this.record(entry);
    return entry;
  }

  snapshot(): readonly FilterAuditEntry[] {
    return [...this.entries];
  }

  /** Denials of any kind, in chronological order. */
  denials(): readonly FilterAuditEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.disposition === "deny_eperm" ||
        entry.disposition === "deny_enosys" ||
        entry.disposition === "unsupported",
    );
  }

  count(disposition: SyscallDisposition): number {
    return this.dispositionCount.get(disposition) ?? 0;
  }

  clear(): void {
    this.entries.length = 0;
    this.dispositionCount.clear();
  }
}
