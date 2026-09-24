import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "http";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { AuthLimiter, bearerMatches, clientAddress, isValidObjectId, parseSeq, safeEqual } from "../auth";

describe("safeEqual", () => {
  it("matches equal strings and rejects different ones, including different lengths", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("secret", "secret-longer")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("bearerMatches requires the Bearer scheme", () => {
    expect(bearerMatches("Bearer t0k", "t0k")).toBe(true);
    expect(bearerMatches("bearer t0k", "t0k")).toBe(false);
    expect(bearerMatches("t0k", "t0k")).toBe(false);
    expect(bearerMatches(undefined, "t0k")).toBe(false);
  });

  it("no server module compares the auth token with === or !==", () => {
    const dir = join(__dirname, "..");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, file).not.toMatch(/[!=]==\s*[^;\n]*authToken|authToken[^;\n]*[!=]==/);
    }
  });
});

describe("AuthLimiter", () => {
  function limiterAt(start = 0) {
    let now = start;
    const limiter = new AuthLimiter({ now: () => now });
    return { limiter, advance: (ms: number) => (now += ms) };
  }

  it("locks out after 10 failures in a minute", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 9; i++) limiter.recordFailure("a");
    expect(limiter.retryAfterMs("a")).toBe(0);
    limiter.recordFailure("a");
    expect(limiter.retryAfterMs("a")).toBe(60_000);
    expect(limiter.retryAfterMs("b")).toBe(0);
  });

  it("does not count failures older than the window", () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 9; i++) limiter.recordFailure("a");
    advance(61_000);
    limiter.recordFailure("a");
    expect(limiter.retryAfterMs("a")).toBe(0);
  });

  it("doubles each lockout up to 15 minutes", () => {
    const { limiter, advance } = limiterAt();
    const lengths: number[] = [];
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 10; i++) limiter.recordFailure("a");
      const wait = limiter.retryAfterMs("a");
      lengths.push(wait);
      advance(wait);
    }
    expect(lengths).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it("a success clears the key", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 10; i++) limiter.recordFailure("a");
    limiter.recordSuccess("a");
    expect(limiter.retryAfterMs("a")).toBe(0);
    expect(limiter.size).toBe(0);
  });

  it("evicts idle keys", () => {
    const { limiter, advance } = limiterAt(1_000_000);
    limiter.recordFailure("a");
    advance(31 * 60_000);
    limiter.retryAfterMs("x");
    expect(limiter.size).toBe(0);
  });
});

describe("clientAddress", () => {
  const req = (xff?: string) =>
    ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;

  it("ignores X-Forwarded-For unless the proxy is trusted", () => {
    expect(clientAddress(req("1.2.3.4"), false)).toBe("10.0.0.1");
    expect(clientAddress(req("1.2.3.4, 5.6.7.8"), true)).toBe("1.2.3.4");
    expect(clientAddress(req(), true)).toBe("10.0.0.1");
  });
});

describe("isValidObjectId", () => {
  it.each([
    "doc:01920000-0000-7000-8000-000000000000",
    "vault:local",
    "vault-root",
    "12@9876543210",
    "12@9876543210~0123456789ab",
  ])("accepts %s", (id) => expect(isValidObjectId(id)).toBe(true));

  it.each(["", "..", "a/../b", "a/b", "a\u0000b", "%2e%2e", "-leading", "x".repeat(129), " spaced"])(
    "rejects %j",
    (id) => expect(isValidObjectId(id)).toBe(false),
  );
});

describe("parseSeq", () => {
  it("accepts non-negative integers and treats missing as 0", () => {
    expect(parseSeq(null)).toBe(0);
    expect(parseSeq("")).toBe(0);
    expect(parseSeq("42")).toBe(42);
  });

  it.each(["-1", "1.5", "abc", "1e3", "99999999999999999"])("rejects %s", (v) => {
    expect(parseSeq(v)).toBeNull();
  });
});
