# bd Task Naming and Quality Guidelines

This guide covers best practices for naming tasks, setting priorities, sizing work, and defining success criteria.

## Task Naming Conventions

### Principles

- **Actionable**: Start with action verbs (add, fix, update, remove, refactor, implement)
- **Specific**: Include enough context to understand without opening
- **Consistent**: Follow project-wide templates

### Templates by Task Type

#### User Stories

**Template:**
```
As a [persona], I want [something] so that [reason]
```

**Examples:**
```
As a customer, I want one-click checkout so that I can purchase quickly
As an admin, I want bulk user import so that I can onboard teams efficiently
As a developer, I want API rate limiting so that I can prevent abuse
```

**When to use:** Features from user perspective

#### Bug Reports

**Template 1 (Capability-focused):**
```
[User type] can't [action they should be able to do]
```

**Examples:**
```
New users can't view home screen after signup
Admin users can't export user data to CSV
Guest users can't add items to cart
```

**Template 2 (Event-focused):**
```
When [action/event], [system feature] doesn't work
```

**Examples:**
```
When clicking Submit, payment form doesn't validate
When uploading large files, progress bar freezes
When session expires, user isn't redirected to login
```

**When to use:** Describing broken functionality

#### Tasks (Implementation Work)

**Template:**
```
[Verb] [object] [context]
```

**Examples:**
```
feat(auth): Implement JWT token generation
fix(api): Handle empty email validation in user endpoint
test: Add integration tests for payment flow
refactor: Extract validation logic from UserService
docs: Update API documentation for v2 endpoints
```

**When to use:** Technical implementation tasks

#### Features (High-Level Capabilities)

**Template:**
```
[Verb] [capability] for [user/system]
```

**Examples:**
```
Add dark mode toggle for Settings page
Implement rate limiting for API endpoints
Enable two-factor authentication for admin users
Build export functionality for report data
```

**When to use:** Feature-level work (may become epic with multiple tasks)

### Context Guidelines

- **Which component**: "in login flow", "for user API", "in Settings page"
- **Which user type**: "for admins", "for guests", "for authenticated users"
- **Avoid jargon** in user stories (user perspective, not technical)
- **Be specific** in technical tasks (exact API, file, function)

### Good vs Bad Names

**Good names:**
- `feat(auth): Implement JWT token generation`
- `fix(api): Handle empty email validation in user endpoint`
- `As a customer, I want CSV export so that I can analyze my data`
- `test: Add integration tests for payment flow`
- `refactor: Extract validation logic from UserService`

**Bad names:**
- `fix stuff` (vague - what stuff?)
- `implement feature` (vague - which feature?)
- `work on backend` (vague - what work?)
- `Report` (noun, not action - should be "Generate Q4 Sales Report")
- `API endpoint` (incomplete - "Add GET /users endpoint" better)

## Priority Guidelines

Use bd's priority system consistently:

- **P0:** Critical production bug (drop everything)
- **P1:** Blocking other work (do next)
- **P2:** Important feature work (normal priority)
- **P3:** Nice to have (do when time permits)
- **P4:** Someday/maybe (backlog)

## Granularity Guidelines

**Good task size:**
- 2-4 hours of focused work
- Can complete in one sitting
- Clear deliverable

**Too large:**
- Takes multiple days
- Multiple independent pieces
- Should be split

**Too small:**
- Takes 15 minutes
- Too granular to track
- Combine with related tasks

## Success Criteria: Acceptance Criteria vs. Definition of Done

**Two distinct types of completion criteria:**

### Acceptance Criteria (Per-Task, Functional)

**Definition:** Specific, measurable requirements unique to each task that define functional completeness from user/business perspective.

**Scope:** Unique to each backlog item (bug, task, story)

**Purpose:** "Does this feature work correctly?"

**Owner:** Product owner/stakeholder defines, team validates

**Format:** Checklist or scenarios

```markdown
## Acceptance Criteria
- [ ] User can upload CSV files up to 10MB
- [ ] System validates CSV format before processing
- [ ] User sees progress bar during upload
- [ ] User receives success message with row count
- [ ] Invalid files show specific error messages
```

**Scenario format (Given/When/Then):**
```markdown
## Acceptance Criteria

Scenario 1: Valid file upload
Given a user is on the upload page
When they select a valid CSV file
Then the file uploads successfully
And they see confirmation with row count

Scenario 2: Invalid file format
Given a user selects a non-CSV file
When they try to upload
Then they see error: "Only CSV files supported"
```

### Definition of Done (Universal, Quality)

**Definition:** Universal checklist that applies to ALL work items to ensure consistent quality and release-readiness.

**Scope:** Applies to every single task (bugs, features, stories)

**Purpose:** "Is this work complete to our quality standards?"

**Owner:** Team defines and maintains (reviewed in retrospectives)

**Example DoD:**
```markdown
## Definition of Done (applies to all tasks)
- [ ] Code written and peer-reviewed
- [ ] Unit tests written and passing (>80% coverage)
- [ ] Integration tests passing
- [ ] No linter warnings
- [ ] Documentation updated (if public API)
- [ ] Manual testing completed (if UI)
- [ ] Deployed to staging environment
- [ ] Product owner accepted
- [ ] Commit references bd task ID
```

### Key Differences

| Aspect | Acceptance Criteria | Definition of Done |
|--------|--------------------|--------------------|
| **Scope** | Per-task (unique) | All tasks (universal) |
| **Focus** | Functional requirements | Quality standards |
| **Question** | "Does it work?" | "Is it done?" |
| **Owner** | Product owner | Team |
| **Changes** | Per task | Rarely (retrospectives) |
| **Examples** | "User can export data" | "Tests pass, code reviewed" |

### How to Use Both

**When creating a task:**

1. **Define Acceptance Criteria** (task-specific functional requirements)
2. **Reference Definition of Done** (don't duplicate it in task)

```markdown
tm create "Implement CSV file upload" --design "
## Acceptance Criteria
- [ ] User can upload CSV files up to 10MB
- [ ] System validates CSV format
- [ ] Progress bar shows during upload
- [ ] Success message displays row count

## Notes
Must also meet team's Definition of Done (see project wiki)
"
```

**Before closing a task:**

1. ✅ Verify all Acceptance Criteria met (functional)
2. ✅ Verify Definition of Done met (quality)
3. Only then close task

**Bad practice:**
```markdown
## Success Criteria
- [ ] CSV upload works
- [ ] Tests pass          ← This is DoD, not acceptance criteria
- [ ] Code reviewed       ← This is DoD, not acceptance criteria
- [ ] No linter warnings  ← This is DoD, not acceptance criteria
```

**Good practice:**
```markdown
## Acceptance Criteria (functional, task-specific)
- [ ] CSV upload handles files up to 10MB
- [ ] Validation rejects non-CSV formats
- [ ] Progress bar updates during upload

## Definition of Done (quality, universal - referenced, not duplicated)
See team DoD checklist (applies to all tasks)
```

## Dependency Management

**Good dependency usage:**
- Technical dependency (feature B needs feature A's code)
- Clear ordering (must do A before B)
- Unblocks work (completing A unblocks B)

**Bad dependency usage:**
- "Feels like should be done first" (vague)
- No technical relationship (just preference)
- Circular dependencies (A depends on B depends on A)
