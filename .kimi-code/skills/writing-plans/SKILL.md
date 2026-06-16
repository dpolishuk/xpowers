---
name: writing-plans
description: Use to expand bd tasks with detailed implementation steps - adds exact file paths, complete code, verification commands assuming zero context
---

<kimi_compat>
This skill was ported to Kimi Code CLI. In Kimi:
- Load skills with `/skill:name` or let the model invoke them automatically.
- "SetTodoList" means use the `SetTodoList` tool.
- "Agent()" / "Agent" means use the built-in `Agent` tool.
- "parallel Agent calls with run_in_background=true" means dispatch multiple `Agent` calls with `run_in_background=true`.
- Claude-specific hooks and slash commands are not available; skip those steps.
</kimi_compat>
<skill_overview>
Enhance bd tasks with comprehensive implementation details for engineers with zero codebase context. Expand checklists into explicit steps: which files, complete code examples, exact commands, verification steps.
</skill_overview>

<rigidity_level>
MEDIUM FREEDOM - Follow task-by-task validation pattern, use codebase-investigator for verification.

Adapt implementation details to actual codebase state. Never use placeholders or meta-references.
</rigidity_level>

<quick_reference>

| Step | Action | Critical Rule |
|------|--------|---------------|
| **Identify Scope** | Single task, range, or full epic | No artificial limits |
| **Verify Codebase** | Use `codebase-investigator` agent | NEVER verify yourself, report discrepancies |
| **Draft Steps** | Write bite-sized (2-5 min) actions | Follow TDD cycle for new features |
| **Present to User** | Show COMPLETE expansion FIRST | Then ask for approval |
| **Update bd** | `tm update bd-N --design "..."` | Only after user approves |
| **Continue** | Move to next task automatically | NO asking permission between tasks |

**FORBIDDEN:** Placeholders like `[Full implementation steps as detailed above]`
**REQUIRED:** Actual content - complete code, exact paths, real commands

</quick_reference>

<when_to_use>
**Use after /skill:sre-task-refinement or anytime tasks need more detail.**

Symptoms:
- bd tasks have implementation checklists but need expansion
- Engineer needs step-by-step guide with zero context
- Want explicit file paths, complete code examples
- Need exact verification commands

</when_to_use>

<the_process>

## 1. Identify Tasks to Expand

**User specifies scope:**
- Single: "Expand bd-2"
- Range: "Expand bd-2 through bd-5"
- Epic: "Expand all tasks in bd-1"

**If epic:**
```bash
tm dep tree bd-1  # View complete dependency tree
# Note all child task IDs
```

**Create SetTodoList tracker:**
```
- [ ] bd-2: [Task Title]
- [ ] bd-3: [Task Title]
...
```

## 2. For EACH Task (Loop Until All Done)

### 2a. Mark In Progress and Read Current State

```bash
# Mark in SetTodoList: in_progress
tm show bd-3  # Read current task design
```

### 2b. Verify Codebase State

**CRITICAL: Use codebase-investigator agent, NEVER verify yourself.**

**Provide agent with bd assumptions:**
```
Assumptions from bd-3:
- Auth service should be in src/services/auth.ts with login() and logout()
- User model in src/models/user.ts with email and password fields
- Test file at tests/services/auth.test.ts
- Uses bcrypt dependency for password hashing

Verify these assumptions and report:
1. What exists vs what bd-3 expects
2. Structural differences (different paths, functions, exports)
3. Missing or additional components
4. Current dependency versions
```

**Based on investigator report:**
- ✓ Confirmed assumptions → Use in implementation
- ✗ Incorrect assumptions → Adjust plan to match reality
- + Found additional → Document and incorporate

**NEVER write conditional steps:**
❌ "Update `index.js` if exists"
❌ "Modify `config.py` (if present)"

**ALWAYS write definitive steps:**
✅ "Create `src/auth.ts`" (investigator confirmed doesn't exist)
✅ "Modify `src/index.ts:45-67`" (investigator confirmed exists)

### 2c. Draft Expanded Implementation Steps

**Bite-sized granularity (2-5 minutes per step):**

For new features (follow test-driven-development):
1. Write the failing test (one step)
2. Run it to verify it fails (one step)
3. Implement minimal code to pass (one step)
4. Run tests to verify they pass (one step)
5. Commit (one step)

**Include in each step:**
- Exact file path
- Complete code example (not pseudo-code)
- Exact command to run
- Expected output

### 2d. Present COMPLETE Expansion to User

**CRITICAL: Show the full expansion BEFORE asking for approval.**

**Format:**
```markdown
**bd-[N]: [Task Title]**

**From bd issue:**
- Goal: [From tm show]
- Effort estimate: [From bd issue]
- Success criteria: [From bd issue]

**Codebase verification findings:**
- ✓ Confirmed: [what matched]
- ✗ Incorrect: [what issue said] - ACTUALLY: [reality]
- + Found: [unexpected discoveries]

**Implementation steps based on actual codebase state:**

### Step Group 1: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Step 1: Write the failing test**
```python
# tests/auth/test_login.py
def test_login_with_valid_credentials():
    user = create_test_user(email="test@example.com", password="secure123")
    result = login(email="test@example.com", password="secure123")
    assert result.success is True
    assert result.user_id == user.id
```

**Step 2: Run test to verify it fails**
```bash
pytest tests/auth/test_login.py::test_login_with_valid_credentials
# Expected: ModuleNotFoundError: No module named 'auth.login'
```

[... continue for all steps ...]
```

**THEN ask for approval using AskUserQuestion:**
- Question: "Is this expansion approved for bd-[N]?"
- Options:
  - "Approved - continue to next task"
  - "Needs revision"
  - "Other"

### 2e. If Approved: Update bd and Continue

```bash
tm update bd-3 --design "[paste complete expansion]"
# Mark completed in SetTodoList
# IMMEDIATELY continue to next task (NO asking permission)
```

### 2f. If Needs Revision: Iterate

- Keep as in_progress in SetTodoList
- Revise based on feedback
- Present again (step 2d)

## 3. After ALL Tasks Done

```
All bd issues now contain detailed implementation steps.
Epic ready for execution.
```

**Offer execution choice:**
"Ready to execute? I can use /skill:executing-plans to implement iteratively."

</the_process>

<examples>

<example>
<scenario>Developer writes placeholder text instead of actual implementation steps</scenario>

<code>
tm update bd-3 --design "## Goal
Implement user authentication

## Implementation
[Full implementation steps as detailed above - includes all 6 step groups with complete code examples]

## Tests
[Complete code examples will be added here]"
</code>

<why_it_fails>
**Placeholders defeat the purpose:**
- Engineer executing bd-3 has zero context
- There is no "above" to reference (bd issue is the source of truth)
- Violates "exact instructions for zero-context engineer" principle
- Makes task impossible to execute

**Common placeholder patterns (ALL FORBIDDEN):**
- `[Full implementation steps as detailed above]`
- `[See above for detailed steps]`
- `[As specified in success criteria]`
- `[Complete code examples will be added here]`
</why_it_fails>

<correction>
**Write actual content:**

```bash
tm update bd-3 --design "## Goal
Implement user authentication

## Implementation

### Step 1: Write failing login test
```python
# tests/auth/test_login.py
import pytest
from auth.service import login

def test_login_with_valid_credentials():
    result = login(email='test@example.com', password='pass123')
    assert result.success is True
```

### Step 2: Run test (should fail)
```bash
pytest tests/auth/test_login.py::test_login_with_valid_credentials
# Expected: ModuleNotFoundError: No module named 'auth.service'
```

### Step 3: Create login function
```python
# src/auth/service.py
from dataclasses import dataclass

@dataclass
class LoginResult:
    success: bool
    user_id: int | None = None

def login(email: str, password: str) -> LoginResult:
    # Minimal implementation
    return LoginResult(success=True, user_id=1)
```

[... continue for all steps with complete code ...]

## Tests
All test code included in implementation steps above following TDD cycle."
```

**Result:** Engineer can execute without any context.
</correction>
</example>

<example>
<scenario>Developer verifies codebase state themselves instead of using codebase-investigator agent</scenario>

<code>
Developer reads files manually:
- Reads src/services/auth.ts directly
- Checks package.json manually
- Assumes file structure based on quick look

Writes expansion based on quick check:
"Modify src/services/auth.ts (if exists)"
</code>

<why_it_fails>
**Manual verification problems:**
- Misses nuances (existing functions, imports, structure)
- Creates conditional steps ("if exists")
- Doesn't catch version mismatches
- Doesn't report discrepancies from bd assumptions

**Result:** Implementation plan may not match actual codebase state.
</why_it_fails>

<correction>
**Use codebase-investigator agent:**

```
Dispatch agent with bd-3 assumptions:
"bd-3 expects auth service in src/services/auth.ts with login() and logout() functions.
Verify:
1. Does src/services/auth.ts exist?
2. What functions does it export?
3. How do login() and logout() work currently?
4. Any other relevant auth code?
5. What's the bcrypt version?"
```

**Agent reports:**
```
✓ src/services/auth.ts exists
✗ ONLY has login() function - NO logout() yet
+ Found: login() uses argon2 NOT bcrypt
+ Found: Session management in src/services/session.ts
✓ argon2 version: 0.31.2
```

**Write definitive steps based on findings:**
```
Step 1: Add logout() function to EXISTING src/services/auth.ts:45-67
(no "if exists" - investigator confirmed location)

Step 2: Use argon2 (already installed 0.31.2) not bcrypt
(no assumption - investigator confirmed actual dependency)
```

**Result:** Plan matches actual codebase state.
</correction>
</example>

<example>
<scenario>Developer asks permission between each task validation instead of continuing automatically</scenario>

<code>
After user approves bd-3 expansion:

Developer: "bd-3 expansion approved and updated in bd.
Should I continue to bd-4 now? What's your preference?"

[Waits for user response]
</code>

<why_it_fails>
**Breaks workflow momentum:**
- Unnecessary interruption
- User has to respond multiple times
- Slows down batch processing
- SetTodoList list IS the plan

**Why it happens:** Over-asking for permission instead of executing the plan.
</why_it_fails>

<correction>
**After user approves bd-3:**

```bash
tm update bd-3 --design "[expansion]"  # Update bd
# Mark completed in SetTodoList
```

**IMMEDIATELY continue to bd-4:**
```bash
tm show bd-4  # Read next task
# Dispatch codebase-investigator with bd-4 assumptions
# Draft expansion
# Present bd-4 expansion to user
```

**NO asking:** "Should I continue?" or "What's your preference?"

**ONLY ask user:**
1. When presenting each task expansion for validation
2. At the VERY END after ALL tasks done to offer execution choice

**Between validations: JUST CONTINUE.**

**Result:** Efficient batch processing of all tasks.
</correction>
</example>

</examples>

<critical_rules>

## Rules That Have No Exceptions

1. **No placeholders or meta-references** → Write actual content
   - ❌ FORBIDDEN: `[Full implementation steps as detailed above]`
   - ✅ REQUIRED: Complete code, exact paths, real commands

2. **Use codebase-investigator agent** → Never verify yourself
   - Agent gets bd assumptions
   - Agent reports discrepancies
   - You adjust plan to match reality

3. **Present COMPLETE expansion before asking** → User must SEE before approving
   - Show full expansion in message text
   - Then use AskUserQuestion for approval
   - Never ask without showing first

4. **Continue automatically between validations** → Don't ask permission
   - SetTodoList list IS your plan
   - Execute it completely
   - Only ask: (a) task validation, (b) final execution choice

5. **Write definitive steps** → Never conditional
   - ❌ "Update `index.js` if exists"
   - ✅ "Create `src/auth.ts`" (investigator confirmed)

## Common Excuses

All of these mean: Stop, write actual content:
- "I'll add the details later"
- "The implementation is obvious from the goal"
- "See above for the steps"
- "User can figure out the code"

</critical_rules>

<verification_checklist>

Before marking each task complete in SetTodoList:
- [ ] Used codebase-investigator agent (not manual verification)
- [ ] Presented COMPLETE expansion to user (showed full text)
- [ ] User approved expansion (via AskUserQuestion)
- [ ] Updated bd with actual content (no placeholders)
- [ ] No meta-references in design field

Before finishing all tasks:
- [ ] All tasks in SetTodoList marked completed
- [ ] All bd issues updated with expansions
- [ ] No conditional steps ("if exists")
- [ ] Complete code examples in all steps
- [ ] Exact file paths and commands throughout

</verification_checklist>

<integration>

**This skill calls:**
- sre-task-refinement (optional, can run before this)
- codebase-investigator (REQUIRED for each task verification)
- executing-plans (offered after all tasks expanded)

**This skill is called by:**
- User (via //skill:write-plan command)
- After brainstorming creates epic

**Agents used:**
- /skill:codebase-investigator (verify assumptions, report discrepancies)

</integration>

<resources>

**Detailed guidance:**
- [bd command reference](../common-patterns/bd-commands.md)
- [Task structure examples](resources/task-examples.md) (if exists)

**When stuck:**
- Unsure about file structure → Use codebase-investigator
- Don't know version → Use codebase-investigator
- Tempted to write "if exists" → Use codebase-investigator first
- About to write placeholder → Stop, write actual content
- Want to ask permission → Check: Is this task validation or final choice? If neither, don't ask

</resources>