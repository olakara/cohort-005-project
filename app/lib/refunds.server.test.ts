import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

const {
  checkRefundEligibility,
  getCourseAccessHold,
  approveRefundRequest,
  declineRefundRequest,
  findOpenRefundRequestId,
  listOpenRefundRequests,
  listPendingRefunds,
  markRefundFailed,
  markRefundIssued,
  raiseRefundRequest,
  retryRefund,
  withdrawRefundRequest,
} = await import("./refunds.server");

const NOW = new Date("2026-11-10T12:00:00");

function daysBefore(when: Date, days: number) {
  const d = new Date(when);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;
let lessonIds: number[];

function buy(userId: number, purchasedDaysAgo: number, amountPaid = 7900) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid,
      createdAt: daysBefore(NOW, purchasedDaysAgo),
    })
    .returning()
    .get();
}

function watch(userId: number, lessonId: number, seconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId,
      lessonId,
      eventType: "progress",
      positionSeconds: seconds,
    })
    .run();
}

function complete(userId: number, lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  admin = testDb
    .insert(schema.users)
    .values({
      name: "Ada Admin",
      email: "admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("checkRefundEligibility", () => {
  it("offers the full amount paid on a fresh purchase", () => {
    buy(base.user.id, 2, 7900);

    const result = checkRefundEligibility(base.user.id, base.course.id, NOW);

    expect(result).toMatchObject({ eligible: true, amount: 7900 });
  });

  it("refuses once 50% of lessons are completed, even with little watched", () => {
    buy(base.user.id, 2);
    complete(base.user.id, lessonIds[0]);
    complete(base.user.id, lessonIds[1]);

    const result = checkRefundEligibility(base.user.id, base.course.id, NOW);

    expect(result).toMatchObject({ eligible: false });
  });

  it("refuses once 2 hours have been watched", () => {
    buy(base.user.id, 2);
    watch(base.user.id, lessonIds[0], 3600);
    watch(base.user.id, lessonIds[1], 3600);

    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: false });
  });

  it("counts watching from an earlier, refunded purchase", () => {
    // Watched 1.5h under the first purchase, refunded, bought again, then
    // another hour: 2.5h in all, even though only 1h is since this purchase.
    buy(base.user.id, 40);
    watch(base.user.id, lessonIds[0], 5400);
    buy(base.user.id, 2);
    watch(base.user.id, lessonIds[1], 3600);

    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: false });
  });

  it("allows the whole fourteenth day after purchase", () => {
    buy(base.user.id, 14);

    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: true });
  });

  it("refuses on the fifteenth day after purchase", () => {
    buy(base.user.id, 15);

    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: false });
  });
});

describe("raiseRefundRequest", () => {
  it("opens a Refund Request, after which the learner cannot raise another", () => {
    buy(base.user.id, 2);

    const first = raiseRefundRequest(
      base.user.id,
      base.course.id,
      "Not what I expected",
      NOW
    );
    const second = raiseRefundRequest(
      base.user.id,
      base.course.id,
      "Asking again",
      NOW
    );

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false });
    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: false });
  });
});

describe("getCourseAccessHold", () => {
  it("pauses access while a Refund Request is open", () => {
    buy(base.user.id, 2);
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBeNull();

    raiseRefundRequest(base.user.id, base.course.id, "Not for me", NOW);

    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
  });

  it("refuses anyone who is not an Admin, including the course's instructor", () => {
    buy(base.user.id, 2);
    const requestId = raise();

    expect(
      approveRefundRequest(base.instructor.id, requestId, NOW)
    ).toMatchObject({ ok: false });
    expect(listPendingRefunds()).toEqual([]);
  });

  it("refuses an Admin deciding their own Refund Request", () => {
    buy(admin.id, 2);
    const requestId = raise(admin.id);

    expect(approveRefundRequest(admin.id, requestId, NOW)).toMatchObject({
      ok: false,
    });
  });

  it("refuses to approve a request the learner has just withdrawn", () => {
    buy(base.user.id, 2);
    const requestId = raise();
    withdrawRefundRequest(base.user.id, requestId);

    expect(approveRefundRequest(admin.id, requestId, NOW)).toMatchObject({
      ok: false,
    });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBeNull();
  });

  it("refuses a learner withdrawing a request that is already approved", () => {
    buy(base.user.id, 2);
    const requestId = raise();
    approveRefundRequest(admin.id, requestId, NOW);

    expect(withdrawRefundRequest(base.user.id, requestId)).toMatchObject({
      ok: false,
    });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
  });
});

function raise(userId = base.user.id) {
  const result = raiseRefundRequest(userId, base.course.id, "Not for me", NOW);
  if (!result.ok) throw new Error(result.reason);
  return result.refundRequestId;
}

describe("withdrawRefundRequest", () => {
  it("gives access back straight away, and lets the learner ask again", () => {
    buy(base.user.id, 2);
    const requestId = raise();

    const result = withdrawRefundRequest(base.user.id, requestId);

    expect(result).toMatchObject({ ok: true });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBeNull();
    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: true });
  });

  it("is found by the learner's course, so the course page can offer Withdraw", () => {
    buy(base.user.id, 2);
    expect(findOpenRefundRequestId(base.user.id, base.course.id)).toBeNull();

    const requestId = raise();

    expect(findOpenRefundRequestId(base.user.id, base.course.id)).toBe(
      requestId
    );
  });

  it("refuses to withdraw someone else's Refund Request", () => {
    buy(base.user.id, 2);
    const requestId = raise();

    const result = withdrawRefundRequest(base.instructor.id, requestId);

    expect(result).toMatchObject({ ok: false });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
  });
});

describe("approveRefundRequest", () => {
  it("creates a Pending Refund for the full amount, and access stays paused", () => {
    buy(base.user.id, 2, 7900);
    const requestId = raise();

    const result = approveRefundRequest(admin.id, requestId, NOW);

    expect(result).toMatchObject({ ok: true });
    expect(listPendingRefunds()).toMatchObject([
      { refundRequestId: requestId, amount: 7900, refundState: "pending" },
    ]);
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
  });
});

describe("declineRefundRequest", () => {
  it("gives access back and lets the learner ask again inside the window", () => {
    buy(base.user.id, 2);
    const requestId = raise();

    const result = declineRefundRequest(
      admin.id,
      requestId,
      "You have used the downloadable materials.",
      NOW
    );

    expect(result).toMatchObject({ ok: true });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBeNull();
    expect(
      checkRefundEligibility(base.user.id, base.course.id, NOW)
    ).toMatchObject({ eligible: true });
  });

  it("needs a reason to tell the learner", () => {
    buy(base.user.id, 2);
    const requestId = raise();

    expect(declineRefundRequest(admin.id, requestId, "   ", NOW)).toMatchObject(
      { ok: false }
    );
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
  });

  it("cannot overturn an approval", () => {
    buy(base.user.id, 2);
    const requestId = raise();
    approveRefundRequest(admin.id, requestId, NOW);

    expect(
      declineRefundRequest(admin.id, requestId, "Changed my mind", NOW)
    ).toMatchObject({ ok: false });
    expect(listPendingRefunds()).toHaveLength(1);
  });
});

describe("recording what happened to the money", () => {
  function approved() {
    buy(base.user.id, 2);
    const requestId = raise();
    approveRefundRequest(admin.id, requestId, NOW);
    return requestId;
  }

  it("ends access once the Refund is Issued, and it leaves the pending list", () => {
    const requestId = approved();

    expect(markRefundIssued(admin.id, requestId)).toMatchObject({
      ok: true,
    });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("ended");
    expect(listPendingRefunds()).toEqual([]);
  });

  it("keeps access paused on a Failed Refund, and a retry makes it Pending again", () => {
    const requestId = approved();

    markRefundFailed(admin.id, requestId);
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
    expect(listPendingRefunds()).toMatchObject([{ refundState: "failed" }]);

    expect(retryRefund(admin.id, requestId)).toMatchObject({ ok: true });
    expect(listPendingRefunds()).toMatchObject([{ refundState: "pending" }]);
  });

  it("cannot mark an Open Refund Request as Issued", () => {
    buy(base.user.id, 2);
    const requestId = raise();

    expect(markRefundIssued(admin.id, requestId)).toMatchObject({
      ok: false,
    });
    expect(getCourseAccessHold(base.user.id, base.course.id)).toBe("paused");
  });

  it("lets the learner buy again and get their access back", () => {
    const requestId = approved();
    markRefundIssued(admin.id, requestId);

    buy(base.user.id, 0);

    expect(getCourseAccessHold(base.user.id, base.course.id)).toBeNull();
  });
});

describe("listOpenRefundRequests", () => {
  it("lists the oldest first, with Course Progress and earlier requests", () => {
    const other = testDb
      .insert(schema.users)
      .values({
        name: "Liam",
        email: "liam@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();

    buy(other.id, 5);
    const earlier = raise(other.id);
    declineRefundRequest(admin.id, earlier, "Too soon to tell", NOW);
    watch(other.id, lessonIds[0], 1800);
    complete(other.id, lessonIds[0]);
    const later = raiseRefundRequest(
      other.id,
      base.course.id,
      "Still not for me",
      new Date("2026-11-10T13:00:00")
    );

    buy(base.user.id, 2);
    const first = raiseRefundRequest(
      base.user.id,
      base.course.id,
      "Not for me",
      new Date("2026-11-10T09:00:00")
    );

    const rows = listOpenRefundRequests(NOW);

    expect(rows.map((row) => row.learnerName)).toEqual(["Test User", "Liam"]);
    expect(rows[1]).toMatchObject({
      reason: "Still not for me",
      secondsWatched: 1800,
      completedLessons: 1,
      totalLessons: 4,
      daysLeftInWindow: 9,
      earlierRequests: [
        { status: "declined", declineReason: "Too soon to tell" },
      ],
    });
    expect(first.ok && later.ok).toBe(true);
  });
});
