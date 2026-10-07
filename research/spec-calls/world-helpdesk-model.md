# Spec calls: world-helpdesk-model (YOS-20)

Precedence (standing order 16): the work order's Acceptance beats research/helpdesk-expected-behaviour.md. The world follows that table everywhere except where an Acceptance line forces a difference.

- Call: ticket.status keeps the table's states (new, open, escalated, resolved, closed, initial new) and adds pending, which the table lacks. Why: Acceptance 2 requires pending. pending sits between open and escalated/resolved (open <-> pending, pending -> escalated | resolved) with no edge into it from escalated, so the table's "no de-escalation" still holds. Reversible: yes.
- Call: ticket.status is writable, not readonly as in the table. Why: Acceptance 2 says open -> escalated is declared "so a plain PATCH can make that move", and actions do not exist yet. Every pair the table forbids is still refused, by the store (422 state.transition) instead of by an action (409). Reversible: yes, world-helpdesk-workflow can make status readonly once its actions exist.
- Call: POST /tickets is a plain create route, and customer_id and priority are writable, where the table has a create_ticket action and readonly fields. Why: Acceptance 3 requires a create route for tickets, and the store refuses readonly fields on API create. Reversible: yes, world-helpdesk-workflow replaces the route with the action and tightens both fields.
- Call: sla_due_at is nullable and sla_started_at defaults to now. Why: a plain create cannot compute the policy target; the workflow fills sla_due_at. Reversible: yes.
- Call: ticket_comment (Acceptance 1) and ticket_event (table) both exist. Why: each source requires one. Reversible: yes.
- Call: ticket has no sla_policy ref; sla_policy is joined by its unique code `<tier>_<priority>`, as in the table. Why: follows the table; the engine has no composite unique. Reversible: yes.
- Call: ref fields end in _id (customer_id, assignee_id, agent_id, ticket_id, author_id, actor_id) and on-call is listed at /oncall. Why: the table's routes and task solutions use those names. Supersedes the round-1 call that dropped the suffix. Reversible: yes.
- Call: added GET /tickets/{ticket_id}/comments and kept POST/PATCH /customers. Why: Acceptance 3 asks for customer create/update; comments need a read route. Reversible: yes.
