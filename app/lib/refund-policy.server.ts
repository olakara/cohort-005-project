import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { checkRefundPolicy, type RefundPolicyResult } from "./refund-policy";

export function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function hasOpenRefundRequest(purchaseId: number): boolean {
  const row = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
  return row !== undefined;
}

// A seat that came out of a team licence, and has been claimed, belongs to
// the team — the learner cannot hand it back on their own.
function hasClaimedTeamSeat(purchaseId: number): boolean {
  const row = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return row !== undefined;
}

function getLessonsCompleted(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;
  const result = db
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
  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;
  return db
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
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

/**
 * Applies the Refund Policy to the learner's latest Purchase of a course.
 * Returns null when there is no Purchase to refund.
 */
export function getRefundOffer(
  userId: number,
  courseId: number
): { purchaseId: number; result: RefundPolicyResult } | null {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return null;

  const lessonIds = getLessonIdsForCourse(courseId);

  const result = checkRefundPolicy({
    purchasedAt: new Date(purchase.createdAt),
    today: new Date(),
    amountPaid: purchase.amountPaid,
    secondsWatched: getSecondsWatched(userId, lessonIds),
    lessonsCompleted: getLessonsCompleted(userId, lessonIds),
    lessonCount: lessonIds.length,
    hasClaimedTeamSeat: hasClaimedTeamSeat(purchase.id),
    hasOpenRefundRequest: hasOpenRefundRequest(purchase.id),
  });

  return { purchaseId: purchase.id, result };
}
