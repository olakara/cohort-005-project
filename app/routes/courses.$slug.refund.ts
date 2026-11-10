import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  findOpenRefundRequestId,
  raiseRefundRequest,
  withdrawRefundRequest,
} from "~/lib/refunds.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("request"),
    reason: z
      .string()
      .trim()
      .min(10, "Tell us a little more about why you want a refund.")
      .max(1000, "Please keep your reason under 1000 characters."),
  }),
  z.object({ intent: z.literal("withdraw") }),
]);

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
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Your access to the course is paused while we review it. Your progress is saved, and you can withdraw the request from the course page if you change your mind.",
      "",
      "Our team reviews every refund request by hand. We will email you again when it is decided.",
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

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  if (parsed.data.intent === "withdraw") {
    const openId = findOpenRefundRequestId(currentUserId, course.id);
    const result =
      openId === null
        ? { ok: false as const, reason: "You have no open refund request." }
        : withdrawRefundRequest(currentUserId, openId);

    if (!result.ok) {
      return data({ error: result.reason }, { status: 409 });
    }
    return redirect(`/courses/${slug}`);
  }

  const result = raiseRefundRequest(
    currentUserId,
    course.id,
    parsed.data.reason,
    new Date()
  );

  if (!result.ok) {
    throw data(result.reason, { status: 403 });
  }

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: result.amount,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
