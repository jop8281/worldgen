# WorldGen plan: University course registration system (Banner / Ellucian-style student information system registration module)

Students register for course sections in a term. Sections have a seat cap and a bounded waitlist. Prerequisites must be passed first. Terms have add, drop and withdraw deadlines. Dropping or withdrawing frees a seat and promotes the first waitlisted student. A daily job clears waitlists after the add deadline.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T12:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `term` | Academic term with add, drop and withdraw deadlines | name, add_deadline, drop_deadline, withdraw_deadline |
| `course` | Catalog course | code, title, credits |
| `prerequisite` | Course that must be passed with a minimum grade before another course | course_id, required_course_id, min_grade |
| `student` | Enrolled university student | name, email |
| `section` | Course offering in a term with seat cap and waitlist cap | course_id, term_id, section_code, capacity, waitlist_capacity, enrolled_count, waitlist_count |
| `enrollment` | A student's registration in a section, with lifecycle status, waitlist position and grade | student_id, section_id, status, waitlist_position, grade |

## Workflows

### registration (enrollment)
- States: waitlisted, enrolled, dropped, withdrawn, completed
- Actions: enroll_student, drop_enrollment, withdraw_enrollment, record_grade
- Rules:
  - enroll_student takes a seat while enrolled_count is below capacity. Otherwise it waitlists the student at the next position while waitlist_count is below waitlist_capacity. Otherwise it answers 409 waitlist_full. A student with an active enrollment in the same section answers 409 already_registered. Enforced by: enroll_student. Tested by: seat_cap_and_waitlist
  - A student may enroll only after passing every prerequisite of the course with at least the minimum grade. Otherwise 409 prerequisite_not_met. Enforced by: enroll_student, record_grade. Tested by: prerequisite_check
  - drop_enrollment (only on or before the term drop deadline) releases the seat and promotes the first waitlisted student to enrolled. Waitlist positions are renumbered. Enforced by: drop_enrollment. Tested by: drop_promotes_waitlist
  - Enrolling after the add deadline answers 409 add_deadline_passed. Dropping after the drop deadline answers 409 drop_deadline_passed. After it a student can only withdraw, until the withdraw deadline, and then 409 withdraw_deadline_passed. Enforced by: enroll_student, drop_enrollment, withdraw_enrollment. Tested by: deadlines_enforced
  - The waitlist_expiry job drops waitlisted enrollments of sections whose term add deadline has passed and resets the waitlist counts. Enforced by: waitlist_expiry. Tested by: waitlist_expiry_job
  - record_grade works only on enrolled enrollments and moves them to completed with the grade.
  - Course code and student email are unique. Enforced by the data model: unique fields on course.code, student.email and term.name

## Jobs

- `waitlist_expiry` runs every 1d: For every waitlisted enrollment whose section's term add_deadline is before now, set status dropped and waitlist_position null, then set the section waitlist_count to 0.

## Acceptance tests

### seat_cap_and_waitlist
- Intent: Seats fill, then the waitlist fills, then enrollment is refused
- Actions: enroll_student
- Description: Section with capacity 1 and waitlist 1: first student enrolled, second waitlisted at position 1, third refused with waitlist_full, a repeat registration refused with already_registered.

```js
(ctx) => {
  const term = ctx.api('POST','/terms',{name:'T-seat',add_deadline:'2026-10-20T00:00:00.000Z',drop_deadline:'2026-10-25T00:00:00.000Z',withdraw_deadline:'2026-11-20T00:00:00.000Z'});
  ctx.assert(term.status===201,'term '+JSON.stringify(term.body));
  const course = ctx.api('POST','/courses',{code:'TST101',title:'Seat test',credits:3}).body;
  const sec = ctx.api('POST','/sections',{course_id:course.id,term_id:term.body.id,section_code:'01',capacity:1,waitlist_capacity:1});
  ctx.assert(sec.status===201,'section '+JSON.stringify(sec.body));
  const s = [1,2,3].map((i)=>ctx.api('POST','/students',{name:'Seat Tester '+i,email:'seat'+i+'@test.example'}).body);
  const e1 = ctx.api('POST','/sections/'+sec.body.id+'/enroll',{student_id:s[0].id});
  ctx.assert(e1.status===201 && e1.body.status==='enrolled','first enrolled '+JSON.stringify(e1.body));
  const e2 = ctx.api('POST','/sections/'+sec.body.id+'/enroll',{student_id:s[1].id});
  ctx.assert(e2.status===201 && e2.body.status==='waitlisted' && e2.body.waitlist_position===1,'second waitlisted '+JSON.stringify(e2.body));
  const e3 = ctx.api('POST','/sections/'+sec.body.id+'/enroll',{student_id:s[2].id});
  ctx.assert(e3.status===409 && e3.body.error.code==='waitlist_full','third '+JSON.stringify(e3.body));
  const dup = ctx.api('POST','/sections/'+sec.body.id+'/enroll',{student_id:s[0].id});
  ctx.assert(dup.status===409 && dup.body.error.code==='already_registered','dup '+JSON.stringify(dup.body));
  const after = ctx.api('GET','/sections/'+sec.body.id).body;
  ctx.assert(after.enrolled_count===1 && after.waitlist_count===1,'counts '+JSON.stringify(after));
}
```
### prerequisite_check
- Intent: Prerequisites with a minimum grade gate enrollment
- Actions: enroll_student, record_grade
- Description: Course B requires course A with at least a C. A student without A, or with a D, is refused with prerequisite_not_met. A student with a B in A may enroll.

```js
(ctx) => {
  const term = ctx.api('POST','/terms',{name:'T-prereq',add_deadline:'2026-10-20T00:00:00.000Z',drop_deadline:'2026-10-25T00:00:00.000Z',withdraw_deadline:'2026-11-20T00:00:00.000Z'}).body;
  const a = ctx.api('POST','/courses',{code:'TST201',title:'Prereq A',credits:3}).body;
  const b = ctx.api('POST','/courses',{code:'TST202',title:'Prereq B',credits:3}).body;
  const p = ctx.api('POST','/prerequisites',{course_id:b.id,required_course_id:a.id,min_grade:'C'});
  ctx.assert(p.status===201,'prereq '+JSON.stringify(p.body));
  const sa = ctx.api('POST','/sections',{course_id:a.id,term_id:term.id,section_code:'01',capacity:5,waitlist_capacity:2}).body;
  const sb = ctx.api('POST','/sections',{course_id:b.id,term_id:term.id,section_code:'01',capacity:5,waitlist_capacity:2}).body;
  const s1 = ctx.api('POST','/students',{name:'Prereq One',email:'prereq1@test.example'}).body;
  const s2 = ctx.api('POST','/students',{name:'Prereq Two',email:'prereq2@test.example'}).body;
  const none = ctx.api('POST','/sections/'+sb.id+'/enroll',{student_id:s1.id});
  ctx.assert(none.status===409 && none.body.error.code==='prerequisite_not_met','no A '+JSON.stringify(none.body));
  const e1 = ctx.api('POST','/sections/'+sa.id+'/enroll',{student_id:s1.id}).body;
  const e2 = ctx.api('POST','/sections/'+sa.id+'/enroll',{student_id:s2.id}).body;
  const still = ctx.api('POST','/sections/'+sb.id+'/enroll',{student_id:s1.id});
  ctx.assert(still.status===409 && still.body.error.code==='prerequisite_not_met','in progress is not passed '+JSON.stringify(still.body));
  const g1 = ctx.api('POST','/enrollments/'+e1.id+'/grade',{grade:'D'});
  ctx.assert(g1.status===200 && g1.body.status==='completed' && g1.body.grade==='D','grade D '+JSON.stringify(g1.body));
  const g2 = ctx.api('POST','/enrollments/'+e2.id+'/grade',{grade:'B'});
  ctx.assert(g2.status===200 && g2.body.status==='completed','grade B '+JSON.stringify(g2.body));
  const low = ctx.api('POST','/sections/'+sb.id+'/enroll',{student_id:s1.id});
  ctx.assert(low.status===409 && low.body.error.code==='prerequisite_not_met','D below C '+JSON.stringify(low.body));
  const ok = ctx.api('POST','/sections/'+sb.id+'/enroll',{student_id:s2.id});
  ctx.assert(ok.status===201 && ok.body.status==='enrolled','B allowed '+JSON.stringify(ok.body));
}
```
### drop_promotes_waitlist
- Intent: Dropping frees a seat that goes to the first waitlisted student
- Actions: enroll_student, drop_enrollment
- Description: Capacity 1 with two waitlisted students. Dropping the enrolled student promotes the first waitlisted student and moves the second to position 1.

```js
(ctx) => {
  const term = ctx.api('POST','/terms',{name:'T-drop',add_deadline:'2026-10-20T00:00:00.000Z',drop_deadline:'2026-10-25T00:00:00.000Z',withdraw_deadline:'2026-11-20T00:00:00.000Z'}).body;
  const c = ctx.api('POST','/courses',{code:'TST301',title:'Drop test',credits:3}).body;
  const sec = ctx.api('POST','/sections',{course_id:c.id,term_id:term.id,section_code:'01',capacity:1,waitlist_capacity:2}).body;
  const s = [1,2,3].map((i)=>ctx.api('POST','/students',{name:'Drop Tester '+i,email:'drop'+i+'@test.example'}).body);
  const e = s.map((st)=>ctx.api('POST','/sections/'+sec.id+'/enroll',{student_id:st.id}).body);
  ctx.assert(e[1].status==='waitlisted' && e[2].status==='waitlisted' && e[2].waitlist_position===2,'setup '+JSON.stringify(e));
  const d = ctx.api('POST','/enrollments/'+e[0].id+'/drop',{});
  ctx.assert(d.status===200 && d.body.status==='dropped','drop '+JSON.stringify(d.body));
  const g2 = ctx.api('GET','/enrollments/'+e[1].id).body;
  const g3 = ctx.api('GET','/enrollments/'+e[2].id).body;
  ctx.assert(g2.status==='enrolled','promoted '+JSON.stringify(g2));
  ctx.assert(g3.status==='waitlisted' && g3.waitlist_position===1,'renumbered '+JSON.stringify(g3));
  const after = ctx.api('GET','/sections/'+sec.id).body;
  ctx.assert(after.enrolled_count===1 && after.waitlist_count===1,'counts '+JSON.stringify(after));
  const again = ctx.api('POST','/enrollments/'+e[0].id+'/drop',{});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','second drop '+JSON.stringify(again.body));
}
```
### deadlines_enforced
- Intent: Add, drop and withdraw deadlines are enforced against engine time
- Actions: enroll_student, drop_enrollment, withdraw_enrollment
- Description: Enrolling after the add deadline is refused. After the drop deadline a drop is refused but a withdraw works. After the withdraw deadline a withdraw is refused.

```js
(ctx) => {
  const late = ctx.api('POST','/terms',{name:'T-late',add_deadline:'2026-10-01T00:00:00.000Z',drop_deadline:'2026-10-05T00:00:00.000Z',withdraw_deadline:'2026-11-20T00:00:00.000Z'}).body;
  const term = ctx.api('POST','/terms',{name:'T-deadlines',add_deadline:'2026-10-20T00:00:00.000Z',drop_deadline:'2026-10-25T00:00:00.000Z',withdraw_deadline:'2026-11-20T00:00:00.000Z'}).body;
  const c = ctx.api('POST','/courses',{code:'TST401',title:'Deadline test',credits:3}).body;
  const lateSec = ctx.api('POST','/sections',{course_id:c.id,term_id:late.id,section_code:'01',capacity:5,waitlist_capacity:1}).body;
  const sec = ctx.api('POST','/sections',{course_id:c.id,term_id:term.id,section_code:'02',capacity:5,waitlist_capacity:1}).body;
  const s1 = ctx.api('POST','/students',{name:'Deadline One',email:'deadline1@test.example'}).body;
  const s2 = ctx.api('POST','/students',{name:'Deadline Two',email:'deadline2@test.example'}).body;
  const r = ctx.api('POST','/sections/'+lateSec.id+'/enroll',{student_id:s1.id});
  ctx.assert(r.status===409 && r.body.error.code==='add_deadline_passed','late add '+JSON.stringify(r.body));
  const e1 = ctx.api('POST','/sections/'+sec.id+'/enroll',{student_id:s1.id});
  const e2 = ctx.api('POST','/sections/'+sec.id+'/enroll',{student_id:s2.id});
  ctx.assert(e1.status===201 && e2.status===201,'enrolled before deadline');
  ctx.advance('17d');
  const d = ctx.api('POST','/enrollments/'+e1.body.id+'/drop',{});
  ctx.assert(d.status===409 && d.body.error.code==='drop_deadline_passed','late drop '+JSON.stringify(d.body));
  const w = ctx.api('POST','/enrollments/'+e1.body.id+'/withdraw',{});
  ctx.assert(w.status===200 && w.body.status==='withdrawn','withdraw '+JSON.stringify(w.body));
  ctx.advance('30d');
  const w2 = ctx.api('POST','/enrollments/'+e2.body.id+'/withdraw',{});
  ctx.assert(w2.status===409 && w2.body.error.code==='withdraw_deadline_passed','late withdraw '+JSON.stringify(w2.body));
}
```
### waitlist_expiry_job
- Intent: After the add deadline the daily job clears waitlists but keeps enrolled students
- Actions: enroll_student
- Description: A waitlisted student is dropped by the waitlist_expiry job once the add deadline has passed. The enrolled student is untouched.

```js
(ctx) => {
  const term = ctx.api('POST','/terms',{name:'T-expiry',add_deadline:'2026-10-20T00:00:00.000Z',drop_deadline:'2026-10-25T00:00:00.000Z',withdraw_deadline:'2026-11-20T00:00:00.000Z'}).body;
  const c = ctx.api('POST','/courses',{code:'TST501',title:'Expiry test',credits:3}).body;
  const sec = ctx.api('POST','/sections',{course_id:c.id,term_id:term.id,section_code:'01',capacity:1,waitlist_capacity:1}).body;
  const s1 = ctx.api('POST','/students',{name:'Expiry One',email:'expiry1@test.example'}).body;
  const s2 = ctx.api('POST','/students',{name:'Expiry Two',email:'expiry2@test.example'}).body;
  const e1 = ctx.api('POST','/sections/'+sec.id+'/enroll',{student_id:s1.id}).body;
  const e2 = ctx.api('POST','/sections/'+sec.id+'/enroll',{student_id:s2.id}).body;
  ctx.assert(e2.status==='waitlisted','setup '+JSON.stringify(e2));
  const r = ctx.advance('12d');
  ctx.assert(r.jobsFired.includes('waitlist_expiry'),'job fired '+JSON.stringify(r));
  const g2 = ctx.api('GET','/enrollments/'+e2.id).body;
  const g1 = ctx.api('GET','/enrollments/'+e1.id).body;
  ctx.assert(g2.status==='dropped','waitlisted dropped '+JSON.stringify(g2));
  ctx.assert(g1.status==='enrolled','enrolled kept '+JSON.stringify(g1));
  const after = ctx.api('GET','/sections/'+sec.id).body;
  ctx.assert(after.waitlist_count===0 && after.enrolled_count===1,'counts '+JSON.stringify(after));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_terms` | GET | /terms | List terms |
| `get_term` | GET | /terms/{id} | Get a term |
| `create_term` | POST | /terms | Create a term |
| `list_courses` | GET | /courses | List and search courses |
| `get_course` | GET | /courses/{id} | Get a course |
| `create_course` | POST | /courses | Create a course |
| `list_prerequisites` | GET | /prerequisites | List prerequisites, filter by course |
| `create_prerequisite` | POST | /prerequisites | Create a prerequisite |
| `list_students` | GET | /students | List and search students |
| `get_student` | GET | /students/{id} | Get a student |
| `create_student` | POST | /students | Create a student |
| `list_sections` | GET | /sections | List sections, filter by term and course |
| `get_section` | GET | /sections/{id} | Get a section |
| `create_section` | POST | /sections | Create a section |
| `update_section` | PATCH | /sections/{id} | Update section caps |
| `list_enrollments` | GET | /enrollments | List enrollments, filter by student, section, status |
| `get_enrollment` | GET | /enrollments/{id} | Get an enrollment |

## Seed

- Rows per entity: term: 3, course: 16, prerequisite: 10, student: 45, section: 24, enrollment: 90
- Mix: Terms: Spring 2026 (past, completed enrollments with grades), Fall 2026 (current: add deadline 2026-10-16, drop 2026-10-30, withdraw 2026-11-20), Spring 2027 (future). Some Fall 2026 sections are full with waitlists. Include students with near-duplicate names (Omar Haddad / Omar Haddadi), a prerequisite chain CS 101 > CS 201 > CS 310 with min grades, completed rows with grades A to F, one course with sections 01, 02, 03 where 01 has five enrolled students, 02 has three free seats and 03 has one, and sections with a waitlist of two or more.
- State mix: enrollment: enrolled 40%, waitlisted 12%, dropped 10%, withdrawn 6%, completed 32%

## Tasks

- `enroll_maya_cs201` (easy): Register the student Maya Chen for CS 201 in Fall 2026 (a section with an open seat and prerequisite met).
  - Actions: `enroll_student`
  - Decoy idea: Enroll Maya in the Spring 2027 CS 201 section or enroll a different student with a similar name.
- `drop_omar_promote` (medium, misleading_text): Drop the student Omar Haddad (not Omar Haddadi) from the full CS 310 Fall 2026 section so the first waitlisted student receives the seat.
  - Actions: `drop_enrollment`
  - Decoy idea: Drop Omar Haddadi, or withdraw instead of drop, leaving the waitlist unpromoted.
  - Pressure: seeded rows in enrollment.enrolled, enrollment.waitlisted; distractor rows of enrollment
- `cancel_cs120_section_01` (hard, policy_conflict): CS 120 section 01 is cancelled. Move each of its enrolled students into section 02 or 03, whichever has a free seat. A student who cannot be placed because both sections are full stays enrolled in 01 and is unchanged. Never waitlist a moved student.
  - Actions: `drop_enrollment`, `enroll_student`
  - Decoy idea: Drop every student from section 01 first and enroll them afterwards, so the one student with no free seat ends on a waitlist or is left unenrolled.
  - Pressure: seeded rows in enrollment.enrolled; distractor rows of enrollment

## Open questions

- Should a waitlisted student be auto-promoted when a seat frees?
  - Default answer: Yes, the first waitlisted student by position is promoted inside drop and withdraw.
- Are prerequisites satisfied by a passing grade only, or also by concurrent enrollment?
  - Default answer: Only by a completed enrollment with at least the minimum grade.
- What happens to waitlisted students once the add deadline passes?
  - Default answer: A daily job drops them.
- Do we model time conflicts or credit limits?
  - Default answer: No, out of scope.

## Assumptions

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

## Out of scope

- Meeting times, room scheduling and time-conflict checks
  - Why: Adds a large scheduling model without changing the core registration workflow.
- Tuition, billing and credit-load limits
  - Why: A separate finance domain.
- Authentication and advisor/instructor roles
  - Why: The API acts as the registrar.
- Co-requisites and permission overrides
  - Why: Only prerequisites are planned.

## Changes

None. The plan changes no existing item.
