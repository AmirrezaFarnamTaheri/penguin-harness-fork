/**
 * The seccomp policy port: dispositions, path router, and prefix matching.
 *
 * What is pinned here is the security invariant the module's own header states: network is
 * outbound-only, every escape and privilege-raising primitive is denied, unimplemented
 * syscalls fail closed as ENOSYS rather than being passed through on the assumption they are
 * harmless, and — the part that ships silently when untested — `/tmpfoo` is not a child of
 * `/tmp`. The default routing table is not exported, so it is reached through `routePath`'s
 * optional rules argument, which is how every real caller reaches it.
 */
import { describe, expect, it } from "vitest";

import {
  classifyPathSyscall,
  classifySyscall,
  DENIED_SYSCALLS,
  type FilterAuditEntry,
  type FsBackend,
  MAX_ROUTE_PATH_LENGTH,
  matchesPrefix,
  normalizeRoutePath,
  PRIVATE_STATE_DIR_NAME,
  resolveAndRoute,
  RouteError,
  routePath,
  type RouteResult,
  SyscallAuditLog,
  type SyscallDisposition,
} from "../../src/sandbox/syscall-filter.js";

/** Read the backend off a route result without narrowing the union at every call site. */
function backendOf(result: RouteResult): FsBackend | undefined {
  return result.kind === "handle" ? result.backend : undefined;
}

/** The 26 names the three deny sets hold, in source order. `DENIED_SYSCALLS` is their sort. */
const DENY_SOURCE = [
  // DENY_EPERM_SYSCALLS — the network-server syscalls.
  "bind",
  "listen",
  "accept",
  "accept4",
  // DENY_ENOSYS_SYSCALLS — escape, privilege, and resource control.
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
  // UNSUPPORTED_SYSCALLS — known but unimplemented.
  "getrlimit",
  "getrusage",
] as const;

const DENY_DISPOSITIONS: readonly SyscallDisposition[] = [
  "deny_eperm",
  "deny_enosys",
  "unsupported",
];

describe("syscall dispositions", () => {
  it("virtualizes the syscall set the sandbox implements handlers for", () => {
    // Filesystem, process, and the outbound-network syscall the guest is permitted to make.
    for (const syscall of ["openat", "close", "read", "write", "execve", "getpid", "connect"]) {
      expect(classifySyscall(syscall)).toEqual({
        disposition: "virtualize",
        syscall,
        reason: "implemented handler",
      });
    }
  });

  it("passes through process-local and read-only syscalls unchanged", () => {
    for (const syscall of [
      "clone",
      "clone3",
      "wait4",
      "getuid",
      "geteuid",
      "brk",
      "mmap",
      "clock_gettime",
      "futex",
      "getrandom",
      "rseq",
    ]) {
      expect(classifySyscall(syscall)).toEqual({
        disposition: "passthrough",
        syscall,
        reason: "process-local or read-only",
      });
    }
  });

  it("permits outbound connections while forbidding every listening primitive", () => {
    // connect is in the virtualized set: a guest may reach out, subject to the egress list.
    expect(classifySyscall("connect").disposition).toBe("virtualize");
    // A listening socket is how a sandboxed process becomes a service other tenants can reach.
    for (const syscall of ["bind", "listen", "accept", "accept4"]) {
      const verdict = classifySyscall(syscall);
      expect(verdict).toEqual({
        disposition: "deny_eperm",
        syscall,
        errno: "EPERM",
        reason: "network is outbound-only; listening is forbidden",
      });
    }
  });

  it("denies every escape and privilege-raising syscall with ENOSYS", () => {
    for (const syscall of DENY_ENOSYS_EXPECTED) {
      const verdict = classifySyscall(syscall);
      expect(verdict.disposition).toBe("deny_enosys");
      expect(verdict.errno).toBe("ENOSYS");
      expect(verdict.syscall).toBe(syscall);
      expect(verdict.reason).toBe("escape, privilege, or resource-control primitive");
    }
  });

  it("tells a program a resource ceiling cannot be raised from inside", () => {
    // Defeats every memory and process ceiling the sandbox was configured with.
    for (const syscall of ["setrlimit", "prlimit64"]) {
      expect(classifySyscall(syscall).disposition).toBe("deny_enosys");
    }
    // Execution-domain exploit primitive, and a guest installing its own permissive filter.
    expect(classifySyscall("personality").disposition).toBe("deny_enosys");
    expect(classifySyscall("seccomp").disposition).toBe("deny_enosys");
    expect(classifySyscall("bpf").disposition).toBe("deny_enosys");
  });

  it("reports known-unsupported syscalls rather than denying or passing them through", () => {
    // getrlimit/getrusage leak resource configuration and usage in a multitenant setting, so
    // they are neither virtualized nor passed through — they fail closed.
    for (const syscall of ["getrlimit", "getrusage"]) {
      expect(classifySyscall(syscall)).toEqual({
        disposition: "unsupported",
        syscall,
        errno: "ENOSYS",
        reason: "not implemented; fails closed to avoid information disclosure",
      });
    }
  });

  it("fails closed on a syscall the table has never heard of", () => {
    // "we have not thought about this one" and "this one is safe" are different claims.
    const verdict = classifySyscall("totally_made_up_syscall");
    expect(verdict).toEqual({
      disposition: "unsupported",
      syscall: "totally_made_up_syscall",
      errno: "ENOSYS",
      reason: "unknown syscall; unimplemented syscalls fail closed",
    });
    // The empty string is not a syscall and earns the same closed default, not passthrough.
    expect(classifySyscall("").disposition).toBe("unsupported");
  });

  it("replies in the donor's verdict shape: an errno only ever accompanies a denial", () => {
    for (const syscall of [
      ...DENY_SOURCE,
      "openat",
      "clone",
      "getuid",
      "connect",
      "never_heard_of_this",
    ]) {
      const verdict = classifySyscall(syscall);
      const isDenied = DENY_DISPOSITIONS.includes(verdict.disposition);
      expect(verdict.errno !== undefined).toBe(isDenied);
      expect(verdict.syscall).toBe(syscall);
      expect(typeof verdict.reason).toBe("string");
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it("exports the full deny list as the sorted union of the three deny sets", () => {
    expect(DENIED_SYSCALLS).toEqual([...DENY_SOURCE].sort());
    expect(DENIED_SYSCALLS.length).toBe(26);
    // Sorted by the same default comparison the source used.
    const sorted = [...DENIED_SYSCALLS];
    expect(sorted).toEqual([...sorted].sort());
    // Every denied syscall classifies as a denial, and none of them is virtualized or passed
    // through — the sets are disjoint, so a deny entry can never also be an allowed one.
    for (const syscall of DENIED_SYSCALLS) {
      expect(DENY_DISPOSITIONS).toContain(classifySyscall(syscall).disposition);
    }
  });
});

const DENY_ENOSYS_EXPECTED = [
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
] as const;

describe("path-carrying syscalls route before they reach a backend", () => {
  it("attaches the routed backend and normalized path to an allowed syscall", () => {
    const verdict = classifyPathSyscall("openat", "/tmp", "notes.txt");
    expect(verdict.disposition).toBe("virtualize");
    expect(verdict.path).toBe("/tmp/notes.txt");
    expect(verdict.backend).toBe("tmp");
    expect(verdict.reason).toBe("implemented handler; routed to tmp backend");
  });

  it("turns an otherwise-virtualized syscall into an EPERM denial outside the prefixes", () => {
    const verdict = classifyPathSyscall("openat", "/", "/sys/kernel/xyz");
    expect(verdict).toEqual({
      disposition: "deny_eperm",
      syscall: "openat",
      errno: "EPERM",
      path: "/sys/kernel/xyz",
      reason: "path is outside the sandbox's permitted prefixes",
    });
  });

  it("does not route a syscall whose disposition is already a denial", () => {
    // bind is denied before any path is considered, so it carries neither path nor backend.
    const verdict = classifyPathSyscall("bind", "/tmp", "/tmp/x");
    expect(verdict.disposition).toBe("deny_eperm");
    expect(verdict.errno).toBe("EPERM");
    expect(verdict.path).toBeUndefined();
    expect(verdict.backend).toBeUndefined();
    // A passthrough syscall is likewise never routed.
    const pass = classifyPathSyscall("getuid", "/tmp", "/tmp/x");
    expect(pass.disposition).toBe("passthrough");
    expect(pass.path).toBeUndefined();
    expect(pass.backend).toBeUndefined();
  });

  it("routes the private state directory to a denial even from inside /tmp", () => {
    const verdict = classifyPathSyscall("openat", "/tmp", `${PRIVATE_STATE_DIR_NAME}/secret`);
    expect(verdict.disposition).toBe("deny_eperm");
    expect(verdict.errno).toBe("EPERM");
  });
});

describe("the path prefix router", () => {
  it("treats /tmp as a branch: the directory itself and its children are tmp", () => {
    expect(routePath("/tmp")).toEqual({ kind: "handle", backend: "tmp", normalized: "/tmp" });
    expect(routePath("/tmp/work")).toEqual({
      kind: "handle",
      backend: "tmp",
      normalized: "/tmp/work",
    });
    // A trailing slash normalizes away before any rule sees it.
    expect(routePath("/tmp/")).toEqual({ kind: "handle", backend: "tmp", normalized: "/tmp" });
    expect(routePath("/tmp//work")).toEqual({
      kind: "handle",
      backend: "tmp",
      normalized: "/tmp/work",
    });
  });

  it("does not treat /tmpfoo as a child of /tmp", () => {
    // The invariant the module's header calls out. A naive startsWith check routes /tmpfoo to
    // the tmp backend; the component boundary routes it to the default, which is cow — the
    // most isolating backend, not the most permissive one.
    expect(routePath("/tmpfoo")).toEqual({ kind: "handle", backend: "cow", normalized: "/tmpfoo" });
    expect(routePath("/tmp/foo")).toEqual({
      kind: "handle",
      backend: "tmp",
      normalized: "/tmp/foo",
    });
    expect(backendOf(routePath("/tmpfoo"))).not.toBe(backendOf(routePath("/tmp")));
  });

  it("blocks the host control surfaces /sys and /run", () => {
    expect(routePath("/sys")).toEqual({ kind: "block" });
    expect(routePath("/sys/kernel")).toEqual({ kind: "block" });
    expect(routePath("/run")).toEqual({ kind: "block" });
    expect(routePath("/run/sandbox.pid")).toEqual({ kind: "block" });
  });

  it("routes /proc to the proc backend so the guest sees the sandbox's process list", () => {
    expect(routePath("/proc")).toEqual({ kind: "handle", backend: "proc", normalized: "/proc" });
    expect(routePath("/proc/self/status")).toEqual({
      kind: "handle",
      backend: "proc",
      normalized: "/proc/self/status",
    });
    // A sibling that merely shares the prefix does not inherit the backend.
    expect(routePath("/procbench")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/procbench",
    });
  });

  it("handles /dev as a branch: the four harmless devices pass through, the rest is blocked", () => {
    // Longest-prefix-wins by rule order is what makes /dev/null pass while /dev/sda is blocked.
    expect(routePath("/dev")).toEqual({ kind: "block" });
    expect(routePath("/dev/sda")).toEqual({ kind: "block" });
    expect(routePath("/dev/mem")).toEqual({ kind: "block" });
    for (const device of ["null", "zero", "random", "urandom"]) {
      expect(routePath(`/dev/${device}`)).toEqual({
        kind: "handle",
        backend: "passthrough",
        normalized: `/dev/${device}`,
      });
      // Trailing slash on a passthrough device still lands on passthrough.
      expect(backendOf(routePath(`/dev/${device}/`))).toBe("passthrough");
    }
    // The boundary again: /devnull is not /dev's child, so it is neither blocked nor passed
    // through — it falls through to cow.
    expect(routePath("/devnull")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/devnull",
    });
  });

  it("blocks the sandbox's own private state directory under /tmp", () => {
    expect(routePath(`/tmp/${PRIVATE_STATE_DIR_NAME}`)).toEqual({ kind: "block" });
    expect(routePath(`/tmp/${PRIVATE_STATE_DIR_NAME}/state.json`)).toEqual({ kind: "block" });
    // A namespaced lookalike is still tmp, not the private directory.
    expect(backendOf(routePath(`/tmp/${PRIVATE_STATE_DIR_NAME}-other`))).toBe("tmp");
    expect(backendOf(routePath("/tmp/.sandboxx"))).toBe("tmp");
  });

  it("defaults unclassified paths to cow, the most isolating backend", () => {
    expect(routePath("/home/user/project")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/home/user/project",
    });
    expect(routePath("/etc/passwd")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/etc/passwd",
    });
    expect(routePath("/")).toEqual({ kind: "handle", backend: "cow", normalized: "/" });
    // An empty path normalizes to the root and still defaults to cow.
    expect(routePath("")).toEqual({ kind: "handle", backend: "cow", normalized: "/" });
  });

  it("resolves a .. traversal before any rule sees it, so it cannot escape the cow backend", () => {
    // A traversal that leaves /tmp lands on cow, not on tmp: the guest cannot prefix its way
    // out of the isolating default by naming a permitted directory and then walking up.
    expect(routePath("/tmp/../../etc/passwd")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/etc/passwd",
    });
    expect(backendOf(routePath("/tmp/foo/../../etc/passwd"))).toBe("cow");
    // A traversal that resolves into a blocked prefix is blocked, because normalization
    // happens before matching — the block cannot be bypassed with a /sys/../ detour.
    expect(routePath("/proc/../sys/kernel")).toEqual({ kind: "block" });
    // A traversal that stays inside a permitted directory keeps that directory's backend.
    expect(routePath("/tmp/a/../b")).toEqual({
      kind: "handle",
      backend: "tmp",
      normalized: "/tmp/b",
    });
    // `.` components are dropped the same way.
    expect(backendOf(routePath("/tmp/./work"))).toBe("tmp");
  });

  it("rejects a null byte and an over-long path rather than mis-routing them", () => {
    expect(() => routePath("/tmp/\u0000secret")).toThrow(RouteError);
    expect(() => routePath("/tmp/\u0000secret")).toThrow(/null byte/);

    const overlong = `/tmp/${"a".repeat(MAX_ROUTE_PATH_LENGTH)}`;
    expect(overlong.length).toBeGreaterThan(MAX_ROUTE_PATH_LENGTH);
    expect(() => routePath(overlong)).toThrow(RouteError);
    expect(() => routePath(overlong)).toThrow(
      new RegExp(`path exceeds ${MAX_ROUTE_PATH_LENGTH} bytes \\(ENAMETOOLONG\\)`),
    );
    // Exactly at the limit the path is still routed normally, not rejected.
    const atLimit = `/tmp/${"a".repeat(MAX_ROUTE_PATH_LENGTH - "/tmp/".length)}`;
    expect(atLimit.length).toBe(MAX_ROUTE_PATH_LENGTH);
    expect(backendOf(routePath(atLimit))).toBe("tmp");
  });

  it("honours an explicit routing table when one is supplied", () => {
    // The caller-supplied table replaces the default, and its branch default applies.
    expect(
      routePath("/data/secret", [
        {
          prefix: "/data",
          node: {
            kind: "branch",
            default: { kind: "block" },
            subrules: [
              {
                prefix: "public",
                node: { kind: "terminal", result: { kind: "handle", backend: "passthrough" } },
              },
            ],
          },
        },
      ]),
    ).toEqual({ kind: "block" });
    expect(routePath("/data/public", [])).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/data/public",
    });
  });
});

describe("relative path resolution", () => {
  it("resolves a relative path against the cwd and routes the result", () => {
    expect(resolveAndRoute("/tmp", "notes.txt")).toEqual({
      kind: "handle",
      backend: "tmp",
      normalized: "/tmp/notes.txt",
    });
    expect(resolveAndRoute("/", "etc/passwd")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/etc/passwd",
    });
    // `.` and `..` in the relative leg resolve against the cwd.
    expect(resolveAndRoute("/tmp/x", "../y")).toEqual({
      kind: "handle",
      backend: "tmp",
      normalized: "/tmp/y",
    });
  });

  it("keeps a traversal from escaping the sandbox's permitted prefixes", () => {
    expect(resolveAndRoute("/tmp", "../etc/passwd")).toEqual({
      kind: "handle",
      backend: "cow",
      normalized: "/etc/passwd",
    });
    expect(resolveAndRoute("/tmp/work", "../../sys/x")).toEqual({ kind: "block" });
  });

  it("routes a blocked path to a denial when the resolution reaches it", () => {
    expect(resolveAndRoute("/", "sys/x").kind).toBe("block");
    // An absolute path argument replaces the cwd rather than being joined under it —
    // `openat(dirfd, path)` ignores `dirfd` for absolute paths. Joining used to land an
    // absolute /sys path inside /tmp, making the blocked prefix unreachable by absolute
    // path from any non-root cwd.
    expect(resolveAndRoute("/tmp", "/sys/x").kind).toBe("block");
    expect(resolveAndRoute("/tmp/work", "/sys/x").kind).toBe("block");
  });
});

describe("component-boundary prefix matching", () => {
  it("returns the remainder for a real child, at any depth", () => {
    expect(matchesPrefix("/tmp", "/tmp")).toBe("");
    expect(matchesPrefix("/tmp/work", "/tmp")).toBe("work");
    expect(matchesPrefix("/tmp/a/b/c", "/tmp")).toBe("a/b/c");
  });

  it("consumes the separating slash so a branch matches its subrules against the rest", () => {
    expect(matchesPrefix("/dev/null", "/dev")).toBe("null");
    expect(matchesPrefix("/dev/sda", "/dev")).toBe("sda");
  });

  it("returns null for a sibling that merely shares the prefix text", () => {
    expect(matchesPrefix("/tmpfoo", "/tmp")).toBeNull();
    expect(matchesPrefix("/devnull", "/dev")).toBeNull();
    expect(matchesPrefix("/procbench", "/proc")).toBeNull();
  });

  it("returns null when the path is shorter than the prefix", () => {
    expect(matchesPrefix("/tm", "/tmp")).toBeNull();
    expect(matchesPrefix("", "/tmp")).toBeNull();
  });

  it("treats a trailing slash as the empty remainder of the prefix", () => {
    expect(matchesPrefix("/tmp/", "/tmp")).toBe("");
    expect(matchesPrefix("/dev/", "/dev")).toBe("");
  });

  it("handles an empty path and an empty prefix", () => {
    expect(matchesPrefix("", "")).toBe("");
    // An empty prefix matches everything at its first component boundary.
    expect(matchesPrefix("/tmp", "")).toBe("tmp");
  });
});

describe("path normalization", () => {
  it("ensures a leading slash and drops trailing slashes", () => {
    expect(normalizeRoutePath("")).toBe("/");
    expect(normalizeRoutePath("/")).toBe("/");
    expect(normalizeRoutePath("tmp")).toBe("/tmp");
    expect(normalizeRoutePath("tmp/")).toBe("/tmp");
    expect(normalizeRoutePath("/tmp//work/")).toBe("/tmp/work");
  });

  it("resolves . and .. lexically, without consulting the filesystem", () => {
    expect(normalizeRoutePath("/tmp/./work")).toBe("/tmp/work");
    expect(normalizeRoutePath("/tmp/a/../b")).toBe("/tmp/b");
    // Popping past the root stays at the root.
    expect(normalizeRoutePath("/tmp/../../..")).toBe("/");
    expect(normalizeRoutePath("../../..")).toBe("/");
    // A .. that would escape a blocked prefix is resolved before matching, never preserved.
    expect(normalizeRoutePath("/proc/../sys")).toBe("/sys");
  });
});

describe("the audit log", () => {
  function entry(
    syscall: string,
    disposition: SyscallDisposition,
    timestamp: number,
  ): FilterAuditEntry {
    return { timestamp, syscall, disposition, reason: "test" };
  }

  it("records decisions and snapshots them in chronological order", () => {
    const log = new SyscallAuditLog();
    log.recordSyscall("openat");
    log.recordSyscall("bind");
    log.recordSyscall("clone");
    const snapshot = log.snapshot();
    expect(snapshot.map((e) => e.syscall)).toEqual(["openat", "bind", "clone"]);
    expect(snapshot.map((e) => e.disposition)).toEqual(["virtualize", "deny_eperm", "passthrough"]);
    // A snapshot is a copy: mutating it does not touch the log.
    const detached = [...snapshot];
    detached.push(entry("extra", "passthrough", 0));
    expect(log.snapshot()).toHaveLength(3);
  });

  it("classifies through the same table when recording a bare syscall name", () => {
    const log = new SyscallAuditLog();
    const recorded = log.recordSyscall("ptrace", 1000);
    expect(recorded).toEqual({
      timestamp: 1000,
      syscall: "ptrace",
      disposition: "deny_enosys",
      errno: "ENOSYS",
      reason: "escape, privilege, or resource-control primitive",
    });
    expect(log.snapshot()[0]).toBe(recorded);
    // Without an explicit timestamp the entry gets a real one.
    expect(log.recordSyscall("openat").timestamp).toBeGreaterThan(0);
  });

  it("evicts the oldest entry at capacity, keeping the most recent (FIFO, not LRU)", () => {
    const log = new SyscallAuditLog(3);
    log.recordSyscall("openat");
    log.recordSyscall("bind");
    log.recordSyscall("ptrace");
    expect(log.snapshot().map((e) => e.syscall)).toEqual(["openat", "bind", "ptrace"]);
    // At capacity, each new record evicts the head — a circular buffer, not an LRU that would
    // need a read to promote an entry.
    log.recordSyscall("clone");
    expect(log.snapshot().map((e) => e.syscall)).toEqual(["bind", "ptrace", "clone"]);
    log.recordSyscall("getuid");
    expect(log.snapshot().map((e) => e.syscall)).toEqual(["ptrace", "clone", "getuid"]);
  });

  it("caps the default capacity so a hostile workload cannot exhaust memory with audits", () => {
    const log = new SyscallAuditLog();
    // Unique timestamps identify each record, so eviction is provable rather than inferred.
    for (let i = 0; i < 5000; i++) log.record(entry("openat", "virtualize", i));
    const snapshot = log.snapshot();
    expect(snapshot).toHaveLength(4096);
    // The 904 earliest records were evicted; the buffer holds exactly the most recent 4096.
    expect(snapshot[0]!.timestamp).toBe(904);
    expect(snapshot[snapshot.length - 1]!.timestamp).toBe(4999);
  });

  it("counts every disposition, and the counts are cumulative across eviction", () => {
    const log = new SyscallAuditLog(2);
    log.recordSyscall("openat");
    log.recordSyscall("bind");
    log.recordSyscall("ptrace");
    // Two virtualize/deny entries were evicted from the buffer, but the tallies still count them.
    expect(log.count("virtualize")).toBe(1);
    expect(log.count("deny_eperm")).toBe(1);
    expect(log.count("deny_enosys")).toBe(1);
    expect(log.count("passthrough")).toBe(0);
    log.recordSyscall("openat");
    expect(log.count("virtualize")).toBe(2);
  });

  it("lists denials of every kind, including unsupported, in chronological order", () => {
    const log = new SyscallAuditLog();
    log.recordSyscall("openat");
    log.recordSyscall("bind");
    log.recordSyscall("clone");
    log.recordSyscall("ptrace");
    log.recordSyscall("getrusage");
    expect(log.denials().map((e) => [e.syscall, e.disposition])).toEqual([
      ["bind", "deny_eperm"],
      ["ptrace", "deny_enosys"],
      ["getrusage", "unsupported"],
    ]);
  });

  it("clears both the buffer and the tallies", () => {
    const log = new SyscallAuditLog();
    log.recordSyscall("bind");
    log.recordSyscall("openat");
    log.clear();
    expect(log.snapshot()).toHaveLength(0);
    expect(log.denials()).toHaveLength(0);
    expect(log.count("deny_eperm")).toBe(0);
    expect(log.count("virtualize")).toBe(0);
  });
});
