# WorldGen report: University course registration system (Ellucian Banner / Canvas SIS style): course catalog with capacity limits, student enrollments, waitlists and grading

A course registrar world built from two imported tables. Courses have a department, credits, capacity and start date. Enrollments link a student email to a course and move through a lifecycle: waitlisted, enrolled, dropped or completed. Enrolling past capacity lands on the waitlist. Dropping an enrolled seat promotes the oldest waitlisted student, and an hourly job fills any seats that are free. Completing an enrollment requires a grade. Agents list and filter with paging, enroll, drop and grade students, and bulk-edit across a department. Revision 2: every task now declares an allows list taken from its instruction, so any change outside the named entities, kinds, fields and target rows scores 0.

## What was built

Entities (2):

- `course`: 30 seeded rows
- `enrollment`: 210 seeded rows

Routes (7):

- `list_courses`: GET /courses
- `get_course`: GET /courses/{id}
- `create_course`: POST /courses
- `update_course`: PATCH /courses/{id}
- `list_enrollments`: GET /enrollments
- `get_enrollment`: GET /enrollments/{id}
- `list_course_enrollments`: GET /courses/{course_id}/enrollments

Actions (4):

- `enroll_student`: POST /enrollments
- `drop_enrollment`: POST /enrollments/{id}/drop
- `complete_enrollment`: POST /enrollments/{id}/complete
- `promote_waitlist`: POST /courses/{id}/promote_waitlist

Jobs (1):

- `promote_waitlisted`: every 1h

## Changes

- item_changed `tasks.drop_student_from_course.allows`
- item_changed `tasks.enroll_into_full_course.allows`
- item_changed `tasks.grade_completed_department_courses.allows`
- snippet_changed `tasks.grade_completed_department_courses.solution`

## Assumed and why

- clock.start is 2026-10-06T09:00:00Z and tick is 1s.
  - Why: The environment date is 2026-10-06. It is assumed to be after every enrolled_on in the data (the sample is 2026-08-28). Course starts_on dates such as 2026-11-02 are in the future, so they are the scheduled events. Tick 1s gives distinct timestamps for calls.
- The imported course_id (C101) and enrollment_id (E5001) become a unique string field `code` on each entity. Rows get engine ids crs_0001 and enr_0001. The enrollment course_id field is a ref to course, mapped from the course code by the seed.
  - Why: Engine ids are generated. Keeping the source keys lets agents and tasks refer to the codes users know.
- No student entity. student_email stays a string field on enrollment with an email format.
  - Why: The input has only the email. 66 distinct emails identify students and no other student attributes exist.
- Enrollment status is a state machine: waitlisted to enrolled or dropped, enrolled to dropped or completed, and dropped and completed are final. status, grade and enrolled_on are readonly in the standard routes, and only actions, jobs and seed change them. Enrollments are created only through the enroll action.
  - Why: Capacity, waitlist and grade rules cannot be bypassed by a plain PATCH. This also makes the task decoys that PATCH the status measurable.
- Seats used by a course equal its enrollments with status enrolled. Completed and dropped enrollments free their seat. Completed enrollments are treated as having left the seat count.
  - Why: This is the usual registrar convention. The input has no seat counter, so it is computed from rows to avoid a stored total that could disagree with the data.
- Imported grades are kept only on completed enrollments. Grade is nullable and set by the complete action. The data says 75% null, so about 52 grades exist. Any imported grade on a non-completed row is cleared or the row is set to completed by the seed.
  - Why: A grade on a dropped or waitlisted enrollment is inconsistent. The 25% non-null share is about the same as the share of completed rows.
- Duplicate active enrollment is refused: the same student_email cannot hold two non-dropped enrollments (enrolled or waitlisted) in one course. A student can re-enroll after dropping.
  - Why: This is standard registrar behavior. The data has 66 students over 210 rows, so repeats across courses are normal and repeats within a course are only possible after a drop.
- The job promote_waitlisted runs every 1h. For each course with free seats it moves waitlisted enrollments to enrolled, oldest enrolled_on first, then lowest id.
  - Why: This models automatic waitlist handling. drop_enrollment does the same inline for its own course, so tasks do not depend on the clock.
- Credits are 1 to 6, capacity is at least 1, and department is an enum of Computing, Physics, History, Biology, Art and Math.
  - Why: The data has 4 distinct credits and capacities. The department enum is taken from the input.
- starts_on and enrolled_on are stored as datetime at 00:00:00Z.
  - Why: The engine has a datetime type and no date-only type. Source values are ISO dates.
- No registration window rule is enforced against starts_on.
  - Why: The sample data has enrollments made after a course start. Enforcing it would reject imported rows, so it is not a rule.
- An action-created enrollment gets enrolled_on equal to the engine time and a code like E<next number> continuing after the highest imported code.
  - Why: Callers send only the course and the student. The code keeps the E5001 style.
- Each task's allows list is written into the task intent, taken from what its instruction permits. It is built from entity, kind, exact fields for updates, and a where of seed field values that picks the target rows. Because where matches a single value per field, a department-wide task gets one allows entry per target course. The waitlist promotion in a drop is permitted only where the instruction tells the agent about it.
  - Why: The plan task shape has no allows field, so the intent carries it for the tasks stage to turn into the engine's allows guard. Job changes and engine timestamps are exempt from the guard.
- The request changes only the three tasks. No entity, route, workflow rule, job or test changes, so changes lists only tasks.* items.
  - Why: The change request asks only for allows lists on tasks. Workflow rules stay as they were.

## Questions asked of the input

- Should the waitlist promotion that follows a drop be allowed for every task that drops a seat?
  - Default answer: Yes, but only where the instruction tells the agent a freed seat goes to the oldest waitlisted student, and only for waitlisted enrollments of the same course, changing status.
- The allows where can match one value per field. How should a department-wide task name its target rows?
  - Default answer: One allows entry per Computing course starting before the stated date, each with where {course_id, status: enrolled}.
- Should the enroll task allow editing the course capacity?
  - Default answer: No. The instruction asks for the waitlist path, so no course update is allowed.

## Left out

- Authentication, student and instructor accounts, and permissions
  - Why: The input has no users beyond emails. Agents act as the registrar.
- Prerequisites, schedules, rooms, instructors and time conflicts
  - Why: None of these are in the data.
- Tuition, billing and refunds
  - Why: The data has no money fields.
- GPA calculation and transcripts
  - Why: Grades are stored per enrollment only. Aggregates are not in the input.
- Notification emails for promotion from the waitlist
  - Why: There is no outbound email in the world.
- Deleting courses and enrollments
  - Why: Registrars keep records. Drop is the supported way to end an enrollment.

## Proof

The engine check passed: 4 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_8b4f536d43dae5d8e738b442917f60bde262c74c59aa5b8d043ac0701541fae8`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| drop_student_from_course | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 3/8 | `tid_9b1fbb28202ce753e98afd51576333bad53fb82ba51e4910f5875ff10facf4ab` |
| enroll_into_full_course | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.750 | 0.400 | declared (4); mutants 5/8 | `tid_9a43798a95b530d2dda7f67759096c4dceb1cdd6cc0b24de5523e70a4bb13382` |
| grade_completed_department_courses | hard | 1.000 | 0.000 | 0.571, 0.000, 0.000, 0.000, 0.143 | 0.929 | declared (3); mutants 3/8 | `tid_0a7ef6983085dfa92c9c893e53a8ee5caea696a178293cc9d4393265019ba871` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `drop_student_from_course` 0.000: drops every enrolled enrollment of the student across all courses instead of only the one in Math Seminar 9
- `drop_student_from_course` 0.000: drops the other enrolled student of Math Seminar 9 instead of the named student
- `enroll_into_full_course` 0.000: raises the capacity so the new student gets a seat directly instead of cutting it to 3 and using the waitlist
- `enroll_into_full_course` 0.000: drops a different enrolled student than student8 so the wrong seat is released
- `enroll_into_full_course` 0.000: drops the seat before lowering the capacity, so the drop promotes the whole waitlist instead of one student
- `enroll_into_full_course` 0.750: lowers the capacity and drops the seat but never enrolls the new student
- `grade_completed_department_courses` 0.571: reads only the first page of the unfiltered course list, so it misses the Computing course that sits on page 2
- `grade_completed_department_courses` 0.000: ignores the start date and grades every Computing course including the one starting in November
- `grade_completed_department_courses` 0.000: matches courses whose title contains Computing instead of using the department, so it grades a Biology course and misses real Computing courses
- `grade_completed_department_courses` 0.000: completes the right enrollments but with grade A instead of B
- `grade_completed_department_courses` 0.143: reads only the first page of all enrolled enrollments and grades the matching ones, so it misses targets on later pages

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| drop_student_from_course | easy | 1 | none | none | none declared |
| enroll_into_full_course | medium | 4 | none | none | none declared |
| grade_completed_department_courses | hard | 14 | enrollment | enrollment | hard: met; paging: met; state: met; state: met; state: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $1.60.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.67 | 0.1012 |
| tasks | 2 | 0.48 | 0.3462 |
| Total | 3 | 1.15 | 0.4474 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures

Run total: 1.18 minutes, $0.4474.
