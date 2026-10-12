# Incident Management Domain

## Overview

Incident Management in VerifyWise provides a comprehensive system for tracking, investigating, and resolving AI-related incidents. It supports EU AI Act Article 73 compliance for serious incident reporting, with approval workflows, change tracking, and integration with CE marking documentation.

## Key Features

- Incident lifecycle management (Open → Investigating → Mitigated → Closed, plus Suspended and Emergency action; closed incidents can be reopened)
- Multi-level severity classification (Minor, Serious, Very Serious)
- Approval workflow with audit trail
- Harm category tracking
- Field-level change history
- CE marking integration for regulatory compliance
- Automation triggers for notifications
- AI advisor integration for analytics

## Database Schema

### Incident Management Table

```
ai_incident_managements
├── id (PK, SERIAL)
├── incident_id (TEXT, UNIQUE) -- Auto-generated: INC-[sequence]
├── ai_project (TEXT NOT NULL)
├── type (ENUM)
├── severity (ENUM)
├── occurred_date (TIMESTAMPTZ NOT NULL)
├── date_detected (TIMESTAMPTZ NOT NULL)
├── reporter (TEXT NOT NULL)
├── status (ENUM, default: Open)
├── categories_of_harm (JSON NOT NULL)
├── affected_persons_groups (TEXT)
├── description (TEXT NOT NULL)
├── relationship_causality (TEXT)
├── immediate_mitigations (TEXT)
├── planned_corrective_actions (TEXT)
├── model_system_version (TEXT)
├── interim_report (BOOLEAN, default: false)
├── approval_status (ENUM, default: Pending)
├── approved_by (TEXT)
├── approval_date (TIMESTAMPTZ)
├── approval_notes (TEXT)
├── archived (BOOLEAN, default: false)
├── created_at (TIMESTAMPTZ)
└── updated_at (TIMESTAMPTZ)
```

### Incident Change History Table

```
incident_change_history
├── id (PK, SERIAL)
├── incident_id (FK → ai_incident_managements)
├── action (created/updated/deleted)
├── field_name (VARCHAR)
├── old_value (TEXT)
├── new_value (TEXT)
├── changed_by_user_id (FK → users)
├── changed_at (TIMESTAMP)
└── created_at (TIMESTAMP)
```

### CE Marking Incidents Table

```
ce_marking_incidents (junction table)
├── id (PK, SERIAL)
├── ce_marking_id (FK → ce_markings)
├── incident_id (FK → ai_incident_managements)
├── linked_at (TIMESTAMP)
└── linked_by (INTEGER)
```

## Enumerations

### Incident Status

```typescript
enum AIIncidentManagementStatus {
  OPEN = "Open"
  INVESTIGATING = "Investigating"
  MITIGATED = "Mitigated"
  CLOSED = "Closed"
  SUSPENDED = "Suspended"
  EMERGENCY_ACTION = "Emergency action"
}
```

### Approval Status

```typescript
enum AIIncidentManagementApprovalStatus {
  PENDING = "Pending"
  APPROVED = "Approved"
  REJECTED = "Rejected"
  NOT_REQUIRED = "Not required"
}
```

### Severity

```typescript
enum Severity {
  MINOR = "Minor"
  SERIOUS = "Serious"
  VERY_SERIOUS = "Very serious"
}
```

### Incident Type

```typescript
enum IncidentType {
  MALFUNCTION = "Malfunction"
  UNEXPECTED_BEHAVIOR = "Unexpected behavior"
  MODEL_DRIFT = "Model drift"
  MISUSE = "Misuse"
  DATA_CORRUPTION = "Data corruption"
  SECURITY_BREACH = "Security breach"
  PERFORMANCE_DEGRADATION = "Performance degradation"
}
```

### Harm Category

```typescript
enum HarmCategory {
  HEALTH = "Health"
  SAFETY = "Safety"
  FUNDAMENTAL_RIGHTS = "Rights"
  PROPERTY = "Property"
  ENVIRONMENT = "Environment"
}
```

## API Endpoints

### Incident CRUD

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/aiIncidentManagement/` | Get all incidents |
| GET | `/aiIncidentManagement/:id` | Get incident by ID |
| POST | `/aiIncidentManagement/` | Create incident |
| PATCH | `/aiIncidentManagement/:id` | Update incident |
| PATCH | `/aiIncidentManagement/:id/archive` | Archive incident |
| DELETE | `/aiIncidentManagement/:id` | Delete incident |

### Change History

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/incident-change-history/:incidentId` | Get change history |

Query params: `limit`, `offset` for pagination

## Create Incident Request

```typescript
POST /aiIncidentManagement/
{
  ai_project: "Customer Service Chatbot",
  type: "Unexpected behavior",
  severity: "Serious",
  occurred_date: "2025-01-15T10:30:00Z",
  date_detected: "2025-01-15T11:00:00Z",
  reporter: "John Smith",
  status: "Open",
  categories_of_harm: ["Safety", "Rights"],
  affected_persons_groups: "End users",
  description: "AI provided incorrect medical advice...",
  relationship_causality: "Direct causal relationship",
  immediate_mitigations: "Service temporarily suspended",
  planned_corrective_actions: "Implement guardrails",
  model_system_version: "GPT-4-turbo v1.2"
}
```

## Incident Lifecycle

### Status Workflow

```
[Open] → [Investigating] → [Mitigated] → [Closed]
   ↑                                         │
   └──────────── reopen (any status) ────────┘

[Suspended] and [Emergency action] can be entered from, and left to, any status.
```

There is no transition table: an update may move an incident from any status to
any other, including from Closed back to an open status (reopening). Reopening
is needed for two-way sync with issue trackers, where a closed issue can be
reopened.

### Business Rules

- `date_detected` must be >= `occurred_date` (creation only)
- Status transitions are unrestricted; Closed incidents can be reopened
- Reopening a Closed incident whose `approval_status` is `Approved` resets it to
  `Pending` and clears `approved_by`, `approval_date` and `approval_notes`
  (see below)
- Archived incidents remain in database (soft delete); archiving does not depend
  on status, and reopening does not change the `archived` flag

### Approval Workflow

```
[Pending] → [Approved] → (approval_date set)
    ↓
[Rejected]
    ↓
[Not required]
```

Stored values are those of `AIIncidentManagementApprovalStatus`
(`Servers/domain.layer/enums/ai-incident-management.enum.ts`): `Pending`,
`Approved`, `Rejected`, `Not required`. The column is `VARCHAR(20)`, not a DB
enum. `APPROVAL_STATUS_ENUM` in the validation utils still lists
`Not Required` (capital R) and the edit form labels the option that way, but
the value the form saves is `Not required`.

When approved:
- `approved_by` populated with approver name
- `approval_date` set to current timestamp
- `approval_notes` optional comments

Approval is sign-off on closing the incident. When a Closed incident is reopened
(status moves from `Closed` to anything else) and its stored approval is
`Approved`, that sign-off no longer describes it, so `applyReopenApprovalReset`
(`Servers/utils/validations/incidentManagementValidation.utils.ts`) rewrites the
update to `approval_status = Pending` with `approved_by`, `approval_date` and
`approval_notes` set to null. Change history keeps the old values. `Pending`,
`Rejected` and `Not required` are left as they are.

If the same update changes **any** approval field (`approval_status`,
`approved_by`, `approval_date`, `approval_notes` with a value different from the
stored one), the caller has made an explicit approval decision and the update is
kept as sent. A field sent back with its stored value counts as "not touched"
(the edit form always sends every field; `''` and null are treated as the same,
dates are compared as instants). So keeping an incident `Approved` through a
reopen is not possible by resubmitting the old approval: it needs a deliberate
re-approval in a later update.

### Shared update path

All updates to an existing incident go through
`updateIncident(organizationId, incidentId, updates, userId, { transaction?, changedBySystem?, expectedUpdatedAt? })`
in `Servers/services/incidentManagement.service.ts`. Callers today: the HTTP
update (`PATCH /ai-incident-managements/:id`) and the AI Advisor tools
`agent_update_incident` / `agent_update_incident_status`. Integrations such as
issue-tracker sync are meant to use it too. In order, it:

1. Loads the incident once, `SELECT ... FOR UPDATE OF i` inside the transaction
   (its own, or the caller's when `transaction` is passed; it only commits or
   rolls back a transaction it opened), so concurrent updates serialise.
2. If `expectedUpdatedAt` is given and differs from the stored `updated_at`,
   throws `ConflictException`: "This incident was changed since you opened it.
   Reload to see the latest version." The controller answers 409. A present but
   malformed value (empty, null, not a date-time) is a 400 validation error
   (`expected_updated_at`, `INVALID_DATE`), checked before any read.
   `getIncidentByIdQuery` maps rows onto the model (`timestamps: true`,
   `underscored: true`), so the `updated_at` column is on `updatedAt`, not on
   `dataValues.updated_at`; the check reads `existing.updatedAt` like
   `toSafeJSON` does.
   The edit drawer sends the `updated_at` it loaded as `expected_updated_at`. On
   409 the page refetches the incident, merges its latest `updated_at` into the
   open form (keeping the user's edits) and says the incident was changed by
   someone else and that saving again overwrites their change; the next save
   goes through. The global axios toast is suppressed for this `CONFLICT` so
   only the page alert shows. Any other save failure also keeps the drawer
   open with the user's edits. The page memoises the drawer's `initialData` on
   the selected incident so re-renders never reset the form.
   Background writers (AI Advisor, sync jobs) do not pass `expectedUpdatedAt`.
3. Validates against the locked row: `validateCompleteIncidentUpdate` and
   `validateIncidentReferences` (FKs must belong to the organization; unchanged
   FKs come from the row; `''`, null and undefined mean "no reference" and are
   not looked up). Failures throw `IncidentUpdateValidationError`; the
   controller keeps its 400 body (`message: "Incident update validation failed"`,
   `errors: [{ field, message, code }]`).
4. Applies the reopen approval reset.
5. Diffs the update against the row with `diffIncidentColumns`
   (`Servers/utils/incidentManagement.utils.ts`). Keys that are not updatable
   columns are ignored. Values go through the same `isSameIncidentValue` helper
   (`incidentManagementValidation.utils.ts`) that the reset uses to decide
   whether an approval field was touched:
   - `''`, null and undefined are all empty;
   - date columns compare **calendar dates** (`incidentCalendarDate`). The
     columns are TIMESTAMP WITHOUT TIME ZONE and the project installs no custom
     pg type parser, so pg parses them (oid 1114) as server-local time: a stored
     Date is read by its local components (the wall-clock date stored), and a
     string starting `YYYY-MM-DD` is that date (Postgres ignores any offset for
     this column type). The model's `toSafeJSON` / `toJSON` serialise
     `occurred_date`, `date_detected` and `approval_date` as that wall-clock time
     with a `Z` suffix (identical to `toISOString()` on a UTC server), so the
     date part the drawer sends back agrees in any server time zone;
   - foreign keys compare as numbers, `archived` / `interim_report` treat empty
     as false, harm categories compare as lists.
   `archived` is never written as NULL.
6. If nothing changed, returns the row as it is: no UPDATE, no `updated_at`
   bump, no history, no automations.
7. Otherwise writes exactly the changed columns plus `updated_at`
   (`updateIncidentByIdQuery`) and records exactly those columns in
   `incident_change_history` (`formatEntityFieldChanges`). That includes
   `model_inventory_id` ("Affected model"), `project_id` ("Linked use case") and
   `assignee_id` ("Owner"), shown by name, falling back to `Model #id` /
   `Use case #id` / `User #id`. The name lookups are tenant-scoped
   (`AND organization_id = :organizationId`) and run on the update transaction
   (the connection holding the row lock), via the `FormatterContext` that
   `formatEntityFieldChanges` passes to field formatters. The project and model
   formatters do not query at all without an organization. The generic user
   formatter is scoped when given an organization; other entities' history
   callers do not pass one yet and keep the old unscoped user lookup. History is recorded as `userId`, or, with
   `changedBySystem: true`, with a null actor and `changed_by_system = true`
   (shown as "System"). The AI Advisor uses the system form when its execution
   carries no user id.
8. Enqueues the `incident_updated` automation (`enqueueIncidentUpdatedAutomations`)
   in `transaction.afterCommit`, so nothing is sent for a rolled-back change.

It returns the updated incident, or `null` when the incident does not exist in
the organization.

## Change Tracking

All incident modifications are tracked:

| Event | Recorded |
|-------|----------|
| Creation | All initial field values |
| Update | Field-by-field changes (old → new) |
| Deletion | Deletion event |
| Archival | Archived flag change |

### Change History Entry

```typescript
{
  incident_id: number,
  action: "created" | "updated" | "deleted",
  field_name: string,
  old_value: string,
  new_value: string,
  changed_by_user_id: number,
  changed_at: Date
}
```

## Frontend Structure

### Main Page

**Location:** `pages/IncidentManagement/index.tsx`

**Features:**
- Incident list with filtering
- Filter by: incident_id, ai_project, type, severity, status, approval_status
- Group by support
- Search functionality
- Role-based create (Admin/Editor only)
- Export functionality

### Key Components

| Component | Purpose |
|-----------|---------|
| `IncidentManagement` | Main page |
| `IncidentTable` | Sortable, paginated table |
| `NewIncident` | Create/edit/view modal |
| `IncidentStatusCard` | Metrics display |
| `IncidentManagementSteps` | User onboarding tour |

### Incident Modal Sections

The modal is organized into 4 sections:

1. **Incident Information**
   - Project, type, severity
   - Status, dates
   - Reporter, model version

2. **Impact Assessment**
   - Harm categories (multi-select)
   - Affected persons/groups
   - Description
   - Relationship/causality

3. **Response & Actions**
   - Immediate mitigations
   - Planned corrective actions

4. **Approval & Reporting**
   - Approval status
   - Approver, approval date
   - Approval notes
   - Interim report toggle

### Table Features

- 8 sortable columns
- Pagination with localStorage persistence
- Sort state persistence
- Row options: 5, 10, 15, 25
- Color-coded status/severity chips
- Edit, archive, view actions
- Confirmation dialogs

## Validation Rules

### Field Validation

| Field | Rule |
|-------|------|
| description | 5-1000 characters |
| categories_of_harm | At least one required |
| relationship_causality | 3-255 characters |
| ai_project | 2-255 characters |
| reporter | 2-100 characters |
| severity | Valid enum value |
| status | Valid enum value |
| approval_status | Valid enum value |
| occurred_date | Required |
| date_detected | Required, >= occurred_date |

### Business Rule Validation

```typescript
// Creation rules
validateIncidentCreationBusinessRules(data) {
  if (date_detected < date_occurred) {
    throw Error("Detection date cannot be before occurrence date");
  }
}

// Update rules: none. Any status transition is allowed, including reopening.
validateIncidentUpdateBusinessRules(data, existing) {
  return [];
}

// Side effect of a reopen (applied before saving and change tracking)
applyReopenApprovalReset(existing, update) // Approved → Pending on Closed → other
```

## CE Marking Integration

Incidents can be linked to CE marking records for regulatory compliance:

```
Incident ──── ce_marking_incidents ──── CE Marking
```

This supports EU AI Act Article 73 requirements for documenting serious incidents alongside conformity assessments.

## Automation Triggers

| Trigger | Event |
|---------|-------|
| `incident_added` | New incident created |
| `incident_updated` | Incident modified |
| `incident_deleted` | Incident deleted |

### Email Template Variables

For incident notifications:
- `incident.*` - Current values
- `old_incident.*` - Previous values (for updates)
- `changes_summary` - Markdown list of all changes
- `date_and_time` - Current timestamp

## AI Advisor Integration

### Available Tools

| Tool | Purpose |
|------|---------|
| `fetch_incidents` | Query with filters |
| `get_incident_analytics` | Analytics dashboard |
| `get_incident_executive_summary` | High-level overview |

### Analytics Capabilities

- Type distribution
- Severity distribution
- Status distribution
- Harm categories breakdown
- Incidents by project
- Resolution progress metrics

## EU AI Act Compliance

The incident management system supports Article 73 requirements:

- **Serious Incident Reporting**: Track incidents with severity levels
- **Harm Documentation**: Categories align with EU AI Act harm types
- **Audit Trail**: Complete change history for regulatory review
- **CE Marking Link**: Associate incidents with conformity assessments
- **Interim Reports**: Flag for ongoing incident reporting

## Key Files

### Backend

| File | Purpose |
|------|---------|
| `domain.layer/models/incidentManagement/incidemtManagement.model.ts` | Model |
| `domain.layer/interfaces/i.aiIncidentManagement.ts` | Interface |
| `domain.layer/enums/ai-incident-management.enum.ts` | Enums |
| `utils/incidentManagement.utils.ts` | Queries |
| `utils/validations/incidentManagementValidation.utils.ts` | Validation |
| `utils/incidentChangeHistory.utils.ts` | History tracking |
| `utils/automation/incident.automation.utils.ts` | Automation |
| `controllers/incident-management.ctrl.ts` | Controller |
| `routes/aiIncidentManagement.route.ts` | Routes |
| `advisor/tools/incidentTools.ts` | AI tools |

### Frontend

| File | Purpose |
|------|---------|
| `pages/IncidentManagement/index.tsx` | Main page |
| `pages/IncidentManagement/IncidentTable.tsx` | Table component |
| `components/Modals/NewIncident/index.tsx` | Modal |
| `domain/enums/aiIncidentManagement.enum.ts` | Client enums |
| `domain/models/Common/incidentManagement/` | Client model |

## Related Documentation

- [Risk Management](./risk-management.md)
- [Use Cases](./use-cases.md)
- [Compliance Frameworks](./compliance-frameworks.md)
