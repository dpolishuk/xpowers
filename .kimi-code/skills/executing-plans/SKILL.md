---
name: executing-plans
description: Use to execute bd tasks iteratively - executes one task, reviews learnings, creates/refines next task, then STOPS for user review before continuing
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
Execute bd tasks one at a time with mandatory checkpoints: Load epic → Execute task → Review learnings → Create next task → Run SRE refinement → STOP. User clears context, reviews implementation, then runs command again to continue. Epic requirements are immutable, tasks adapt to reality.
</skill_overview>

<rigidity_level>
LOW FREEDOM - Follow exact process: load epic, execute ONE task, review, create next task with SRE refinement, STOP.

Epic requirements are immutable. Tasks adapt to discoveries. Do not skip checkpoints, SRE refinement, or verification. STOP after each task for user review.
</rigidity_level>

<quick_reference>

| Step | Command | Purpose |
|------|---------|---------|
| **Load Epic** | `tm show bd-1` | Read immutable requirements once at start |
| **Find Task** | `tm ready` | Get next ready task to execute |
| **Start Task** | `tm update bd-2 --status in_progress` | Mark task active |
| **Track Substeps** | SetTodoList for each implementation step | Prevent incomplete execution |
| **Close Task** | `tm close bd-2` | Mark task complete after verification |
| **Review** | Re-read epic, check learnings | Adapt next task to reality |
| **Create Next** | `tm create "Task N"` | Based on learnings, not assumptions |
| **Refine** | Use `sre-task-refinement` skill | Corner-case analysis with Opus 4.1 |
| **STOP** | Present summary to user | User reviews, clears context, runs command again |
| **Final Check** | Use `review-implementation` skill | Verify all success criteria before closing epic |

**Critical:** Epic = contract (immutable). Tasks = discovery (adapt to reality). STOP after each task for user review.

</quick_reference>

<when_to_use>
**Use after /skill:writing-plans creates epic and first task.**

Symptoms you need this:
- bd epic exists with tasks ready to execute
- Need to implement features iteratively
- Requirements clear, but implementation path will adapt
- Want continuous learning between tasks
</when_to_use>

<the_process>

## 0. Resumption Check (Every Invocation)

This skill supports explicit resumption. When invoked:

```bash
tm list --type epic --status open  # Find active epic
tm ready                           # Check for ready tasks
tm list --status in_progress       # Check for in-progress tasks
```

**Fresh start:** No in-progress tasks, proceed to Step 1.

**Resuming:** Found ready or in-progress tasks:
- In-progress task exists → Resume at Step 2 (continue executing)
- Ready task exists → Resume at Step 2 (start executing)
- All tasks closed but epic open → Resume at Step 4 (check criteria)

**Why resumption matters:**
- User cleared context between tasks (intended workflow)
- Context limit reached mid-task
- Previous session ended unexpectedly

**Do not ask "where did we leave off?"** - bd state tells you exactly where to resume.

## 1. Load Epic Context (Once at Start)

Before executing ANY task, load the epic into context:

```bash
tm list --type epic --status open  # Find epic
tm show bd-1                       # Load epic details
```

**Extract and keep in mind:**
- Requirements (IMMUTABLE)
- Success criteria (validation checklist)
- Anti-patterns (FORBIDDEN shortcuts)
- Approach (high-level strategy)

**Why:** Requirements prevent watering down when blocked.

## 2. Execute Current Ready Task

```bash
tm ready                           # Find next task
tm update bd-2 --status in_progress # Start it
tm show bd-2                       # Read details
```

**CRITICAL - Create SetTodoList for ALL substeps:**

Tasks contain 4-8 implementation steps. Create SetTodoList todos for each to prevent incomplete execution:

```
- bd-2 Step 1: Write test (pending)
- bd-2 Step 2: Run test RED (pending)
- bd-2 Step 3: Implement function (pending)
- bd-2 Step 4: Run test GREEN (pending)
- bd-2 Step 5: Refactor (pending)
- bd-2 Step 6: Commit (pending)
```

**Execute steps:**
- Use `test-driven-development` when implementing features
- Mark each substep completed immediately after finishing
- Use `test-runner` agent for verifications

**Pre-close verification:**
- Check SetTodoList: All substeps completed?
- If incomplete: Continue with remaining substeps
- If complete: Close task and commit

```bash
tm close bd-2  # After ALL substeps done
```

## 2a. When Hitting Obstacles

**CRITICAL: Check Design Discovery before switching approaches**

When you hit a blocker or obstacle during implementation, do NOT automatically try alternative approaches. First check the epic's "Approaches Considered" section.

**BEFORE switching approaches:**
1. Re-read epic: `tm show bd-1`
2. Find "Approaches Considered" section
3. Check if the alternative you're considering was already rejected
4. Read the "⚠️ REJECTED BECAUSE" reasoning
5. Check "🚫 DO NOT REVISIT UNLESS" conditions

**If rejected approach seems needed:**

Before switching to a previously rejected approach, you MUST:
- Document why the rejection reason no longer applies
- Or explain why this obstacle changes the calculus
- Get user confirmation before switching

```markdown
## Obstacle Encountered

**Current approach:** [Chosen Approach from epic]
**Obstacle:** [What blocker was hit]

**Considering:** [Rejected Approach from epic]

**Original rejection reason:** [Copy from epic]
**DO NOT REVISIT UNLESS:** [Copy from epic]

**Why reconsidering:**
- [ ] Rejection reason no longer applies because: [specific reason]
- [ ] DO NOT REVISIT condition is now met: [specific evidence]

**Recommendation:** [Stay course / Switch with user approval]
```

**Anti-pattern:** Automatically trying rejected alternatives when hitting obstacles

**Why this matters:**
- Rejected approaches were rejected for good reasons
- Those reasons often still apply when obstacles arise
- Example: Chose passport.js, hit session complexity, considered switching to custom JWT
  - But custom JWT was rejected because it requires rewriting 15 files
  - The obstacle doesn't change that - switching makes the problem worse

**Reference Design Discovery:**
- Check "Dead-End Paths" for approaches already abandoned during research
- Check "Key Decisions Made" for user requirements that constrain options
- Check "Open Concerns Raised" for context on prior discussions

## 3. Review Against Epic and Create Next Task

**CRITICAL:** After each task, adapt plan based on reality.

**Review questions:**
1. What did we learn?
2. Discovered any blockers, existing functionality, limitations?
3. Does this move us toward epic success criteria?
4. What's next logical step?
5. Any epic anti-patterns to avoid?

**Re-read epic:**
```bash
tm show bd-1  # Keep requirements fresh
```

**Three cases:**

**A) Next task still valid** → Proceed to Step 2

**B) Next task now redundant** (plan invalidation allowed):
```bash
bd delete bd-4  # Remove wasteful task
# Or update: tm update bd-4 --title "New work" --design "..."
```

**C) Need new task** based on learnings:
```bash
tm create "Task N: [Next Step Based on Reality]" \
  --type feature \
  --design "## Goal
[Deliverable based on what we learned]

## Context
Completed bd-2: [discoveries]

## Implementation
[Steps reflecting current state, not assumptions]

## Success Criteria
- [ ] Specific outcomes
- [ ] Tests passing"

tm dep add bd-N bd-1 --type parent-child
tm dep add bd-N bd-2 --type blocks
```

**REQUIRED - Run SRE refinement on new task:**
```
Load skill: /skill:sre-task-refinement
```

SRE refinement will:
- Apply 7-category corner-case analysis (Opus 4.1)
- Identify edge cases and failure modes
- Strengthen success criteria
- Ensure task is ready for implementation

**Do NOT skip SRE refinement.** New tasks need the same rigor as initial planning.

## 4. Check Epic Success Criteria and STOP

```bash
tm show bd-1  # Check success criteria
```

- ALL criteria met? → Step 5 (final validation)
- Some missing? → **STOP for user review**

## 4a. STOP Checkpoint (Mandatory)

**Present summary to user:**

```markdown
## Task bd-N Complete - Checkpoint

### What Was Done
- [Summary of implementation]
- [Key learnings/discoveries]

### Next Task Ready
- bd-M: [Title]
- [Brief description of what's next]

### Epic Progress
- [X/Y success criteria met]
- [Remaining criteria]

### To Continue
Run `//skill:execute-plan` to execute the next task.
```

**Why STOP is mandatory:**
- User can clear context (prevents context exhaustion)
- User can review implementation before next task
- User can adjust next task if needed
- Prevents runaway execution without oversight

**Do NOT rationalize skipping the stop:**
- "Good context loaded" → Context reloads are cheap, wrong decisions aren't
- "Momentum" → Checkpoints ensure quality over speed
- "User didn't ask to stop" → Stopping is the default, continuing requires explicit command

## 5. Final Validation and Closure

When all success criteria appear met:

1. **Run full verification** (tests, hooks, manual checks)

2. **REQUIRED - Use review-implementation skill:**
```
Load skill: /skill:review-implementation
```

Review-implementation will:
- Check each requirement met
- Verify each success criterion satisfied
- Confirm no anti-patterns used
- If approved: Calls `finishing-a-development-branch`
- If gaps: Create tasks, return to Step 2

3. **Only close epic after review approves**

</the_process>

<examples>

<example>
<scenario>Developer closes task without completing all substeps, claims "mostly done"</scenario>

<code>
bd-2 has 6 implementation steps.

SetTodoList shows:
- ✅ bd-2 Step 1: Write test
- ✅ bd-2 Step 2: Run test RED
- ✅ bd-2 Step 3: Implement function
- ⏸️ bd-2 Step 4: Run test GREEN (pending)
- ⏸️ bd-2 Step 5: Refactor (pending)
- ⏸️ bd-2 Step 6: Commit (pending)

Developer thinks: "Function works, I'll close bd-2 and move on"
Runs: tm close bd-2
</code>

<why_it_fails>
Steps 4-6 skipped:
- Tests not verified GREEN (might have broken other tests)
- Code not refactored (leaves technical debt)
- Changes not committed (work could be lost)

"Mostly done" = incomplete task = will cause issues later.
</why_it_fails>

<correction>
**Pre-close verification checkpoint:**

Before closing ANY task:
1. Check SetTodoList: All substeps completed?
2. If incomplete: Continue with remaining substeps
3. Only when ALL ✅: tm close bd-2

**Result:** Task actually complete, tests passing, code committed.
</correction>
</example>

<example>
<scenario>Developer discovers planned task is redundant, executes it anyway "because it's in the plan"</scenario>

<code>
bd-4 says: "Implement token refresh middleware"

While executing bd-2, developer discovers:
- Token refresh middleware already exists in auth/middleware/refresh.ts
- Works correctly, has tests
- bd-4 would duplicate existing code

Developer thinks: "bd-4 is in the plan, I should do it anyway"
Proceeds to implement duplicate middleware
</code>

<why_it_fails>
**Wasteful execution:**
- Duplicates existing functionality
- Creates maintenance burden (two implementations to keep in sync)
- Violates DRY principle
- Wastes time on redundant work

**Why it happens:** Treating tasks as immutable instead of epic.
</why_it_fails>

<correction>
**Plan invalidation is allowed:**

1. Verify the discovery:
```bash
# Check existing code
cat auth/middleware/refresh.ts
# Confirm it works
npm test -- refresh.spec.ts
```

2. Delete redundant task:
```bash
bd delete bd-4
```

3. Document why:
```
tm update bd-2 --design "...

Discovery: Token refresh middleware already exists (auth/middleware/refresh.ts).
Verified working with tests. bd-4 deleted as redundant."
```

4. Create new task if needed (maybe "Integrate existing refresh middleware" instead)

**Result:** Plan adapts to reality. No wasted work.
</correction>
</example>

<example>
<scenario>Developer hits blocker, waters down epic requirement to "make it easier"</scenario>

<code>
Epic bd-1 anti-patterns say:
"FORBIDDEN: Using mocks for database integration tests. Must use real test database."

Developer encounters:
- Real database setup is complex
- Mocking would make tests pass quickly

Developer thinks: "This is too hard, I'll use mocks just for now and refactor later"

Adds TODO: // TODO: Replace mocks with real DB later
</code>

<why_it_fails>
**Violates epic anti-pattern:**
- Epic explicitly forbids mocks for integration tests
- "Later" never happens (TODO remains forever)
- Tests don't verify actual integration
- Defeats purpose of integration testing

**Why it happens:** Rationalizing around blockers instead of solving them.
</why_it_fails>

<correction>
**When blocked, re-read epic:**

1. Re-read epic requirements and anti-patterns:
```bash
tm show bd-1
```

2. Check if solution violates anti-pattern:
- Using mocks? YES, explicitly forbidden

3. Don't rationalize. Instead:

**Option A - Research:**
```bash
tm create "Research: Real DB test setup for [project]" \
  --design "Find how this project sets up test databases.
Check existing test files for patterns.
Document setup process that meets anti-pattern requirements."
```

**Option B - Ask user:**
"Blocker: Test DB setup complex. Epic forbids mocks for integration.
Is there existing test DB infrastructure I should use?"

**Result:** Epic requirements maintained. Blocker solved properly.
</correction>
</example>

<example>
<scenario>Developer skips STOP checkpoint to "maintain momentum"</scenario>

<code>
Just completed bd-2 (authentication middleware).
Created bd-3 (rate limiting endpoint).
Ran SRE refinement on bd-3.

Developer thinks: "Good context loaded, I'll just do bd-3 quickly then stop.
User approved the epic, they trust me to execute it.
Stopping now is inefficient."

Continues directly to execute bd-3 without STOP checkpoint.
</code>

<why_it_fails>
**Multiple failures:**
- User can't review bd-2 implementation before bd-3 starts
- User can't clear context (may hit context limit mid-task)
- User can't adjust bd-3 based on bd-2 learnings
- No checkpoint = no oversight

**The rationalization trap:**
- "Good context" sounds efficient but prevents review
- "User trust" misinterprets approval (one command ≠ blanket permission)
- "Quick task" becomes long task when issues arise

**What actually happens:**
- bd-3 hits unexpected issue
- Context exhausted trying to debug
- User returns to find 2 half-finished tasks instead of 1 complete task
</why_it_fails>

<correction>
**Follow the STOP checkpoint:**

1. After completing bd-2 and refining bd-3:
```markdown
## Task bd-2 Complete - Checkpoint

### What Was Done
- Implemented JWT middleware with validation
- Added token refresh handling

### Next Task Ready
- bd-3: Implement rate limiting
- Adds rate limiting to auth endpoints

### Epic Progress
- 2/4 success criteria met
- Remaining: password reset, rate limiting

### To Continue
Run `//skill:execute-plan` to execute the next task.
```

2. **STOP and wait for user**

**Result:** User can review, clear context, adjust next task. Each task completes with full oversight.
</correction>
</example>

</examples>

<critical_rules>

## Rules That Have No Exceptions

1. **STOP after each task** → Present summary, wait for user to run command again
   - User needs checkpoint to review implementation
   - User may need to clear context
   - Continuous execution = no oversight

2. **SRE refinement for new tasks** → Never skip corner-case analysis
   - New tasks created during execution need same rigor as initial planning
   - Use Opus 4.1 for thorough analysis
   - Tasks without refinement will miss edge cases

3. **Epic requirements are immutable** → Never water down when blocked
   - If blocked: Research solution or ask user
   - Never violate anti-patterns to "make it easier"

4. **Check Design Discovery before switching approaches** → Never auto-try rejected alternatives
   - Read "Approaches Considered" section when hitting obstacles
   - Check "⚠️ REJECTED BECAUSE" and "🚫 DO NOT REVISIT UNLESS"
   - Rejected approaches were rejected for good reasons that usually still apply
   - Get user confirmation before switching to previously rejected approach

5. **All substeps must be completed** → Never close task with pending substeps
   - Check SetTodoList before closing
   - "Mostly done" = incomplete = will cause issues

6. **Plan invalidation is allowed** → Delete redundant tasks
   - If discovered existing functionality: Delete duplicate task
   - If discovered blocker: Update or delete invalid task
   - Document what you found and why

7. **Review before closing epic** → Use review-implementation skill
   - Tasks done ≠ success criteria met
   - All criteria must be verified before closing

## Common Excuses

All of these mean: Re-read epic, STOP as required, ask for help:
- "Good context loaded, don't want to lose it" → STOP anyway, context reloads
- "Just one more quick task" → STOP anyway, user needs checkpoint
- "User didn't ask me to stop" → Stopping is default, continuing requires explicit command
- "SRE refinement is overkill for this task" → Every task needs refinement, no exceptions
- "This requirement is too hard" → Research or ask, don't water down
- "I'll come back to this later" → Complete now or document why blocked
- "Let me fake this to make tests pass" → Never, defeats purpose
- "Existing task is wasteful, but it's planned" → Delete it, plan adapts to reality
- "All tasks done, epic must be complete" → Verify with review-implementation
- "Hit obstacle, let me try the other approach" → Check Design Discovery first, rejection reasons often still apply
- "The rejected approach would be easier now" → Check "DO NOT REVISIT UNLESS" conditions, get user approval

</critical_rules>

<verification_checklist>

Before closing each task:
- [ ] ALL SetTodoList substeps completed (no pending)
- [ ] Tests passing (use test-runner agent)
- [ ] Changes committed
- [ ] Task actually done (not "mostly")

After closing each task:
- [ ] Reviewed learnings against epic
- [ ] Created/updated next task based on reality
- [ ] Ran SRE refinement on any new tasks
- [ ] Presented STOP checkpoint summary to user
- [ ] STOPPED execution (do not continue to next task)

Before closing epic:
- [ ] ALL success criteria met (check epic)
- [ ] review-implementation skill used and approved
- [ ] No anti-patterns violated
- [ ] All tasks closed

</verification_checklist>

<integration>

**This skill calls:**
- writing-plans (creates epic and first task before this runs)
- sre-task-refinement (REQUIRED for new tasks created during execution)
- test-driven-development (when implementing features)
- test-runner (for running tests without output pollution)
- review-implementation (final validation before closing epic)
- finishing-a-development-branch (after review approves)

**This skill is called by:**
- User (via //skill:execute-plan command)
- After writing-plans creates epic
- Explicitly to resume after checkpoint (user runs command again)

**Agents used:**
- /skill:test-runner (run tests, return summary only)

**Workflow pattern:**
```
//skill:execute-plan → Execute task → STOP
[User clears context, reviews]
//skill:execute-plan → Execute next task → STOP
[Repeat until epic complete]
```

</integration>

<resources>

**bd command reference:**
- See [bd commands](../common-patterns/bd-commands.md) for complete command list

**When stuck:**
- Hit blocker → Re-read epic, check anti-patterns, research or ask
- Don't understand instruction → Stop and ask (never guess)
- Verification fails repeatedly → Check epic anti-patterns, ask for help
- Tempted to skip steps → Check SetTodoList, complete all substeps

</resources>