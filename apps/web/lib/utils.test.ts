import { describe, expect, it } from "vitest";
import { formatLapTime } from "./utils";

describe("formatLapTime", () => {
  it("formats a sub-2-minute lap", () => {
    expect(formatLapTime(76.123)).toBe("1:16.123");
  });

  it("pads seconds correctly", () => {
    expect(formatLapTime(65.5)).toBe("1:05.500");
  });

  it("handles laps over 2 minutes", () => {
    expect(formatLapTime(125.001)).toBe("2:05.001");
  });
});
