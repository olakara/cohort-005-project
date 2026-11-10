import { describe, it, expect } from "vitest";
import { checkRefundPolicy, type RefundPolicyFacts } from "./refund-policy";

const eligibleFacts: RefundPolicyFacts = {
  purchasedAt: new Date(2026, 10, 1, 23, 0),
  today: new Date(2026, 10, 5, 9, 0),
  amountPaid: 4900,
  secondsWatched: 0,
  lessonsCompleted: 0,
  lessonCount: 10,
  hasClaimedTeamSeat: false,
  hasOpenRefundRequest: false,
};

describe("checkRefundPolicy", () => {
  it("offers a Refund of the amount paid inside the Refund Window", () => {
    expect(checkRefundPolicy(eligibleFacts)).toEqual({
      eligible: true,
      amount: 4900,
      lastDayOfRefundWindow: "2026-11-15",
    });
  });

  it("refunds the amount paid even when the course has since been re-priced", () => {
    const result = checkRefundPolicy({ ...eligibleFacts, amountPaid: 1234 });
    expect(result).toMatchObject({ eligible: true, amount: 1234 });
  });

  it("still allows the whole of the fourteenth day", () => {
    const result = checkRefundPolicy({
      ...eligibleFacts,
      today: new Date(2026, 10, 15, 23, 59),
    });
    expect(result.eligible).toBe(true);
  });

  it("closes the Refund Window on the fifteenth day", () => {
    const result = checkRefundPolicy({
      ...eligibleFacts,
      today: new Date(2026, 10, 16, 0, 1),
    });
    expect(result).toEqual({
      eligible: false,
      reason: "refund-window-closed",
      message:
        "Refunds are available for 14 days after purchase. Yours closed on 2026-11-15.",
    });
  });

  it("declines once 2 hours have been watched", () => {
    const result = checkRefundPolicy({
      ...eligibleFacts,
      secondsWatched: 2 * 60 * 60,
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: "watched-too-much",
    });
  });

  it("declines once half the lessons are completed", () => {
    const result = checkRefundPolicy({ ...eligibleFacts, lessonsCompleted: 5 });
    expect(result).toMatchObject({
      eligible: false,
      reason: "completed-too-much",
    });
  });

  it("allows just under half the lessons completed", () => {
    const result = checkRefundPolicy({ ...eligibleFacts, lessonsCompleted: 4 });
    expect(result.eligible).toBe(true);
  });

  it("ignores the completion limit for a course with no lessons", () => {
    const result = checkRefundPolicy({ ...eligibleFacts, lessonCount: 0 });
    expect(result.eligible).toBe(true);
  });

  it("declines a claimed team seat", () => {
    const result = checkRefundPolicy({
      ...eligibleFacts,
      hasClaimedTeamSeat: true,
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: "claimed-team-seat",
    });
  });

  it("reports an open Refund Request before any other reason", () => {
    const result = checkRefundPolicy({
      ...eligibleFacts,
      hasOpenRefundRequest: true,
      hasClaimedTeamSeat: true,
      today: new Date(2026, 11, 30),
    });
    expect(result).toMatchObject({
      eligible: false,
      reason: "refund-request-open",
    });
  });
});
