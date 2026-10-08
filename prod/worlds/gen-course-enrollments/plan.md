# WorldGen plan: University course registration system (Ellucian Banner / Canvas SIS style): course catalog with capacity limits, student enrollments, waitlists and grading

A course registrar world built from two imported tables. Courses have a department, credits, capacity and start date. Enrollments link a student email to a course and move through a lifecycle: waitlisted, enrolled, dropped or completed. Enrolling past capacity lands on the waitlist. Dropping an enrolled seat promotes the oldest waitlisted student, and an hourly job fills any seats that are free. Completing an enrollment requires a grade. Agents list and filter with paging, enroll, drop and grade students, and bulk-edit across a department. Revision 2: every task now declares an allows list taken from its instruction, so any change outside the named entities, kinds, fields and target rows scores 0.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `course` | A catalog course offering with department, credits, seat capacity and start date. Imported from courses.csv. | code, title, department, credits, capacity, starts_on |
| `enrollment` | One student's seat or waitlist spot in a course, with a lifecycle status and an optional final grade. Imported from enrollments.csv. | code, course_id, student_email, enrolled_on, status, grade |

## Workflows

### enrollment_lifecycle (enrollment)
- States: waitlisted, enrolled, dropped, completed
- Actions: enroll_student, drop_enrollment, complete_enrollment
- Rules:
  - enroll_student creates the enrollment. It is enrolled if enrolled seats of the course are below capacity, otherwise waitlisted.
  - Refuse with 409 if the student already holds an enrolled or waitlisted enrollment in that course. Refuse with 404 or 422 for an unknown course.
  - Transitions are waitlisted to enrolled or dropped, enrolled to dropped or completed. dropped and completed are final.
  - drop_enrollment works on enrolled and waitlisted enrollments. When an enrolled seat is freed, the oldest waitlisted enrollment of that course becomes enrolled.
  - complete_enrollment works only on enrolled enrollments, needs a grade of A, B, C or D, and records it. Other statuses give 409.
  - grade is null unless status is completed.
  - The standard update route cannot change status, grade, course_id or student_email.
### course_capacity (course)
- States: none
- Actions: promote_waitlist
- Rules:
  - Seats used are the enrollments of the course with status enrolled.
  - promote_waitlist fills free seats from the waitlist, oldest enrolled_on first, then lowest id, and returns the promoted enrollments.
  - Lowering capacity below the seats used is allowed and does not drop anyone. No new seats are given until the used count falls below capacity.
  - The job promote_waitlisted applies the same promotion rule to every course each hour.

## Jobs

- `promote_waitlisted` runs every 1h: For every course, count enrolled enrollments. While the count is below capacity and the course has waitlisted enrollments, set the oldest (enrolled_on, then id) to enrolled.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_courses` | GET | /courses | List courses, paged, filter by department and credits, search by title or code, sort by starts_on or title. |
| `get_course` | GET | /courses/{id} | Fetch one course. |
| `create_course` | POST | /courses | Create a course. |
| `update_course` | PATCH | /courses/{id} | Edit a course such as capacity or start date. |
| `list_enrollments` | GET | /enrollments | List enrollments, paged, filter by course_id, status, grade and student_email, sort by enrolled_on. |
| `get_enrollment` | GET | /enrollments/{id} | Fetch one enrollment. |
| `list_course_enrollments` | GET | /courses/{course_id}/enrollments | List enrollments for one course, filter by status. |
| `enroll_student` | POST | /enrollments | Action. Enroll a student in a course. Enrolled if a seat is free, otherwise waitlisted. |
| `drop_enrollment` | POST | /enrollments/{id}/drop | Action. Drop an enrolled or waitlisted enrollment. A freed seat goes to the oldest waitlisted student. |
| `complete_enrollment` | POST | /enrollments/{id}/complete | Action. Complete an enrolled enrollment with a grade. |
| `promote_waitlist` | POST | /courses/{id}/promote_waitlist | Action. Fill the free seats of one course from its waitlist, oldest first. |

## Seed

- Rows per entity: course: 30, enrollment: 210
- Mix: Courses and enrollments come from the fixtures. Every enrollment course_id resolves to a course. The 6 departments appear in the courses. Capacity has 4 distinct values. Enrollment statuses are enrolled, dropped, completed and waitlisted, with none above 70%. About 25% of enrollments carry a grade, all of them completed. A few courses are full or over capacity, so the waitlist rules and the promotion job have work to do. 66 distinct students each hold several enrollments. 210 enrollments over 30 courses gives enough rows for paging.

## Tasks

- `drop_student_from_course` (easy): Drop the enrollment of one named student (an email from the seed) in one named course (by title). The student must hold an enrolled enrollment in it. The instruction tells the agent that a freed seat goes to the oldest waitlisted student. Graded on the enrollment ending as dropped with no collateral changes other than that permitted waitlist promotion. ALLOWS (from the instruction, not from the solution): (1) enrollment updated, fields [status], where {student_email: the named email, course_id: the named course, status: enrolled}; (2) enrollment updated, fields [status], where {course_id: the named course, status: waitlisted} for the promoted student. Nothing created, nothing deleted, no course changes.
  - Decoy idea: Drops the same student's enrollment in a different course with a similar title, or PATCHes status to dropped, which the standard route refuses, or drops all of the student's enrollments.
- `enroll_into_full_course` (medium): A named student asks to join a course that is already at capacity. Find the course by title, enroll the student through the enroll action so the student ends up waitlisted, then drop another named student's enrolled seat in that course (named by email in the instruction) to promote the oldest waitlisted student. Graded on the new enrollment being enrolled or waitlisted as the rules require, with the correct promotion, and no other student changed. ALLOWS (from the instruction): (1) enrollment created, where {student_email: the asking student, course_id: the named course}; (2) enrollment updated, fields [status], where {student_email: the student to drop, course_id: the named course, status: enrolled}; (3) enrollment updated, fields [status], where {course_id: the named course, status: waitlisted} for the promoted waitlisted student. No course edits (capacity must not change), no deletes, no other fields.
  - Decoy idea: Raises the course capacity with PATCH to force a seat instead of using the waitlist, or drops a different student than named, or promotes a student other than the oldest waitlisted one.
- `grade_completed_department_courses` (hard): For every Computing course starting before a stated date, complete every enrolled enrollment with grade B, paging through the courses and enrollments lists. Graded as the fraction of target enrollments completed with B, with a guard against collateral changes to other departments, waitlisted students or dropped ones. ALLOWS (from the instruction): one entry per Computing course starting before the stated date, each enrollment updated, fields [status, grade], where {course_id: that course, status: enrolled}. The where of a course covers only that course's enrolled rows, so other departments, later start dates, waitlisted, dropped and already completed enrollments are outside it. Nothing created, nothing deleted, no course changes.
  - Decoy idea: Reads only the first page of enrollments, or includes the Physics department, or completes waitlisted and dropped enrollments, or compares dates as the wrong year, or grades the first course only.
  - Pressure: paging past the first page of enrollment; seeded rows in enrollment.enrolled, enrollment.waitlisted, enrollment.dropped

## Open questions

- Should the waitlist promotion that follows a drop be allowed for every task that drops a seat?
  - Default answer: Yes, but only where the instruction tells the agent a freed seat goes to the oldest waitlisted student, and only for waitlisted enrollments of the same course, changing status.
- The allows where can match one value per field. How should a department-wide task name its target rows?
  - Default answer: One allows entry per Computing course starting before the stated date, each with where {course_id, status: enrolled}.
- Should the enroll task allow editing the course capacity?
  - Default answer: No. The instruction asks for the waitlist path, so no course update is allowed.

## Assumptions

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

## Out of scope

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

## Changes

- tasks.drop_student_from_course
- tasks.enroll_into_full_course
- tasks.grade_completed_department_courses
