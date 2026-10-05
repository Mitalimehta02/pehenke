import { describe, expect, it } from "vitest";
import { formatPhone, normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["(987) 654-3210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
    ["+44 7700 900123", "+447700900123"],
    ["+1 (415) 555-0100", "+14155550100"],
  ])("%s -> %s", (input, e164) => {
    expect(normalizePhone(input)).toBe(e164);
  });

  it.each([
    "",
    "hello",
    "12345",
    "1234567890", // Indian mobiles start with 6-9
    "5876543210",
    "+91 12345 67890",
    "+91 98765 4321", // too short
    "+1234567890123456", // more than 15 digits
    "98765 43210 ext 5",
    "+0 123 456 789",
  ])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("formats Indian numbers for display", () => {
    expect(formatPhone("+919876543210")).toBe("+91 98765 43210");
    expect(formatPhone("+447700900123")).toBe("+447700900123");
  });
});
