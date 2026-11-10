import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { courses, purchases, refunds, UserRole, users } from "~/db/schema";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/components/ui/tabs";
import { AlertTriangle } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  declineRefundRequest,
  listOpenRefundRequests,
  listPendingRefunds,
  markRefundFailed,
  markRefundIssued,
  REFUND_COMPLETION_LIMIT,
  REFUND_WATCH_LIMIT_SECONDS,
  retryRefund,
  type RefundActionResult,
} from "~/lib/refunds.server";

const refundIdField = z.coerce.number().int();

const adminRefundActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("approve"), refundRequestId: refundIdField }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: refundIdField,
    declineReason: z
      .string()
      .trim()
      .min(1, "Give the learner a reason for declining."),
  }),
  z.object({ intent: z.literal("mark-issued"), refundRequestId: refundIdField }),
  z.object({ intent: z.literal("mark-failed"), refundRequestId: refundIdField }),
  z.object({ intent: z.literal("retry"), refundRequestId: refundIdField }),
]);

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests" },
  ];
}

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Admins can decide Refund Requests.", { status: 403 });
  }
  return currentUser;
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  return {
    adminId: admin.id,
    open: listOpenRefundRequests(new Date()),
    pending: listPendingRefunds(),
  };
}

function getEmailDetails(refundRequestId: number) {
  return db
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      amount: purchases.amountPaid,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
}

/**
 * There is no mail transport wired up yet, so decision emails go to the
 * server log, like the request confirmation does.
 */
function sendDecisionEmail(
  refundRequestId: number,
  decision: { approved: true } | { approved: false; declineReason: string }
) {
  const details = getEmailDetails(refundRequestId);
  if (!details) return;

  const body = decision.approved
    ? [
        `Hi ${details.learnerName},`,
        "",
        `Your refund request for "${details.courseTitle}" has been approved.`,
        `We are sending ${formatPrice(details.amount)} back to you, and will confirm once it has gone.`,
        "",
        "Your progress is saved, and will be here if you buy the course again.",
      ]
    : [
        `Hi ${details.learnerName},`,
        "",
        `We have declined your refund request for "${details.courseTitle}".`,
        "",
        `Reason: ${decision.declineReason}`,
        "",
        "Your access to the course is back, and your progress is where you left it.",
      ];

  console.log(
    `[email] to=${details.learnerEmail} subject=Refund request ${
      decision.approved ? "approved" : "declined"
    } — ${details.courseTitle}\n${[...body, "", "— The Cadence team"].join("\n")}`
  );
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, adminRefundActionSchema);
  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { intent, refundRequestId } = parsed.data;
  const now = new Date();
  let result: RefundActionResult;

  switch (intent) {
    case "approve":
      result = approveRefundRequest(admin.id, refundRequestId, now);
      if (result.ok) sendDecisionEmail(refundRequestId, { approved: true });
      break;
    case "decline":
      result = declineRefundRequest(
        admin.id,
        refundRequestId,
        parsed.data.declineReason,
        now
      );
      if (result.ok) {
        sendDecisionEmail(refundRequestId, {
          approved: false,
          declineReason: parsed.data.declineReason,
        });
      }
      break;
    case "mark-issued":
      result = markRefundIssued(admin.id, refundRequestId);
      break;
    case "mark-failed":
      result = markRefundFailed(admin.id, refundRequestId);
      break;
    case "retry":
      result = retryRefund(admin.id, refundRequestId);
      break;
  }

  if (!result.ok) {
    return data({ error: result.reason }, { status: 409 });
  }
  return { success: true };
}

function formatHours(seconds: number) {
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function useActionToast(fetcher: ReturnType<typeof useFetcher>) {
  useEffect(() => {
    const result = fetcher.data as { error?: string } | undefined;
    if (fetcher.state === "idle" && result?.error) {
      toast.error(result.error);
    }
  }, [fetcher.state, fetcher.data]);
}

type OpenRow = Route.ComponentProps["loaderData"]["open"][number];
type PendingRow = Route.ComponentProps["loaderData"]["pending"][number];

function OpenRefundRequestCard({
  row,
  adminId,
}: {
  row: OpenRow;
  adminId: number;
}) {
  const fetcher = useFetcher();
  const [isDeclining, setIsDeclining] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  useActionToast(fetcher);

  const isOwnRequest = row.learnerId === adminId;
  const completedShare =
    row.totalLessons > 0 ? row.completedLessons / row.totalLessons : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="font-semibold">{row.learnerName}</h2>
            <p className="text-sm text-muted-foreground">
              {row.learnerEmail} · {row.courseTitle}
            </p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{formatPrice(row.amount)}</p>
            <p className="text-muted-foreground">
              Bought {formatDate(row.purchasedAt)} · {row.daysLeftInWindow}{" "}
              {row.daysLeftInWindow === 1 ? "day" : "days"} left in window
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <blockquote className="border-l-2 pl-3 italic">{row.reason}</blockquote>

        <dl className="grid grid-cols-2 gap-2">
          <div>
            <dt className="text-muted-foreground">Watched</dt>
            <dd>
              {formatHours(row.secondsWatched)} of{" "}
              {formatHours(REFUND_WATCH_LIMIT_SECONDS)} limit
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lessons completed</dt>
            <dd>
              {row.completedLessons} of {row.totalLessons} (
              {Math.round(completedShare * 100)}% of{" "}
              {Math.round(REFUND_COMPLETION_LIMIT * 100)}% limit)
            </dd>
          </div>
        </dl>

        {row.earlierRequests.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Earlier requests on this course</p>
            <ul className="space-y-1 text-muted-foreground">
              {row.earlierRequests.map((earlier) => (
                <li key={earlier.refundRequestId}>
                  {formatDate(earlier.requestedAt)}: {earlier.status}
                  {earlier.refundState ? ` (${earlier.refundState})` : ""}
                  {earlier.declineReason
                    ? ` — "${earlier.declineReason}"`
                    : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {isOwnRequest ? (
          <p className="text-muted-foreground">
            This is your own Refund Request. Another Admin has to decide it.
          </p>
        ) : isDeclining ? (
          <fetcher.Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="decline" />
            <input
              type="hidden"
              name="refundRequestId"
              value={row.refundRequestId}
            />
            <Textarea
              name="declineReason"
              rows={3}
              required
              placeholder="Why are you declining? The learner will see this."
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={isSubmitting}
              >
                Decline
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsDeclining(false)}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        ) : (
          <div className="flex gap-2">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="approve" />
              <input
                type="hidden"
                name="refundRequestId"
                value={row.refundRequestId}
              />
              <Button type="submit" size="sm" disabled={isSubmitting}>
                Approve
              </Button>
            </fetcher.Form>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsDeclining(true)}
            >
              Decline
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PendingRefundRow({
  row,
  adminId,
}: {
  row: PendingRow;
  adminId: number;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  useActionToast(fetcher);

  const isFailed = row.refundState === "failed";
  const isOwnRefund = row.learnerId === adminId;

  function actionButton(
    intent: string,
    label: string,
    variant: "default" | "outline"
  ) {
    return (
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="refundRequestId" value={row.refundRequestId} />
        <Button type="submit" size="sm" variant={variant} disabled={isSubmitting}>
          {label}
        </Button>
      </fetcher.Form>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6 text-sm">
        <div>
          <p className="font-semibold">
            {row.learnerName} · {formatPrice(row.amount)}
          </p>
          <p className="text-muted-foreground">
            {row.courseTitle} · approved{" "}
            {row.resolvedAt ? formatDate(row.resolvedAt) : ""} ·{" "}
            <span className={isFailed ? "text-destructive" : undefined}>
              {isFailed ? "Failed Refund" : "Pending Refund"}
            </span>
          </p>
        </div>
        {isOwnRefund ? (
          <p className="text-muted-foreground">Your own Refund</p>
        ) : (
          <div className="flex gap-2">
            {isFailed ? (
              actionButton("retry", "Retry", "default")
            ) : (
              <>
                {actionButton("mark-issued", "Mark Issued", "default")}
                {actionButton("mark-failed", "Mark Failed", "outline")}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { open, pending, adminId } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <h1 className="mb-1 text-3xl font-bold">Refunds</h1>
      <p className="mb-6 text-muted-foreground">
        Decide Open Refund Requests, then record what happened to the money.
        Decisions are final.
      </p>

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Open ({open.length})</TabsTrigger>
          <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="mt-4 space-y-4">
          {open.length === 0 ? (
            <p className="text-muted-foreground">No Open Refund Requests.</p>
          ) : (
            open.map((row) => (
              <OpenRefundRequestCard
                key={row.refundRequestId}
                row={row}
                adminId={adminId}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="pending" className="mt-4 space-y-3">
          {pending.length === 0 ? (
            <p className="text-muted-foreground">
              No Pending or Failed Refunds.
            </p>
          ) : (
            pending.map((row) => (
              <PendingRefundRow
                key={row.refundRequestId}
                row={row}
                adminId={adminId}
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
