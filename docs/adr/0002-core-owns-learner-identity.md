---
status: deferred
date: 2026-07-26
---

# EmDash core owns learner identity

> Future account track. EmDash Learn 0.1 has no account-linked routes or
> storage. Any later implementation must be reconciled with the official
> `ctx.user` contract tracked in emdash-cms/emdash#812.

## Context

Account-linked Lesson progress, assessment Attempts, and privacy erasure need a
stable owner. A plugin form that asks for a name, email address, phone number,
or verification code cannot establish that owner safely: it would duplicate
credentials, verification, abuse controls, recovery, session management, and
global user/role policy already owned by EmDash.

Browser-supplied `userId`, `learnerId`, email, or role fields are also
authorization vulnerabilities. They let a caller select another learner's
record unless every route independently re-resolves identity.

## Decision

EmDash core is the sole identity authority. It owns:

- registration and deployment-specific onboarding;
- email verification and resend;
- credentials, external identity, sessions, and recovery;
- global users and roles; and
- the minimal authenticated principal placed on plugin route context.

Learn maps that trusted principal's opaque ID to:

```ts
{ kind: "verified", learnerId: principal.id }
```

An absent principal maps to `{ kind: "anonymous" }`. Personalized commands
require the verified form and fail before personalized storage access.

Learn never collects or stores a copied profile for authorization and never
accepts a caller-selected identity field. “Verified” in Learn means an
authenticated EmDash account; it does not mean one unique person.

No Core version carrying this contract was published when Learn 0.1 was
scoped. Local Core patches and sibling links are not a release dependency.

## Consequences

- Anonymous browsing, self-grading, and device progress remain available
  without an account.
- Account-linked Completion Facts, Attempts, progress queries, device imports,
  and erasure are cross-device and owner-scoped.
- Learn does not implement signup, verification/resend, passwords, passkeys,
  magic links, sessions, phone/SMS, users, or roles.
- Core deployment policy decides which onboarding modes and roles receive
  `content:read`; Learn does not invent a learner role.
- Route tests must prove principal derivation, absent-principal rejection,
  caller-identity rejection, permission metadata, and cross-user isolation.
- The core-first release order is a hard release gate, but it avoids a second
  security-sensitive identity stack.
