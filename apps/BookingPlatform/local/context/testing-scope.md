# Testing Scope

## Skip

- **Form field validation** — empty fields, missing required inputs, basic type errors.
  This is comprehensively covered by unit tests. Do not spend iterations submitting empty forms
  or triggering "field required" messages.

- **Password strength rules** — the validation logic is unit tested; there is no need
  to probe minimum length, complexity, or edge-character rules.

## Focus

- **Authenticated user journeys** — prioritise flows that require login and span multiple steps
  (e.g. booking a rink end-to-end, payment flow, cancellation and refund).

- **Role-permission boundaries** — verify that each persona can only see and do what they
  should. Attempt to access admin-only routes as a regular user.

- **Areas from the historical bug reports** — follow the regression list and exercise
  each affected flow first before exploring new areas.

- **Cross-role interactions** — actions taken as one persona that affect another
  (e.g. admin approves a booking submitted by a user).
