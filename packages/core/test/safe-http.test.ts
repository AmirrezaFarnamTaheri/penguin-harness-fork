import { describe, it, expect } from "vitest";
import {
  isPrivateOrReservedIPv4,
  isPrivateOrReservedIPv6,
  isSafeIpAddress,
  validateSafeUrl,
} from "../src/internal/safe-http.js";

describe("SafeHttp SSRF Protection", () => {
  describe("isPrivateOrReservedIPv4", () => {
    it("identifies private and reserved IPv4 ranges", () => {
      // Loopback
      expect(isPrivateOrReservedIPv4("127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIPv4("127.255.255.255")).toBe(true);

      // Private Class A (10.0.0.0/8)
      expect(isPrivateOrReservedIPv4("10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIPv4("10.254.1.2")).toBe(true);

      // Private Class B (172.16.0.0/12)
      expect(isPrivateOrReservedIPv4("172.16.0.1")).toBe(true);
      expect(isPrivateOrReservedIPv4("172.31.255.255")).toBe(true);
      expect(isPrivateOrReservedIPv4("172.32.0.1")).toBe(false); // Outside private range

      // Private Class C (192.168.0.0/16)
      expect(isPrivateOrReservedIPv4("192.168.1.1")).toBe(true);

      // Link-Local / Cloud Metadata (169.254.0.0/16)
      expect(isPrivateOrReservedIPv4("169.254.169.254")).toBe(true);

      // Multicast / Reserved
      expect(isPrivateOrReservedIPv4("224.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIPv4("240.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIPv4("0.0.0.0")).toBe(true);
    });

    it("allows public IPv4 addresses", () => {
      expect(isPrivateOrReservedIPv4("8.8.8.8")).toBe(false);
      expect(isPrivateOrReservedIPv4("1.1.1.1")).toBe(false);
      expect(isPrivateOrReservedIPv4("93.184.216.34")).toBe(false);
    });
  });

  describe("isPrivateOrReservedIPv6", () => {
    it("identifies private and reserved IPv6 ranges", () => {
      expect(isPrivateOrReservedIPv6("::1")).toBe(true);
      expect(isPrivateOrReservedIPv6("fe80::1")).toBe(true);
      expect(isPrivateOrReservedIPv6("fc00::1")).toBe(true);
      expect(isPrivateOrReservedIPv6("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateOrReservedIPv6("ff02::1")).toBe(true);
    });

    it("allows public IPv6 addresses", () => {
      expect(isPrivateOrReservedIPv6("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateOrReservedIPv6("2001:4860:4860::8888")).toBe(false);
    });
  });

  describe("isSafeIpAddress", () => {
    it("checks safety according to localhost policy", () => {
      expect(isSafeIpAddress("127.0.0.1", false)).toBe(false);
      expect(isSafeIpAddress("127.0.0.1", true)).toBe(true);
      expect(isSafeIpAddress("10.0.0.1", true)).toBe(false); // 10.x still blocked even if localhost allowed
      expect(isSafeIpAddress("8.8.8.8", false)).toBe(true);
    });
  });

  describe("validateSafeUrl", () => {
    it("rejects non-http/https protocols", async () => {
      await expect(validateSafeUrl("file:///etc/passwd")).rejects.toThrow("Unsupported protocol");
      await expect(validateSafeUrl("ftp://ftp.example.com/file")).rejects.toThrow(
        "Unsupported protocol",
      );
      await expect(validateSafeUrl("javascript:alert(1)")).rejects.toThrow("Unsupported protocol");
    });

    it("blocks cloud metadata IP endpoints", async () => {
      await expect(validateSafeUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
        "Blocked SSRF destination",
      );
    });

    it("blocks localhost when allowLocalhost is false", async () => {
      await expect(validateSafeUrl("http://127.0.0.1:8080/api")).rejects.toThrow(
        "Blocked SSRF destination",
      );
      await expect(validateSafeUrl("http://localhost:3000")).rejects.toThrow("Access to localhost");
    });

    it("permits localhost when allowLocalhost is true", async () => {
      const res = await validateSafeUrl("http://127.0.0.1:8080/search", { allowLocalhost: true });
      expect(res.url.hostname).toBe("127.0.0.1");
    });

    it("honors an explicit allowedHosts exception without skipping address validation", async () => {
      const res = await validateSafeUrl("http://127.0.0.1:8080/api", {
        allowedHosts: ["127.0.0.1"],
      });
      expect(res.url.hostname).toBe("127.0.0.1");
      expect(res.resolvedIp).toBe("127.0.0.1");
    });
  });
});
