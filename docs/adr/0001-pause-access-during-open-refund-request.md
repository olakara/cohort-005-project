# Pause course access during an Open Refund Request, and never delete Course Progress

Refund eligibility (under 2 hours watched, under 50% of lessons completed, inside the Refund Window) is checked when the learner raises a Refund Request, but an Admin decides it later. If the learner kept access in between, they could ask on day 13 and watch the whole course while the request waits. So while a Refund Request is open, and while its Refund is Pending or Failed, the learner's access to the course is paused. Access comes back if the request is Declined or Withdrawn, and ends for good once the Refund is Issued. Course Progress is kept throughout and never deleted: it is the evidence if a learner disputes the payment with their bank, it lets a learner who buys again carry on where they left off, and eligibility counts all of a learner's Course Progress on a course, not just what they did since this purchase, so watching the course over several buy-and-refund cycles doesn't work.

## Considered Options

- **Keep access while the request is open**: rejected because it lets the learner use the course for free while it is reviewed.
- **Let the learner watch but stop recording progress**: rejected because what they watch would no longer count towards eligibility, which defeats the rules.
- **Delete Course Progress on an Issued Refund**: rejected because it can't be undone, removes the evidence if the learner disputes the payment, and resets the eligibility counters for anyone who buys again.
- **Pause the Refund Window while a request is open**: rejected because it invites learners to ask the same thing again just to buy time, and it makes the rule harder to explain.

## Consequences

- A learner whose request is declined loses access while it is reviewed. Being able to withdraw a request (a Withdrawn Refund Request) is what makes this fair, because the learner can lift the pause themselves.
- Once a request is approved, the learner never gets access back, even if the Refund fails. What Cadence owes them is the money, not the course.
- Requests that were already open when this rule went live are paused straight away. No exceptions for existing requests.
