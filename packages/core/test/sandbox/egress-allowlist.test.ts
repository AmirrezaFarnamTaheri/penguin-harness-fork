import { describe, expect, it } from "vitest";

import {
  decideEgress,
  isPrivateIp,
  isUrlAllowed,
  matchesAllowListEntry,
  normalizeAllowListEntry,
  parseUrl,
  validateAllowList,
  type AllowedUrlEntry,
} from "../../src/sandbox/egress-allowlist.js";

describe("egress-allowlist", () => {
  describe("parseUrl and normalizeAllowListEntry", () => {
    it("returns origin, pathname and href for a well-formed URL", () => {
      expect(parseUrl("https://example.com/api/v1?a=1#frag")).toEqual({
        origin: "https://example.com",
        pathname: "/api/v1",
        href: "https://example.com/api/v1?a=1#frag",
      });
    });

    it("returns null for anything the WHATWG parser rejects", () => {
      expect(parseUrl("not a url")).toBeNull();
      expect(parseUrl("")).toBeNull();
      expect(parseUrl("https://")).toBeNull();
      // An unknown scheme is *parseable* — the parser does not share our http/https
      // policy, so a scheme rule lives in validateAllowList, not here.
      expect(parseUrl("ftp://example.com/")).not.toBeNull();
    });

    it("normalizes an allow-list entry into origin and path prefix", () => {
      expect(normalizeAllowListEntry("https://example.com")).toEqual({
        origin: "https://example.com",
        pathPrefix: "/",
      });
      expect(normalizeAllowListEntry("https://example.com/api/v1/")).toEqual({
        origin: "https://example.com",
        pathPrefix: "/api/v1/",
      });
    });

    it("returns null for a malformed entry", () => {
      expect(normalizeAllowListEntry("://no-scheme")).toBeNull();
    });
  });

  describe("isUrlAllowed: origins must match exactly", () => {
    const allow = (entry: AllowedUrlEntry, url: string) => isUrlAllowed(url, [entry]);

    it("allows an exact origin", () => {
      expect(allow("https://example.com", "https://example.com/")).toBe(true);
      expect(allow("https://example.com", "https://example.com/deep/path")).toBe(true);
    });

    it("denies a subdomain of an allowed origin", () => {
      expect(allow("https://example.com", "https://sub.example.com/")).toBe(false);
    });

    it("denies a host that merely ends with the allowed host string", () => {
      // The classic allow-list bypass: a suffix match on the wrong boundary.
      expect(allow("https://example.com", "https://example.com.evil.com/")).toBe(false);
      expect(allow("https://good.com", "https://good.comx/")).toBe(false);
    });

    it("denies a different scheme on the same host", () => {
      expect(allow("https://example.com", "http://example.com/")).toBe(false);
    });

    it("denies a non-default port when the entry does not name it", () => {
      expect(allow("https://example.com", "https://example.com:8443/")).toBe(false);
      expect(allow("https://example.com:8443", "https://example.com/")).toBe(false);
    });

    it("treats an explicit default port as the same origin", () => {
      // The WHATWG origin serializer drops a default port, so :443 is not a way to
      // make an https origin look different from the allowed one.
      expect(allow("https://example.com", "https://example.com:443/")).toBe(true);
    });

    it("ignores userinfo when comparing origins", () => {
      expect(allow("https://example.com", "https://user:pass@example.com/")).toBe(true);
    });

    it("matches a host case-insensitively", () => {
      expect(allow("https://example.com", "https://EXAMPLE.com/")).toBe(true);
      expect(allow("HTTPS://EXAMPLE.COM", "https://example.com/")).toBe(true);
    });

    it("accepts an entry given as a { url } object", () => {
      expect(allow({ url: "https://example.com" }, "https://example.com/")).toBe(true);
      expect(allow({ url: "https://example.com" }, "https://other.com/")).toBe(false);
    });

    it("denies everything when the allow-list is empty or absent", () => {
      // The network is off by default.
      expect(isUrlAllowed("https://example.com/", [])).toBe(false);
      expect(isUrlAllowed("https://example.com/", undefined as unknown as AllowedUrlEntry[])).toBe(
        false,
      );
    });

    it("denies a URL the parser rejects regardless of the entry", () => {
      expect(allow("https://example.com", "garbage")).toBe(false);
    });

    it("allows any entry on the list, not just the first", () => {
      const list: AllowedUrlEntry[] = ["https://first.com", "https://second.com"];
      expect(isUrlAllowed("https://second.com/", list)).toBe(true);
    });
  });

  describe("isUrlAllowed: path segment boundaries", () => {
    const allow = (url: string) => isUrlAllowed(url, ["https://example.com/api"]);

    it("matches the exact path and any child at a component boundary", () => {
      expect(allow("https://example.com/api")).toBe(true);
      expect(allow("https://example.com/api/")).toBe(true);
      expect(allow("https://example.com/api/v1/resource")).toBe(true);
      expect(allow("https://example.com/api?query=1")).toBe(true);
    });

    it("does not match a sibling whose name merely starts with the prefix", () => {
      // /tmpfoo is not a child of /tmp, and /apix is not a child of /api.
      expect(allow("https://example.com/apix")).toBe(false);
      expect(allow("https://example.com/api2")).toBe(false);
      expect(allow("https://example.com/apiv1")).toBe(false);
      expect(allow("https://example.com/")).toBe(false);
    });

    it("does not match an unrelated path on the allowed origin", () => {
      expect(allow("https://example.com/other")).toBe(false);
    });

    it("treats a trailing slash in the entry as a directory scope", () => {
      const allowDir = (url: string) => isUrlAllowed(url, ["https://example.com/api/"]);
      expect(allowDir("https://example.com/api/x")).toBe(true);
      expect(allowDir("https://example.com/api/")).toBe(true);
      // The entry names the directory, not the file.
      expect(allowDir("https://example.com/api")).toBe(false);
    });

    it("allows every path when the entry is origin-scoped", () => {
      const allowOrigin = (url: string) => isUrlAllowed(url, ["https://example.com"]);
      expect(allowOrigin("https://example.com/")).toBe(true);
      expect(allowOrigin("https://example.com/anything/at/all")).toBe(true);
    });
  });

  describe("isUrlAllowed: ambiguous encoded path syntax", () => {
    const allow = (url: string) => isUrlAllowed(url, ["https://example.com/api"]);

    it("rejects an encoded path separator", () => {
      expect(allow("https://example.com/api%2f..%2fetc")).toBe(false);
    });

    it("rejects an encoded dot, backslash and semicolon", () => {
      expect(allow("https://example.com/api%2e%2e")).toBe(false);
      expect(allow("https://example.com/api%5c")).toBe(false);
      expect(allow("https://example.com/x%3by")).toBe(false);
    });

    it("rejects a malformed percent escape and a trailing percent", () => {
      // Something upstream may decode one more time than we do.
      expect(allow("https://example.com/api%")).toBe(false);
      expect(allow("https://example.com/api%2")).toBe(false);
      expect(allow("https://example.com/api%zz")).toBe(false);
    });

    it("rejects a doubly- and triply-encoded traversal", () => {
      // The decode stack is bounded but iterated, so nesting does not outrun it.
      expect(allow("https://example.com/api%252f..")).toBe(false);
      expect(allow("https://example.com/api%25252f..")).toBe(false);
      // Four levels of encoding outlast the bounded loop but still leave a `%`
      // behind, and the final check rejects any surviving escape.
      expect(allow("https://example.com/api%2525252f..")).toBe(false);
    });

    it("rejects a literal backslash in a path", () => {
      // The WHATWG parser turns `\` into `/` on a special URL, so this is the raw
      // form a caller would hand the matcher before the parser normalizes it.
      expect(matchesAllowListEntry("https://example.com/api\\..", "https://example.com/api")).toBe(
        false,
      );
    });

    it("admits an unencoded, unambiguous path on a path-scoped entry", () => {
      expect(allow("https://example.com/api/v1/users")).toBe(true);
      expect(allow("https://example.com/api/a-b_c.d")).toBe(true);
    });

    it("does not apply the ambiguity rule to an origin-scoped entry", () => {
      // Ambiguity is a property of *directory* boundaries: an entry that allows the
      // whole origin makes no directory claim, so encoded separators are not a
      // bypass of anything.
      const allowOrigin = (url: string) => isUrlAllowed(url, ["https://example.com"]);
      expect(allowOrigin("https://example.com/api%2f..")).toBe(true);
    });
  });

  describe("isPrivateIp: IPv4", () => {
    it("rejects loopback and every RFC 1918 private range", () => {
      expect(isPrivateIp("127.0.0.1")).toBe(true);
      expect(isPrivateIp("127.1.2.3")).toBe(true);
      expect(isPrivateIp("10.0.0.1")).toBe(true);
      expect(isPrivateIp("172.16.0.1")).toBe(true);
      expect(isPrivateIp("172.31.255.255")).toBe(true);
      expect(isPrivateIp("192.168.1.1")).toBe(true);
    });

    it("rejects link-local, this-host, CGNAT, benchmarking and special-use blocks", () => {
      expect(isPrivateIp("169.254.169.254")).toBe(true); // cloud metadata endpoint
      expect(isPrivateIp("169.254.1.1")).toBe(true);
      expect(isPrivateIp("0.0.0.0")).toBe(true);
      expect(isPrivateIp("100.64.0.1")).toBe(true); // RFC 6598 CGNAT
      expect(isPrivateIp("100.127.255.255")).toBe(true);
      expect(isPrivateIp("198.18.0.1")).toBe(true); // RFC 2544
      expect(isPrivateIp("198.19.0.1")).toBe(true);
      expect(isPrivateIp("192.0.0.1")).toBe(true); // RFC 6890
      expect(isPrivateIp("192.0.2.1")).toBe(true); // TEST-NET-1
      expect(isPrivateIp("198.51.100.1")).toBe(true); // TEST-NET-2
      expect(isPrivateIp("203.0.113.1")).toBe(true); // TEST-NET-3
      expect(isPrivateIp("240.0.0.1")).toBe(true); // RFC 1112 reserved
      expect(isPrivateIp("255.255.255.255")).toBe(true);
    });

    it("accepts the octal, hexadecimal and integer spellings of a private address", () => {
      // The kernel accepts these, so the check has to as well.
      expect(isPrivateIp("0177.0.0.1")).toBe(true);
      expect(isPrivateIp("0x7f.0.0.1")).toBe(true);
      expect(isPrivateIp("2130706433")).toBe(true);
      expect(isPrivateIp("127.1")).toBe(true);
      expect(isPrivateIp("0")).toBe(true);
    });

    it("admits public addresses and the boundaries just outside each private block", () => {
      expect(isPrivateIp("8.8.8.8")).toBe(false);
      expect(isPrivateIp("1.1.1.1")).toBe(false);
      expect(isPrivateIp("93.184.216.34")).toBe(false);
      expect(isPrivateIp("172.15.255.255")).toBe(false);
      expect(isPrivateIp("172.32.0.1")).toBe(false);
      expect(isPrivateIp("100.63.255.255")).toBe(false);
      expect(isPrivateIp("100.128.0.1")).toBe(false);
      expect(isPrivateIp("198.17.255.255")).toBe(false);
      expect(isPrivateIp("198.20.0.1")).toBe(false);
      expect(isPrivateIp("192.0.1.1")).toBe(false);
      expect(isPrivateIp("239.255.255.250")).toBe(false);
    });

    it("does not flag IPv4 multicast, which the table omits", () => {
      // The table blocks 240.0.0.0/4 (reserved) and has no entry for the multicast
      // block 224.0.0.0/4; the module header enumerates the ranges it covers and
      // multicast is not among them. Asserted as-implemented rather than as wished.
      expect(isPrivateIp("224.0.0.1")).toBe(false);
    });

    it("accepts bracketed and whitespace-padded forms", () => {
      expect(isPrivateIp("[127.0.0.1]")).toBe(true);
      expect(isPrivateIp("  10.0.0.1  ")).toBe(true);
      expect(isPrivateIp("127.0.0.1\n")).toBe(true);
    });

    it("accepts the trailing-dot FQDN spelling of a private address", () => {
      // A trailing dot is the DNS root label, not a different host: resolvers and
      // libc treat `127.0.0.1.` and `127.0.0.1` as the same address, so the
      // dotted spelling must not slip past the check.
      expect(isPrivateIp("127.0.0.1.")).toBe(true);
      expect(isPrivateIp("10.0.0.1.")).toBe(true);
      expect(isPrivateIp("192.168.1.1.")).toBe(true);
      expect(isPrivateIp("[127.0.0.1.]")).toBe(true);
      // The boundary the module cares about: a public address stays public in the
      // same spelling.
      expect(isPrivateIp("8.8.8.8.")).toBe(false);
      expect(isPrivateIp("1.1.1.1.")).toBe(false);
    });

    it("ignores case", () => {
      // Not meaningful for decimal IPv4, but the normalizer is shared with IPv6.
      expect(isPrivateIp("0X7F.0.0.1")).toBe(true);
    });

    it("rejects out-of-range and malformed components rather than truncating them", () => {
      expect(isPrivateIp("999.1.1.1")).toBe(false);
      expect(isPrivateIp("1.2.3.4.5")).toBe(false);
      expect(isPrivateIp("abc.def.ghi.jkl")).toBe(false);
      expect(isPrivateIp("127.0.0.-1")).toBe(false);
      expect(isPrivateIp("")).toBe(false);
    });
  });

  describe("isPrivateIp: IPv6", () => {
    it("rejects the unspecified and loopback addresses in every compression", () => {
      expect(isPrivateIp("::")).toBe(true);
      expect(isPrivateIp("::1")).toBe(true);
      expect(isPrivateIp("0:0:0:0:0:0:0:0")).toBe(true);
      expect(isPrivateIp("0:0:0:0:0:0:0:1")).toBe(true);
      expect(isPrivateIp("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
    });

    it("rejects link-local and unique-local ranges", () => {
      expect(isPrivateIp("fe80::1")).toBe(true);
      expect(isPrivateIp("febf::1")).toBe(true);
      expect(isPrivateIp("fc00::1")).toBe(true);
      expect(isPrivateIp("fd00::1")).toBe(true);
      expect(isPrivateIp("FE80::1")).toBe(true);
    });

    it("rejects the documentation range", () => {
      expect(isPrivateIp("2001:db8::1")).toBe(true);
    });

    it("rejects IPv4-mapped loopback in dotted-quad and hextet spelling", () => {
      // The classic SSRF bypass. The URL serializer rewrites the dotted-quad form to
      // hextets, so both spellings have to land on the mapped-branch.
      expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
      expect(isPrivateIp("0:0:0:0:0:ffff:7f00:1")).toBe(true);
      expect(isPrivateIp("[::ffff:127.0.0.1]")).toBe(true);
    });

    it("rejects IPv4-mapped private addresses but admits a mapped public one", () => {
      expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateIp("::ffff:192.168.0.1")).toBe(true);
      // The embedded address is re-checked against the IPv4 table rather than
      // trusted to be public — so a genuinely public mapping is not private.
      expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    });

    it("rejects IPv4-compatible IPv6, which maps onto the IPv4 table", () => {
      // `::127.0.0.1` is the RFC 4291 IPv4-compatible form (deprecated, but every
      // major stack still resolves it to 127.0.0.1). It is a different spelling
      // from `::ffff:127.0.0.1` — no ffff hextet — and the URL serializer rewrites
      // the dotted-quad tail to hextets as `::7f00:1`, so both spellings must land
      // on the compatible branch.
      expect(isPrivateIp("::127.0.0.1")).toBe(true);
      expect(isPrivateIp("::7f00:1")).toBe(true);
      expect(isPrivateIp("0:0:0:0:0:0:7f00:1")).toBe(true);
      expect(isPrivateIp("[::127.0.0.1]")).toBe(true);
      // The boundary: a compatible address embedding a public one is not private.
      expect(isPrivateIp("::8.8.8.8")).toBe(false);
    });

    it("rejects mapped and compatible forms carrying a zone index", () => {
      // A scope ID names an interface, not a different address — and the URL
      // parser rejects the `%` outright, so the bare helper is the only place
      // this spelling can ever be seen.
      expect(isPrivateIp("::ffff:127.0.0.1%eth0")).toBe(true);
      expect(isPrivateIp("::127.0.0.1%25")).toBe(true);
      expect(isPrivateIp("fe80::1%eth0")).toBe(true);
      // The boundary: a zoned public embedded address stays public.
      expect(isPrivateIp("::ffff:8.8.8.8%eth0")).toBe(false);
    });

    it("rejects NAT64-wrapped and 6to4-wrapped private IPv4 addresses", () => {
      expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true); // RFC 6052 well-known prefix
      expect(isPrivateIp("64:ff9b:1::1")).toBe(true); // RFC 8215 local-use
      expect(isPrivateIp("2002:7f00:1::1")).toBe(true); // 6to4 wrapping 127.0.0.1
    });

    it("admits NAT64 and 6to4 wrappers around a public IPv4 address", () => {
      expect(isPrivateIp("64:ff9b::808:808")).toBe(false);
      expect(isPrivateIp("2002:0808:0808::1")).toBe(false);
    });

    it("admits a global unicast public address", () => {
      expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateIp("2a00:1450:4001:80f::200e")).toBe(false);
    });

    it("does not flag IPv6 multicast, which the table omits", () => {
      // ff00::/8 is not covered by any branch of isPrivateIpv6; as with IPv4
      // multicast, this is a gap in the table, not a parsing failure.
      expect(isPrivateIp("ff02::1")).toBe(false);
    });

    it("rejects malformed IPv6 rather than guessing at it", () => {
      expect(isPrivateIp("1:2:3:4:5:6:7:8:9")).toBe(false); // too many groups
      expect(isPrivateIp("1:2:3:4:5:6:7")).toBe(false); // too few, no ::
      expect(isPrivateIp("gggg::1")).toBe(false);
      expect(isPrivateIp("::ffff:")).toBe(false);
      expect(isPrivateIp("1:2::3::4")).toBe(false); // two :: compressions
    });

    it("fail-closes a degenerate compression to the unspecified address", () => {
      // ":::" is not a valid address, but the splitter sees only one "::" and
      // yields eight zero hextets — so it is treated as `::` and rejected. A
      // malformed guess lands on the private side of the line, which is the safe
      // direction for an SSRF check to err in.
      expect(isPrivateIp(":::")).toBe(true);
    });
  });

  describe("isPrivateIp: hostnames", () => {
    it("rejects localhost and the .localhost domain", () => {
      expect(isPrivateIp("localhost")).toBe(true);
      expect(isPrivateIp("LOCALHOST")).toBe(true);
      expect(isPrivateIp("foo.localhost")).toBe(true);
      expect(isPrivateIp("a.b.localhost")).toBe(true);
    });

    it("does not reject a host that merely contains the localhost string", () => {
      expect(isPrivateIp("localhost.com")).toBe(false);
      expect(isPrivateIp("localhost.evil.com")).toBe(false);
      expect(isPrivateIp("notlocalhost")).toBe(false);
    });

    it("leaves ordinary hostnames to the caller's DNS policy", () => {
      // This function answers "is this *spelled* private" — no resolution, so no
      // TOCTOU window between the check and the connect.
      expect(isPrivateIp("example.com")).toBe(false);
      expect(isPrivateIp("metadata.google.internal")).toBe(false);
      expect(isPrivateIp("evil.com")).toBe(false);
    });
  });

  describe("validateAllowList", () => {
    it("reports no errors for a well-formed list", () => {
      expect(validateAllowList(["https://example.com", "https://other.com/api"])).toEqual([]);
      expect(validateAllowList([{ url: "https://example.com" }])).toEqual([]);
      // Privacy is decideEgress's concern, not the validator's: a private host is a
      // syntactically valid entry.
      expect(validateAllowList(["http://127.0.0.1:8080"])).toEqual([]);
    });

    it("reports each malformed URL rather than silently dropping it", () => {
      const errors = validateAllowList(["https://example.com", "not-a-url", "://broken"]);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatch(/Invalid URL in allow-list: "not-a-url"/);
      expect(errors[1]).toMatch(/Invalid URL in allow-list: ":\/\/broken"/);
    });

    it("rejects non-http(s) schemes", () => {
      expect(validateAllowList(["file:///etc/passwd"])).toEqual([
        'Only http and https URLs are allowed in allow-list: "file:///etc/passwd"',
      ]);
      expect(validateAllowList(["ftp://example.com"])[0]).toMatch(/Only http and https/);
    });

    it("rejects entries that are neither a string nor a { url } object", () => {
      const errors = validateAllowList([
        null,
        42,
        {},
        { url: 5 },
        { url: null },
        { href: "https://example.com" },
      ] as unknown as AllowedUrlEntry[]);
      expect(errors).toHaveLength(6);
      for (const error of errors) {
        expect(error).toBe(
          'Invalid allow-list entry: must be a string URL or an object with a "url" string property',
        );
      }
    });

    it("rejects ambiguous path separators inside an entry's path", () => {
      expect(validateAllowList(["https://example.com/a%2fb"])[0]).toMatch(
        /Allow-list entry contains ambiguous path separators: "https:\/\/example\.com\/a%2fb"/,
      );
      expect(validateAllowList(["https://example.com/a%2e%2e"])[0]).toMatch(
        /ambiguous path separators/,
      );
    });

    it("flags query strings and fragments instead of honouring them", () => {
      expect(validateAllowList(["https://example.com/?a=1"])[0]).toMatch(
        /Query strings and fragments are ignored in allow-list entries/,
      );
      expect(validateAllowList(["https://example.com/#frag"])[0]).toMatch(
        /Query strings and fragments are ignored/,
      );
    });

    it("returns an empty array for an empty list, and never throws", () => {
      expect(validateAllowList([])).toEqual([]);
      expect(() => validateAllowList(["not-a-url", "file:///etc/passwd"])).not.toThrow();
    });
  });

  describe("decideEgress", () => {
    it("allows a public URL that is on the allow-list", () => {
      const decision = decideEgress("https://example.com/api/v1", ["https://example.com"]);
      expect(decision).toEqual({
        allowed: true,
        reason: "allowed by egress allow-list",
        url: "https://example.com/api/v1",
        privateAddress: false,
      });
    });

    it("denies a public URL that is not on the allow-list", () => {
      const decision = decideEgress("https://example.com/", ["https://other.com"]);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("target is not on the egress allow-list");
      expect(decision.privateAddress).toBe(false);
      // The URL is normalized in the decision record.
      expect(decision.url).toBe("https://example.com/");
    });

    it("denies a private address that IS on the allow-list, and says which check won", () => {
      // Privacy is checked before the allow-list, so a private entry cannot be used
      // to authorize reaching it.
      const decision = decideEgress("http://127.0.0.1:8080/", ["http://127.0.0.1:8080"]);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("target resolves to a private or special-use address");
      expect(decision.privateAddress).toBe(true);
    });

    it("catches an obfuscated private IPv4 after URL normalization", () => {
      // The WHATWG parser normalizes 0177.0.0.1 / 2130706433 / 0x7f.1 to decimal
      // before the hostname is ever handed to isPrivateIp.
      expect(decideEgress("http://0177.0.0.1/", ["http://0177.0.0.1"]).privateAddress).toBe(true);
      expect(decideEgress("http://2130706433/", ["http://2130706433"]).privateAddress).toBe(true);
      expect(decideEgress("http://0x7f.1/", ["http://0x7f.1"]).privateAddress).toBe(true);
    });

    it("catches IPv4-mapped IPv6 loopback", () => {
      const decision = decideEgress("http://[::ffff:127.0.0.1]/", ["http://[::ffff:127.0.0.1]"]);
      expect(decision.privateAddress).toBe(true);
      expect(decision.allowed).toBe(false);
    });

    it("catches IPv4-compatible IPv6 loopback", () => {
      // The URL serializer rewrites the dotted-quad tail to hextets, so this is the
      // shape the check actually sees on the wire.
      expect(decideEgress("http://[::127.0.0.1]/", ["http://[::127.0.0.1]"]).privateAddress).toBe(
        true,
      );
      expect(decideEgress("http://[::7f00:1]/", ["http://[::7f00:1]"]).privateAddress).toBe(true);
    });

    it("catches localhost and link-local metadata endpoints", () => {
      expect(decideEgress("http://localhost:3000/", ["http://localhost:3000"]).privateAddress).toBe(
        true,
      );
      expect(
        decideEgress("http://169.254.169.254/latest/meta-data/", ["http://169.254.169.254/"])
          .allowed,
      ).toBe(false);
    });

    it("reports an unparseable URL without throwing", () => {
      const decision = decideEgress("this is not a url", ["https://example.com"]);
      expect(decision).toEqual({
        allowed: false,
        reason: "unparseable URL",
        url: "this is not a url",
        privateAddress: false,
      });
    });

    it("admits a mapped-IPv6 wrapper around a public address when the origin is allowed", () => {
      const decision = decideEgress("http://[::ffff:8.8.8.8]/", ["http://[::ffff:8.8.8.8]"]);
      expect(decision.privateAddress).toBe(false);
      expect(decision.allowed).toBe(true);
    });
  });
});
