import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  coupons,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refunds,
  RefundState,
  RefundStatus,
  UserRole,
  users,
  videoWatchEvents,
} from "~/db/schema";

// ─── Refunds ───
// Every rule about Refund Requests and Refunds lives here. Vocabulary follows
// GLOSSARY.md; the reasoning behind pausing access is in
// docs/adr/0001-pause-access-during-open-refund-request.md.
//
// Uses positional parameters (project convention).

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();
  return row?.count ?? 0;
}

/** Counts every purchase's worth of watching, not just the latest one. */
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();
  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// The window is counted in whole calendar days — a purchase at 23:00 still
// gets all of its fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      amount: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: string };

/**
 * May this learner raise a Refund Request on their latest purchase of the
 * course right now? The course page and the refund action both ask this.
 */
export function checkRefundEligibility(
  userId: number,
  courseId: number,
  now: Date
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) {
    return { eligible: false, reason: "You have not bought this course." };
  }

  // One undecided request per purchase, and an approved one already settles it.
  const blockingRequest = db
    .select({ status: refunds.status })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchase.id),
        inArray(refunds.status, [RefundStatus.Open, RefundStatus.Approved])
      )
    )
    .get();
  if (blockingRequest?.status === RefundStatus.Open) {
    return {
      eligible: false,
      reason: "You already have an open refund request on this purchase.",
    };
  }
  if (blockingRequest?.status === RefundStatus.Approved) {
    return {
      eligible: false,
      reason: "This purchase has already been approved for a refund.",
    };
  }

  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchase.id), isNotNull(coupons.redeemedAt))
    )
    .get();
  if (claimedSeat) {
    return { eligible: false, reason: "A claimed team seat cannot be refunded." };
  }

  const lastDayInWindow = lastDayOfWindow(purchase.createdAt);
  if (calendarDay(now) > lastDayInWindow) {
    return {
      eligible: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day Refund Window has closed.`,
    };
  }

  const lessonIds = getCourseLessonIds(courseId);
  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return {
      eligible: false,
      reason: "You have completed too much of this course to request a refund.",
    };
  }

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched too much of this course to request a refund.",
    };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow,
  };
}

export type RaiseResult =
  | { ok: true; refundRequestId: number; amount: number }
  | { ok: false; reason: string };

/** Opens a Refund Request on the learner's latest purchase of the course. */
export function raiseRefundRequest(
  userId: number,
  courseId: number,
  reason: string,
  now: Date
): RaiseResult {
  const eligibility = checkRefundEligibility(userId, courseId, now);
  if (!eligibility.eligible) {
    return { ok: false, reason: eligibility.reason };
  }

  const request = db
    .insert(refunds)
    .values({
      purchaseId: eligibility.purchaseId,
      status: RefundStatus.Open,
      reason,
      requestedAt: now.toISOString(),
    })
    .returning()
    .get();

  return { ok: true, refundRequestId: request.id, amount: eligibility.amount };
}

export type CourseAccessHold = "paused" | "ended" | null;

/**
 * Whether a Refund Request stops this learner from opening the course, judged
 * on their latest purchase of it. Course Progress is untouched either way.
 */
export function getCourseAccessHold(
  userId: number,
  courseId: number
): CourseAccessHold {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return null;

  const holding = db
    .select({ status: refunds.status, refundState: refunds.refundState })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchase.id),
        inArray(refunds.status, [RefundStatus.Open, RefundStatus.Approved])
      )
    )
    .get();

  if (!holding) return null;
  if (holding.refundState === RefundState.Issued) return "ended";
  return "paused";
}

/** The learner's Open Refund Request on their latest purchase, if any. */
export function findOpenRefundRequestId(
  userId: number,
  courseId: number
): number | null {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return null;
  const open = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchase.id),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .get();
  return open?.id ?? null;
}

export type RefundActionResult = { ok: true } | { ok: false; reason: string };

function getRequestWithOwner(refundRequestId: number) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      refundState: refunds.refundState,
      learnerId: purchases.userId,
      amountPaid: purchases.amountPaid,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
}

/**
 * The learner takes back their own Open Refund Request. Like every change
 * here, it only lands if the request is still in the state it expects, so a
 * withdrawal and an Admin's decision can't both win.
 */
export function withdrawRefundRequest(
  userId: number,
  refundRequestId: number
): RefundActionResult {
  const request = getRequestWithOwner(refundRequestId);
  if (!request || request.learnerId !== userId) {
    return { ok: false, reason: "Refund request not found." };
  }

  const updated = db
    .update(refunds)
    .set({ status: RefundStatus.Withdrawn })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .returning({ id: refunds.id })
    .all();

  if (updated.length === 0) {
    return {
      ok: false,
      reason: "This refund request has already been decided.",
    };
  }
  return { ok: true };
}

// ─── Admin decisions ───

function authorizeDecision(
  adminId: number,
  request: ReturnType<typeof getRequestWithOwner>
): { ok: false; reason: string } | null {
  const actor = db.select().from(users).where(eq(users.id, adminId)).get();
  if (!actor || actor.role !== UserRole.Admin) {
    return { ok: false, reason: "Only Admins can decide Refund Requests." };
  }
  if (!request) {
    return { ok: false, reason: "Refund request not found." };
  }
  if (request.learnerId === adminId) {
    return {
      ok: false,
      reason: "You cannot decide a Refund Request on your own purchase.",
    };
  }
  return null;
}

const NO_LONGER_OPEN = {
  ok: false as const,
  reason: "This refund request is no longer open — it was withdrawn or already decided.",
};

/** Approves an Open Refund Request, which creates a Pending Refund. */
export function approveRefundRequest(
  adminId: number,
  refundRequestId: number,
  now: Date
): RefundActionResult {
  const request = getRequestWithOwner(refundRequestId);
  const refusal = authorizeDecision(adminId, request);
  if (refusal) return refusal;

  const updated = db
    .update(refunds)
    .set({
      status: RefundStatus.Approved,
      refundState: RefundState.Pending,
      amountRefunded: request!.amountPaid,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
    })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .returning({ id: refunds.id })
    .all();

  return updated.length === 0 ? NO_LONGER_OPEN : { ok: true };
}

/** Declines an Open Refund Request. The reason is what the learner is told. */
export function declineRefundRequest(
  adminId: number,
  refundRequestId: number,
  declineReason: string,
  now: Date
): RefundActionResult {
  const request = getRequestWithOwner(refundRequestId);
  const refusal = authorizeDecision(adminId, request);
  if (refusal) return refusal;

  const trimmed = declineReason.trim();
  if (!trimmed) {
    return { ok: false, reason: "Give the learner a reason for declining." };
  }

  const updated = db
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineReason: trimmed,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
    })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .returning({ id: refunds.id })
    .all();

  return updated.length === 0 ? NO_LONGER_OPEN : { ok: true };
}

function moveRefundState(
  adminId: number,
  refundRequestId: number,
  from: RefundState[],
  to: RefundState
): RefundActionResult {
  const request = getRequestWithOwner(refundRequestId);
  const refusal = authorizeDecision(adminId, request);
  if (refusal) return refusal;

  const updated = db
    .update(refunds)
    .set({ refundState: to })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Approved),
        inArray(refunds.refundState, from)
      )
    )
    .returning({ id: refunds.id })
    .all();

  if (updated.length === 0) {
    return {
      ok: false,
      reason: "This Refund has changed since you loaded the page.",
    };
  }
  return { ok: true };
}

/** The money has been confirmed as sent. The learner's access ends. */
export function markRefundIssued(adminId: number, refundRequestId: number) {
  return moveRefundState(
    adminId,
    refundRequestId,
    [RefundState.Pending],
    RefundState.Issued
  );
}

/** The money couldn't be sent. The approval stands and access stays paused. */
export function markRefundFailed(adminId: number, refundRequestId: number) {
  return moveRefundState(
    adminId,
    refundRequestId,
    [RefundState.Pending],
    RefundState.Failed
  );
}

/** Try a Failed Refund again: it becomes a Pending Refund once more. */
export function retryRefund(adminId: number, refundRequestId: number) {
  return moveRefundState(
    adminId,
    refundRequestId,
    [RefundState.Failed],
    RefundState.Pending
  );
}

// ─── What the Admin refund screen shows ───

const learners = users;

function refundRows() {
  return db
    .select({
      refundRequestId: refunds.id,
      status: refunds.status,
      refundState: refunds.refundState,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      amount: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: learners.id,
      learnerName: learners.name,
      learnerEmail: learners.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(learners, eq(purchases.userId, learners.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id));
}

/** Pending Refunds and Failed Refunds: approved, money not yet confirmed sent. */
export function listPendingRefunds() {
  return refundRows()
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        inArray(refunds.refundState, [RefundState.Pending, RefundState.Failed])
      )
    )
    .orderBy(refunds.resolvedAt)
    .all();
}

function daysBetween(fromDay: string, toDay: string) {
  const ms =
    new Date(`${toDay}T00:00:00Z`).getTime() -
    new Date(`${fromDay}T00:00:00Z`).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function earlierRequestsFor(
  learnerId: number,
  courseId: number,
  excludeRefundRequestId: number
) {
  return db
    .select({
      refundRequestId: refunds.id,
      status: refunds.status,
      refundState: refunds.refundState,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.userId, learnerId),
        eq(purchases.courseId, courseId),
        sql`${refunds.id} <> ${excludeRefundRequestId}`
      )
    )
    .orderBy(refunds.requestedAt)
    .all();
}

/**
 * Open Refund Requests, oldest first, with what an Admin needs to decide:
 * the learner's Course Progress against the limits, how long is left in the
 * Refund Window, and their earlier requests on the same course.
 */
export function listOpenRefundRequests(now: Date) {
  const today = calendarDay(now);

  return refundRows()
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(refunds.requestedAt)
    .all()
    .map((row) => {
      const lessonIds = getCourseLessonIds(row.courseId);
      return {
        ...row,
        secondsWatched: getSecondsWatched(row.learnerId, lessonIds),
        completedLessons: getCompletedLessonCount(row.learnerId, lessonIds),
        totalLessons: lessonIds.length,
        daysLeftInWindow: Math.max(
          0,
          daysBetween(today, lastDayOfWindow(row.purchasedAt))
        ),
        earlierRequests: earlierRequestsFor(
          row.learnerId,
          row.courseId,
          row.refundRequestId
        ),
      };
    });
}
