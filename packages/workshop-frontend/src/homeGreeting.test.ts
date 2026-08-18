import { describe, expect, it } from "vitest";
import {
  addDays,
  attentionGreeting,
  dayStart,
  firstNameOf,
  glanceDateLabel,
  glanceRange,
  isSameCalendarDay,
} from "./homeGreeting";

describe("attentionGreeting", () => {
  it("uses the first name", () => {
    expect(firstNameOf("Dallen Pyrah")).toBe("Dallen");
    expect(attentionGreeting("Dallen Pyrah")).toBe("What needs attention, Dallen?");
  });

  it("omits the comma when no name is available", () => {
    expect(attentionGreeting("")).toBe("What needs attention?");
    expect(attentionGreeting(null)).toBe("What needs attention?");
  });
});

describe("glanceDateLabel", () => {
  it("formats weekday, month, and day", () => {
    expect(glanceDateLabel(new Date("2026-08-18T15:00:00"), "en-US")).toBe(
      "Tuesday, August 18",
    );
  });
});

describe("glanceRange", () => {
  it("spans local yesterday through the start of tomorrow", () => {
    const now = new Date("2026-08-18T15:30:00");
    const { from, to } = glanceRange(now);
    expect(from).toEqual(dayStart(addDays(now, -1)));
    expect(to).toEqual(dayStart(addDays(now, 1)));
    expect(isSameCalendarDay(from, addDays(now, -1))).toBe(true);
    expect(isSameCalendarDay(to, addDays(now, 1))).toBe(true);
  });
});
