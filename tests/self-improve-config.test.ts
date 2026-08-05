import { describe, it, expect, afterEach } from "vitest";

import { resolveSelfImproveConfig } from "../src/self-improve/config.js";

const ENV = "SWITCHROOM_SELF_IMPROVE_T1_MAX_GROWTH_BYTES";

afterEach(() => {
  delete process.env[ENV];
});

describe("resolveSelfImproveConfig — t1MaxGrowthBytes", () => {
  it("defaults to 4096 bytes when the env is unset", () => {
    delete process.env[ENV];
    expect(resolveSelfImproveConfig().t1MaxGrowthBytes).toBe(4096);
  });

  it("honours a positive env override", () => {
    process.env[ENV] = "1024";
    expect(resolveSelfImproveConfig().t1MaxGrowthBytes).toBe(1024);
  });

  it("accepts 0 (no growth allowed)", () => {
    process.env[ENV] = "0";
    expect(resolveSelfImproveConfig().t1MaxGrowthBytes).toBe(0);
  });

  it("falls back to the default on a non-numeric / negative value", () => {
    process.env[ENV] = "not-a-number";
    expect(resolveSelfImproveConfig().t1MaxGrowthBytes).toBe(4096);
    process.env[ENV] = "-5";
    expect(resolveSelfImproveConfig().t1MaxGrowthBytes).toBe(4096);
  });
});
