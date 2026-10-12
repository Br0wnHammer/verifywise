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
`updateIncident(organizationId, incidentId, updates, userId, { transaction?, changedBySystem? })`
in `Servers/services/incidentManagement.service.ts`. Callers: the HTTP update
(`PATCH /ai-incident-managements/:id`), the AI Advisor tools
`agent_update_incident` / `agent_update_incident_status`, and integrations such
as issue-tracker sync. It:

1. Loads the incident once, `SELECT ... FOR UPDATE OF i` inside the transaction
   (its own, or the caller's when `transaction` is passed; it only commits or
   rolls back a transaction it opened), so concurrent updates serialise.
2. Applies the reopen approval reset.
3. Calls `updateIncidentByIdQuery` with the loaded row, which writes only the
   columns whose value differs from the stored one (plus `updated_at`) and
   ignores keys that are not updatable columns.
4. Records every changed field in `incident_change_history` as `userId`, or,
   with `changedBySystem: true`, with a null actor and `changed_by_system = true`
   (shown as "System"). With neither, no history is written.

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
