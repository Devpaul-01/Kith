# ADR-0003: Resource-Based Router Splitting

**Status:** Accepted

## Context

`workspace.routes.js` is the parent router for every workspace-scoped
resource — members, groups, containers, participants, ledger, disputes,
tasks, milestones. Express matches routes in registration order, so a
router mixing static paths (`/settings`) and dynamic paths (`/:memberId`)
across many unrelated resources in one file makes ordering a global
invariant — any new route added in the wrong place could silently shadow
an existing one.

## Problem Statement

How do you keep Express's "declare static paths before dynamic ones"
constraint from being a project-wide hazard that any contributor touching
any route must remember, across a growing number of unrelated resources?

## Decision

Split the workspace router into one `express.Router({ mergeParams: true
})` per resource:

- `member.routes.js`, `group.routes.js`, `container.routes.js`,
  `participant.routes.js`, `ledger.routes.js`, `dispute.routes.js`,
  `task.routes.js`, `milestone.routes.js`, `workspace-invites.routes.js`
- Each is mounted in `workspace.routes.js` at the exact path prefix it
  logically owns (e.g. `router.use('/members', require('./member.routes'))`),
  so the external API surface stays exactly as documented.
- Nested resources mount their own children the same way: `container.
  routes.js` mounts `participant.routes.js`, `ledger.routes.js`, and
  `task.routes.js` under `/:containerId/...`.
- The static-before-dynamic ordering constraint still exists, but is now
  scoped to individual small files (e.g. `ledger.routes.js` has one
  comment noting `/summary` must be declared before `/:entryId`) instead of
  competing across dozens of routes in one file.

`workspace.routes.js` retains only its own directly-owned resource
(workspace CRUD, dashboard, settings, search, announce, audit log, ledger
export) plus the `router.use(...)` mount calls for every sub-resource,
alongside the workspace-wide middleware chain
(`requireAuth, loadDbUser, requireMembership, userGeneralLimiter`) applied
once at the top so every mounted sub-router inherits it.

## Alternatives Considered

- **Keep one file, rely on internal comments/conventions to manage route
  ordering.** Rejected — the ordering hazard persists as the route count
  grows regardless of how well-commented a single large file is.
  <br>
- **Split by HTTP verb or by CRUD operation instead of by resource.** Not
  considered a real alternative here — splitting by resource keeps all
  routes for one concept (e.g. all task routes) in one reviewable file,
  which matches how the corresponding controllers and services are already
  organized. Splitting by verb would scatter a single resource's routes
  across multiple files for no benefit.

## Rationale

Resource-based splitting mirrors the existing controller/service split
(ADR-0002) — `task.routes.js` maps to `task.controller.js` maps to
`task.service.js` — so the file tree reads consistently whether you enter
from routing, HTTP handling, or business logic. It also shrinks the blast
radius of a route-ordering mistake from "affects every route across every
resource" to "affects the dozen routes in this one file."

## Trade-offs

- Nested resources (e.g. a task route inside a container inside a
  workspace) require `{ mergeParams: true }` at every level of nesting to
  keep `:workspaceId`/`:containerId` available — an easy detail to forget
  when adding a new nested router, though every existing router already
  does this consistently.
- Many small files exist where one large file used to. Finding "every
  route in the workspace tree" now requires either reading
  `workspace.routes.js`'s mount list or grep, rather than scrolling one
  file.

## Consequences

- Adding a new route to an existing resource only requires understanding
  that resource's ordering constraints, not the whole tree's.
- The workspace-wide middleware chain
  (`requireAuth → loadDbUser → requireMembership → userGeneralLimiter`) is
  applied exactly once, in `workspace.routes.js`, and every sub-router
  correctly inherits it — this is the same reasoning that makes
  `userGeneralLimiter` safe to key by `req.user.id` (see ADR-0006): by the
  time any sub-router's handler runs, auth has already resolved.
- `public.routes.js` and `invite.routes.js` remain deliberately outside
  this workspace-scoped tree, since they represent genuinely
  unauthenticated or legacy top-level concerns rather than a resource
  nested under a workspace.

## Related Files

- `src/routes/workspace.routes.js` (parent router + mount points)
- `src/routes/member.routes.js`
- `src/routes/group.routes.js`
- `src/routes/container.routes.js`
- `src/routes/participant.routes.js`
- `src/routes/ledger.routes.js`
- `src/routes/dispute.routes.js`
- `src/routes/task.routes.js`
- `src/routes/milestone.routes.js`
- `src/routes/workspace-invites.routes.js`
