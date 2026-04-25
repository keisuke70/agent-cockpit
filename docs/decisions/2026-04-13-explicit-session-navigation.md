# Session navigation uses explicit controls

- Date: 2026-04-13
- Status: Accepted

## Context

The session detail page originally allowed switching to sibling sessions with a
full-content horizontal swipe gesture. In practice, this made normal mobile use
fragile: a scroll with enough horizontal movement could unexpectedly navigate to
another conversation.

## Decision

Session switching must be triggered by explicit controls in the header rather
than by ambient gestures on the transcript or main content area. The controls
are native buttons with accessible names and disabled edge states. Sibling
session navigation replaces the current history entry so a mobile browser back
gesture does not walk back through an accidental stack of conversations.

If swipe navigation is reintroduced later, it must be opt-in and constrained to
a clearly visible control or mode. It must not listen to the scrollable
conversation transcript or the entire session content region.

## Consequences

- Accidental conversation changes during mobile reading/scrolling are avoided.
- Session navigation remains keyboard- and screen-reader-operable.
- Browser back is reserved for returning to the previous app location instead
  of replaying intra-session switches.
- One-handed navigation is still possible through header buttons, but the
  hidden full-screen gesture is intentionally removed.
