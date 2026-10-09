# WorldGen report: University course registration system (Banner / Ellucian-style student information system registration module)

Students register for course sections in a term. Sections have a seat cap and a bounded waitlist. Prerequisites must be passed first. Terms have add, drop and withdraw deadlines. Dropping or withdrawing frees a seat and promotes the first waitlisted student. A daily job clears waitlists after the add deadline.

## What was built

Entities (6):

- `term`: 3 seeded rows
- `course`: 16 seeded rows
- `prerequisite`: 10 seeded rows
- `student`: 45 seeded rows
- `section`: 24 seeded rows
- `enrollment`: 100 seeded rows

Routes (17):

- `list_terms`: GET /terms
- `get_term`: GET /terms/{id}
- `create_term`: POST /terms
- `list_courses`: GET /courses
- `get_course`: GET /courses/{id}
- `create_course`: POST /courses
- `list_prerequisites`: GET /prerequisites
- `create_prerequisite`: POST /prerequisites
- `list_students`: GET /students
- `get_student`: GET /students/{id}
- `create_student`: POST /students
- `list_sections`: GET /sections
- `get_section`: GET /sections/{id}
- `create_section`: POST /sections
- `update_section`: PATCH /sections/{id}
- `list_enrollments`: GET /enrollments
- `get_enrollment`: GET /enrollments/{id}

Actions (4):

- `enroll_student`: POST /sections/{id}/enroll
- `drop_enrollment`: POST /enrollments/{id}/drop
- `withdraw_enrollment`: POST /enrollments/{id}/withdraw
- `record_grade`: POST /enrollments/{id}/grade

Jobs (1):

- `waitlist_expiry`: every 1d

## Assumed and why

- Clock starts 2026-10-09T12:00:00Z with tick 0s; Fall 2026 deadlines lie in the future and Spring 2026 history lies in the past.
  - Why: Seeded history precedes the start, scheduled deadlines follow it, and time moves only by explicit advance.
- Enrollments are created only by the enroll_student action. No standard create route exists for them.
  - Why: Seat caps, prerequisites and deadlines must always be checked.
- Grades are A, B, C, D, F. Passing means D or better, and a prerequisite's min_grade is compared by that order.
  - Why: Simple ordered scale.
- Waitlist promotion is first-come, first-served by position and is done inside drop and withdraw. It skips no one.
  - Why: Standard registrar behaviour.
- Waitlisted students get no prerequisite waiver. The prerequisite check happens before waitlisting.
  - Why: Avoids invalid waitlist entries.
- enroll_student answers 201 for both enrolled and waitlisted outcomes. The other actions answer 200.
  - Why: Both create an enrollment row.
- Acceptance tests use fixed ISO dates relative to the clock start and ctx.advance.
  - Why: Tests cannot compute dates.
- Because the standard routes enforce no timing rules, any seeded term has a drop deadline after its add deadline.
  - Why: Keeps the term calendar consistent.

## Questions asked of the input

- Should a waitlisted student be auto-promoted when a seat frees?
  - Default answer: Yes, the first waitlisted student by position is promoted inside drop and withdraw.
- Are prerequisites satisfied by a passing grade only, or also by concurrent enrollment?
  - Default answer: Only by a completed enrollment with at least the minimum grade.
- What happens to waitlisted students once the add deadline passes?
  - Default answer: A daily job drops them.
- Do we model time conflicts or credit limits?
  - Default answer: No, out of scope.

## Left out

- Meeting times, room scheduling and time-conflict checks
  - Why: Adds a large scheduling model without changing the core registration workflow.
- Tuition, billing and credit-load limits
  - Why: A separate finance domain.
- Authentication and advisor/instructor roles
  - Why: The API acts as the registrar.
- Co-requisites and permission overrides
  - Why: Only prerequisites are planned.

## Proof

The engine check passed: 5 world tests, 4 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_0e5211a77b82027a3a669bdf6b5cce9acbda665ee217f3367cb5b16d398b57d4`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| enroll_maya_cs201 | easy | 1.000 | 0.000 | 0.000 | n/a | declared (2); mutants 7/8 | `tid_a6a5f85adef6ba1a04f71f683ab0dc20185dbd49d0d68436fecf116a9b7208f8` |
| drop_omar_promote | medium | 1.000 | 0.000 | 0.600, 0.000 | n/a | declared (3); mutants 4/8 | `tid_8b1f2d1ad3926920298f0c1cfbe480cb89929501dc489ba1887e16a2f9f8a432` |
| cancel_cs120_section_01 | hard | 1.000 | 0.000 | 0.100, 0.000 | 0.100 | declared (5); mutants 5/8 | `tid_4799627c6663066eb4843f615f48016b303e99e0e49d80d7393e92197af31dc2` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `enroll_maya_cs201` 0.000: enrolls Maya in the Spring 2027 CS 201 section instead of the Fall 2026 one
- `drop_omar_promote` 0.600: withdraws Omar Haddad instead of dropping him, so the seat is freed and the waitlist moves but his enrollment ends withdrawn, not dropped
- `drop_omar_promote` 0.000: drops the near-duplicate student Omar Haddadi instead of Omar Haddad
- `cancel_cs120_section_01` 0.100: only looks at section 02 and never uses the free seat in section 03, so it moves three students and leaves two in section 01
- `cancel_cs120_section_01` 0.000: drops every student from section 01 first and enrolls them afterwards, so the one student without a free seat ends on a waitlist and is no longer enrolled in section 01

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| enroll_maya_cs201 | easy | 2 | none | none | none declared |
| drop_omar_promote | medium | 5 | none | enrollment | distractors: met; state: met; state: met |
| cancel_cs120_section_01 | hard | 11 | none | enrollment | hard: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of University course registration system (Banner / Ellucian-style student information system registration module), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.83 | 0.3663 |
| model | 1 | 0.40 | 0.1062 |
| workflow | 1 | 0.61 | 0.1396 |
| seed | 1 | 1.75 | 0.2263 |
| tasks | 1 | 2.82 | 0.5705 |
| Total | 5 | 7.42 | 1.4088 |

Run total: 7.43 minutes, $1.4088.
