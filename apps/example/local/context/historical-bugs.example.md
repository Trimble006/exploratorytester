# Historical Defects

Use this file to guide risk-based exploratory testing toward known weak areas and past regressions.

## Critical
- Booking grid cells intermittently ignore click events on /book.
- Continue to details action blocked by fixed bottom banner on smaller viewports.

## High
- Navigation links occasionally route to wrong pages after login (Book/Messages/Profile).
- Messages page stuck in loading state when channel list fetch fails.

## Medium
- Login and registration forms allow invalid or empty submissions before server validation.
- Weather panel fails when upstream API returns unexpected payload.

## Retest Focus
- Booking journey: date select -> rink selection -> continue to details.
- Auth flows: login, register, forgot password, session transitions.
- Navigation consistency across anonymous and authenticated states.
