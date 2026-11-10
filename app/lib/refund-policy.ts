/**
 * The Refund Policy: whether a Purchase can have a Refund Request raised
 * against it, and for how much. See GLOSSARY.md.
 *
 * Pure — the facts are gathered from the database in refund-policy.server.ts,
 * so the course page and the refund action always apply the same rules.
 */

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundPolicyFacts = {
  purchasedAt: Date;
  today: Date;
  amountPaid: number;
  secondsWatched: number;
  lessonsCompleted: number;
  lessonCount: number;
  hasClaimedTeamSeat: boolean;
  hasOpenRefundRequest: boolean;
};

export type RefundIneligibleReason =
  | "refund-request-open"
  | "claimed-team-seat"
  | "refund-window-closed"
  | "watched-too-much"
  | "completed-too-much";

export type RefundPolicyResult =
  | { eligible: true; amount: number; lastDayOfRefundWindow: string }
  | { eligible: false; reason: RefundIneligibleReason; message: string };

// The Refund Window is counted in whole calendar days, not hours — someone who
// buys at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function lastDayOfRefundWindow(purchasedAt: Date): string {
  const deadline = new Date(purchasedAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function ineligible(
  reason: RefundIneligibleReason,
  message: string
): RefundPolicyResult {
  return { eligible: false, reason, message };
}

export function checkRefundPolicy(
  facts: RefundPolicyFacts
): RefundPolicyResult {
  if (facts.hasOpenRefundRequest) {
    return ineligible(
      "refund-request-open",
      "Your refund request is awaiting review."
    );
  }

  if (facts.hasClaimedTeamSeat) {
    return ineligible(
      "claimed-team-seat",
      "This seat belongs to your team, so ask your team admin about a refund."
    );
  }

  const lastDay = lastDayOfRefundWindow(facts.purchasedAt);
  if (calendarDay(facts.today) > lastDay) {
    return ineligible(
      "refund-window-closed",
      `Refunds are available for ${REFUND_WINDOW_DAYS} days after purchase. Yours closed on ${lastDay}.`
    );
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return ineligible(
      "watched-too-much",
      "Refunds aren't available once you've watched 2 hours of a course."
    );
  }

  if (
    facts.lessonCount > 0 &&
    facts.lessonsCompleted / facts.lessonCount >= REFUND_COMPLETION_LIMIT
  ) {
    return ineligible(
      "completed-too-much",
      "Refunds aren't available once you've completed half the lessons."
    );
  }

  return {
    eligible: true,
    amount: facts.amountPaid,
    lastDayOfRefundWindow: lastDay,
  };
}
