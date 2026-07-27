# EmDash Learn

EmDash Learn turns published EmDash content into structured learning and
records learning activity without owning user identity. Its compatible core
target is EmDash 0.32.0; core publishes the authenticated route-principal
contract before Learn.

## Content and assessment

**Course**  
A published learning program containing an ordered set of Lessons.  
_Avoid_: Class, curriculum

**Lesson**  
The smallest authored Course step whose completion contributes to Course
progress.  
_Avoid_: Topic, module

**Knowledge Check**  
An editor-owned, Course-bound assessment identity that may have one editable
Draft and one current published head. The authored `courseId` is carried
through every revision, presentation, result, and Attempt.  
_Avoid_: Quiz record

**Check Revision**  
An immutable published snapshot of a Knowledge Check, including questions,
answer key, and passing score. Presentation and grading identify the exact
`revisionId`.  
_Avoid_: Check version, mutable quiz

**Knowledge Check Block**  
The `learnKnowledgeCheck` Portable Text block. It requires the authored
`courseId` context and stable `checkId`, and renders through the canonical
`KnowledgeCheckBlock` export from `@emdash/lms-core/astro`.  
_Avoid_: `lmsQuiz`, `quizId`

## Learners and activity

**Core Principal**  
The authenticated, minimal identity supplied to a plugin route by EmDash core.
Learn derives ownership from its opaque ID and never accepts a browser identity
claim. Core owns signup, verification, credentials, sessions, users, and
roles.  
_Avoid_: Learn user, form email as identity

**Verified Learner**  
A Learn domain view of an authenticated Core Principal. “Verified” means an
authenticated EmDash account, not proof of one unique human.  
_Avoid_: Student profile, verified person

**Self-check**  
Anonymous deterministic grading that does not create an account Attempt. Its
optional result is saved only in device progress.  
_Avoid_: Practice Attempt

**Attempt**  
An immutable, server-graded Knowledge Check result linked to one Verified
Learner, one Course, and one Check Revision. It stores outcome facts, never
submitted answers, authored explanations, or free text. A unique
learner/submission key makes concurrent identical retries converge on one
durable Attempt.  
_Avoid_: Mutable quiz state

**Completion Fact**  
A monotonic record that a Verified Learner completed one Lesson. Course
progress is derived from facts and the current published Lesson set. A unique
learner/Lesson key makes concurrent completion and import writes converge on
one immutable fact.  
_Avoid_: Authoritative percentage counter

**Device Progress**  
Anonymous lesson IDs and self-check summaries stored in one browser. It can be
reset, exported, and imported. On sign-in, lesson IDs may become
`device_import` Completion Facts; self-check scores never become Attempts.  
_Avoid_: Anonymous account, verified Learning Record

## Setup

**Setup Run**  
The no-input `setup:run` operation. The server converges and verifies the
Course/Lesson schema, repairs the publication projection, and persists
server-derived completion evidence.  
_Avoid_: Browser-declared completed steps

## Reporting and privacy

**Engagement Observation**  
A redacted fact from the fixed event vocabulary. Opens are directional browser
observations. Every successful self-grade request emits one submission
observation; authenticated retries and completions emit only for newly durable
facts.  
_Avoid_: Arbitrary analytics payload

**Actor Count**  
The `{ total, anonymous, verified }` breakdown attached to every reporting
event metric and score band. `total` always equals the two actor-specific
counts.  
_Avoid_: Blended traffic count

**Verified Account-Day (`verifiedAccountDays`)**  
One distinct authenticated account active within one UTC day, summed over the
report range. The same account active on two days contributes two
account-days.  
_Avoid_: Unique person, cross-day unique learner

**Retained Observation**  
A redacted reporting event kept for at most 90 days and aggregated exactly at
query time. Daily maintenance deletes observations strictly older than the
retention cutoff.  
_Avoid_: Permanent visitor event history

**Calculation Watermark (`calculatedThrough`)**  
The report snapshot time captured after its raw-observation storage read. It
is present even for an empty real report and is not the latest visitor activity
timestamp.  
_Avoid_: Last activity time

**Privacy Erasure**  
The principal-owned deletion of lesson Completion Facts, Attempts, and
attributable raw Engagement Observations. The first release has no Daily
Rollups: reports are recalculated from the retained 90-day observation window,
so successful erasure removes that activity from subsequent reports. Sites
invoke the route through the browser client's `eraseMyData()` method and own
the learner-facing confirmation and recovery interface.  
_Avoid_: Deleting shared Course/Lesson content
