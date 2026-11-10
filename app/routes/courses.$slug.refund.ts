import { data, redirect } from "react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, refunds, users, RefundStatus } from "~/db/schema";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { getRefundOffer } from "~/lib/refund-policy.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `We've received your refund request — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We've received your refund request for "${input.courseTitle}".`,
      `If it is approved, we will refund ${formatPrice(input.amount)}, the amount you paid, and your access to the course will end.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again once it has been reviewed.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = db.select().from(courses).where(eq(courses.slug, slug)).get();

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const offer = getRefundOffer(currentUserId, course.id);

  if (!offer) {
    throw data("You have not bought this course.", { status: 403 });
  }

  if (!offer.result.eligible) {
    const status = offer.result.reason === "refund-request-open" ? 409 : 403;
    throw data(offer.result.message, { status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db.insert(refunds)
    .values({
      purchaseId: offer.purchaseId,
      status: RefundStatus.Requested,
      reason: parsed.data.reason,
    })
    .run();

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: offer.result.amount,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect("/settings");
}
