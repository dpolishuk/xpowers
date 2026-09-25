---
name: dispatching-parallel-agents
description: Use when facing 3+ independent failures that can be investigated without shared state or dependencies - dispatches multiple agents to investigate and fix independent problems concurrently
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
When facing 3+ independent failures, dispatch one agent per problem domain to investigate concurrently; verify independence first, dispatch all in single message, wait for all agents, check conflicts, verify integration.
</skill_overview>

<rigidity_level>
MEDIUM FREEDOM - Follow the 6-step process (identify, create tasks, dispatch, monitor, review, verify) strictly. Independence verification mandatory. Parallel dispatch in single message required. Adapt agent prompt content to problem domain.
</rigidity_level>

<quick_reference>
| Step | Action | Critical Rule |
|------|--------|---------------|
| 1. Identify Domains | Test independence (fix A doesn't affect B) | 3+ independent domains required |
| 2. Create Agent Tasks | Write focused prompts (scope, goal, constraints, output) | One prompt per domain |
| 3. Dispatch Agents | Launch all agents in SINGLE message | Multiple Agent calls in parallel |
| 4. Monitor Progress | Track completions, don't integrate until ALL done | Wait for all agents |
| 5. Review Results | Read summaries, check conflicts | Manual conflict resolution |
| 6. Verify Integration | Run full test suite | Use verification-before-completion |

**Why 3+?** With only 2 failures, coordination overhead often exceeds sequential time.

**Critical:** Dispatch all agents in a single parallel tool call, or they run sequentially.
</quick_reference>

<when_to_use>
Use when:
- 3+ test files failing with different root causes
- Multiple subsystems broken independently
- Each problem can be understood without context from others
- No shared state between investigations
- You've verified failures are truly independent
- Each domain has clear boundaries (different files, modules, features)

Don't use when:
- Failures are related (fix one might fix others)
- Need to understand full system state first
- Agents would interfere (editing same files)
- Haven't verified independence yet (exploratory phase)
- Failures share root cause (one bug, multiple symptoms)
- Need to preserve investigation order (cascading failures)
- Only 2 failures (overhead exceeds benefit)
</when_to_use>

<the_process>
## Step 1: Identify Independent Domains

**Announce:** "I'm using /skill:dispatching-parallel-agents to investigate these independent failures concurrently."

**Create checklist tracker:**
```
- Identify independent domains (3+ domains identified)
- Create agent tasks (one prompt per domain drafted)
- Dispatch agents in parallel (all agents launched in single message)
- Monitor agent progress (track completions)
- Review results (summaries read, conflicts checked)
- Verify integration (full test suite green)
```

**Test for independence:**

1. **Ask:** "If I fix failure A, does it affect failure B?"
   - If NO → Independent
   - If YES → Related, investigate together

2. **Check:** "Do failures touch same code/files?"
   - If NO → Likely independent
   - If YES → Check if different functions/areas

3. **Verify:** "Do failures share error patterns?"
   - If NO → Independent
   - If YES → Might be same root cause

**Example independence check:**
```
Failure 1: Authentication tests failing (auth.test.ts)
Failure 2: Database query tests failing (db.test.ts)
Failure 3: API endpoint tests failing (api.test.ts)

Check: Does fixing auth affect db queries? NO
Check: Does fixing db affect API? YES - API uses db

Result: 2 independent domains:
  Domain 1: Authentication (auth.test.ts)
  Domain 2: Database + API (db.test.ts + api.test.ts together)
```

**Group failures by what's broken:**
- File A tests: Tool approval flow
- File B tests: Batch completion behavior
- File C tests: Abort functionality

---

## Step 2: Create Focused Agent Tasks

Each agent prompt must have:

1. **Specific scope:** One test file or subsystem
2. **Clear goal:** Make these tests pass
3. **Constraints:** Don't change other code
4. **Expected output:** Summary of what you found and fixed

**Good agent prompt example:**
```markdown
Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts:

1. "should abort tool with partial output capture" - expects 'interrupted at' in message
2. "should handle mixed completed and aborted tools" - fast tool aborted instead of completed
3. "should properly track pendingToolCount" - expects 3 results but gets 0

These are timing/race condition issues. Your task:

1. Read the test file and understand what each test verifies
2. Identify root cause - timing issues or actual bugs?
3. Fix by:
   - Replacing arbitrary timeouts with event-based waiting
   - Fixing bugs in abort implementation if found
   - Adjusting test expectations if testing changed behavior

Never just increase timeouts - find the real issue.

Return: Summary of what you found and what you fixed.
```

**What makes this good:**
- Specific test failures listed
- Context provided (timing/race conditions)
- Clear methodology (read, identify, fix)
- Constraints (don't just increase timeouts)
- Output format (summary)

**Common mistakes:**

❌ **Too broad:** "Fix all the tests" - agent gets lost
✅ **Specific:** "Fix agent-tool-abort.test.ts" - focused scope

❌ **No context:** "Fix the race condition" - agent doesn't know where
✅ **Context:** Paste the error messages and test names

❌ **No constraints:** Agent might refactor everything
✅ **Constraints:** "Do NOT change production code" or "Fix tests only"

❌ **Vague output:** "Fix it" - you don't know what changed
✅ **Specific:** "Return summary of root cause and changes"

---

## Step 3: Dispatch All Agents in Parallel

**CRITICAL:** Dispatch all agents in a SINGLE parallel tool call. Use `Agent` inside `parallel Agent calls with run_in_background=true` so they run concurrently.

```json
{
  "tool": "parallel Agent calls with run_in_background=true",
  "tool_uses": [
    {
      "recipient_name": "kimi_cli.tools.agent:Agent",
      "parameters": {
        "subagent_type": "coder",
        "message": "Fix agent-tool-abort.test.ts failures. Return summary of root cause and changes."
      }
    },
    {
      "recipient_name": "kimi_cli.tools.agent:Agent",
      "parameters": {
        "subagent_type": "coder",
        "message": "Fix batch-completion-behavior.test.ts failures. Return summary of root cause and changes."
      }
    },
    {
      "recipient_name": "kimi_cli.tools.agent:Agent",
      "parameters": {
        "subagent_type": "coder",
        "message": "Fix tool-approval-race-conditions.test.ts failures. Return summary of root cause and changes."
      }
    }
  ]
}
```

**Avoid:** sequentially calling `Agent` in separate messages. That runs agents one at a time.

**After dispatch:**
- Mark "Dispatch agents in parallel" as completed in the checklist
- Mark "Monitor agent progress" as in_progress
- Wait for all agents to complete before integration

---

## Step 4: Monitor Progress

As agents work:
- Note which agents have completed
- Note which are still running
- Don't start integration until ALL agents done

**If an agent gets stuck (>5 minutes):**

1. Check AgentOutput to see what it's doing
2. If stuck on wrong path: Cancel and retry with clearer prompt
3. If needs context from other domain: Wait for other agent, then restart with context
4. If hit real blocker: Investigate blocker yourself, then retry

---

## Step 5: Review Results and Check Conflicts

**When all agents return:**

1. **Read each summary carefully**
   - What was the root cause?
   - What did the agent change?
   - Were there any uncertainties?

2. **Check for conflicts**
   - Did multiple agents edit same files?
   - Did agents make contradictory assumptions?
   - Are there integration points between domains?

3. **Integration strategy:**
   - If no conflicts: Apply all changes
   - If conflicts: Resolve manually before applying
   - If assumptions conflict: Verify with user

4. **Document what happened**
   - Which agents fixed what
   - Any conflicts found
   - Integration decisions made

---

## Step 6: Verify Integration

**Run full test suite:**
- Not just the fixed tests
- Verify no regressions in other areas
- Use /skill:verification-before-completion skill

**Before completing:**
```bash
# Run all tests
npm test  # or cargo test, pytest, etc.

# Verify output
# If all pass → Mark "Verify integration" complete
# If failures → Identify which agent's change caused regression
```
</the_process>

<examples>
<example>
<scenario>Developer dispatches agents sequentially instead of in parallel</scenario>

<code>
# Developer sees 3 independent failures
# Creates 3 agent prompts

# Dispatches first agent
Agent(prompt1)
# Waits for response from agent 1

# Then dispatches second agent
Agent(prompt2)
# Waits for response from agent 2

# Then dispatches third agent
Agent(prompt3)

# Total time: Sum of all three agents (sequential)
</code>

<why_it_fails>
- Agents run sequentially, not in parallel
- No time savings from parallelization
- Each agent waits for previous to complete
- Defeats entire purpose of parallel dispatch
- Same result as sequential investigation
- Wasted overhead of creating separate agents
</why_it_fails>

<correction>
**Dispatch all agents in SINGLE message:**

```json
{
  "tool": "parallel Agent calls with run_in_background=true",
  "tool_uses": [
    {
      "recipient_name": "kimi_cli.tools.agent:Agent",
      "parameters": {
        "subagent_type": "coder",
        "message": "Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts: [prompt 1 content]"
      }
    },
    {
      "recipient_name": "kimi_cli.tools.agent:Agent",
      "parameters": {
        "subagent_type": "coder",
        "message": "Fix the 2 failing tests in src/agents/batch-completion-behavior.test.ts: [prompt 2 content]"
      }
    },
    {
      "recipient_name": "kimi_cli.tools.agent:Agent",
      "parameters": {
        "subagent_type": "coder",
        "message": "Fix the 1 failing test in src/agents/tool-approval-race-conditions.test.ts: [prompt 3 content]"
      }
    }
  ]
}
```

**What happens:**
- All three agents start simultaneously
- Each investigates independently
- All complete in parallel
- Total time: Max(agent1, agent2, agent3) instead of Sum

**What you gain:**
- True parallelization - 3 problems solved concurrently
- Time saved: 3 investigations in time of 1
- Each agent focused on narrow scope
- No waiting for sequential completion
- Proper use of parallel dispatch pattern
</correction>
</example>

<example>
<scenario>Developer assumes failures are independent without verification</scenario>

<code>
# Developer sees 3 test failures:
# - API endpoint tests failing
# - Database query tests failing
# - Cache invalidation tests failing

# Thinks: "Different subsystems, must be independent"

# Dispatches 3 agents immediately without checking independence

# Agent 1 finds: API failing because database schema changed
# Agent 2 finds: Database queries need migration
# Agent 3 finds: Cache keys based on old schema

# All three failures caused by same root cause: schema change
# Agents make conflicting fixes based on different assumptions
# Integration fails because fixes contradict each other
</code>

<why_it_fails>
- Skipped independence verification (Step 1)
- Assumed independence based on surface appearance
- All failures actually shared root cause (schema change)
- Agents worked in isolation without seeing connection
- Each agent made different assumptions about correct schema
- Conflicting fixes can't be integrated
- Wasted time on parallel work that should have been unified
- Have to throw away agent work and start over
</why_it_fails>

<correction>
**Run independence check FIRST:**

```
Check: Does fixing API affect database queries?
- API uses database
- If database schema changes, API breaks
- YES - these are related

Check: Does fixing database affect cache?
- Cache stores database results
- If database schema changes, cache keys break
- YES - these are related

Check: Do failures share error patterns?
- All mention "column not found: user_email"
- All started after schema migration
- YES - shared root cause

Result: NOT INDEPENDENT
These are one problem (schema change) manifesting in 3 places
```

**Correct approach:**

```
Single agent investigates: "Schema migration broke 3 subsystems"

Agent prompt:
"We have 3 test failures all related to schema change:
1. API endpoints: column not found
2. Database queries: column not found
3. Cache invalidation: old keys

Investigate the schema migration that caused this.
Fix by updating all 3 subsystems consistently.
Return: What changed in schema, how you fixed each subsystem."

# One agent sees full picture
# Makes consistent fix across all 3 areas
# No conflicts, proper integration
```

**What you gain:**
- Caught shared root cause before wasting time
- One agent sees full context
- Consistent fix across all affected areas
- No conflicting assumptions
- No integration conflicts
- Faster than 3 agents working at cross-purposes
- Proper problem diagnosis before parallel dispatch
</correction>
</example>

<example>
<scenario>Developer integrates agent results without checking conflicts</scenario>

<code>
# 3 agents complete successfully
# Developer quickly reads summaries:

Agent 1: "Fixed timeout issue by increasing wait time to 5000ms"
Agent 2: "Fixed race condition by adding mutex lock"
Agent 3: "Fixed timing issue by reducing wait time to 1000ms"

# Developer thinks: "All agents succeeded, ship it"

# Applies all changes without checking conflicts

# Result:
# - Agent 1 and Agent 3 edited same file
# - Agent 1 increased timeout, Agent 3 decreased it
# - Final code has inconsistent timeouts
# - Agent 2's mutex interacts badly with Agent 3's reduced timeout
# - Tests still fail after integration
</code>

<why_it_fails>
- Skipped conflict checking (Step 5)
- Didn't carefully read what each agent changed
- Agents made contradictory decisions
- Agent 1 and Agent 3 had different assumptions about timing
- Agent 2's locking interacts with timing changes
- Blindly applying all fixes creates inconsistent state
- Tests fail after "successful" integration
- Have to manually untangle conflicting changes
</why_it_fails>

<correction>
**Review results carefully before integration:**

```markdown
## Agent Summaries Review

Agent 1: Fixed timeout issue by increasing wait time to 5000ms
- File: src/agents/tool-executor.ts
- Change: DEFAULT_TIMEOUT = 5000

Agent 2: Fixed race condition by adding mutex lock
- File: src/agents/tool-executor.ts
- Change: Added mutex around tool execution

Agent 3: Fixed timing issue by reducing wait time to 1000ms
- File: src/agents/tool-executor.ts
- Change: DEFAULT_TIMEOUT = 1000

## Conflict Analysis

**CONFLICT DETECTED:**
- Agents 1 and 3 edited same file (tool-executor.ts)
- Agents 1 and 3 changed same constant (DEFAULT_TIMEOUT)
- Agent 1: increase to 5000ms
- Agent 3: decrease to 1000ms
- Contradictory assumptions about correct timing

**Why conflict occurred:**
- Domains weren't actually independent (same timeout constant)
- Both agents tested locally, didn't see interaction
- Different problem spaces led to different timing needs

## Resolution

**Option 1:** Different timeouts for different operations
```typescript
const TOOL_EXECUTION_TIMEOUT = 5000  // Agent 1's need
const TOOL_APPROVAL_TIMEOUT = 1000   // Agent 3's need
```

**Option 2:** Investigate why timing varies
- Maybe Agent 1's tests are actually slow (fix slowness)
- Maybe Agent 3's tests are correct (use 1000ms everywhere)

**Choose Option 2 after investigation:**
- Agent 1's tests were slow due to unrelated issue
- Fix the slowness, use 1000ms timeout everywhere
- Agent 2's mutex is compatible with 1000ms

**Integration steps:**
1. Apply Agent 2's mutex (no conflict)
2. Apply Agent 3's 1000ms timeout
3. Fix Agent 1's slow tests (root cause)
4. Don't apply Agent 1's timeout increase (symptom fix)
```

**Run full test suite:**
```bash
npm test
# All tests pass ✅
```

**What you gain:**
- Caught contradiction before breaking integration
- Understood why agents made different decisions
- Resolved conflict thoughtfully, not arbitrarily
- Fixed root cause (slow tests) not symptom (long timeout)
- Verified integration works correctly
- Avoided shipping inconsistent code
- Professional conflict resolution process
</correction>
</example>
</examples>

<failure_modes>
## Agent Gets Stuck

**Symptoms:** No progress after 5+ minutes

**Causes:**
- Prompt too vague, agent exploring aimlessly
- Domain not actually independent, needs context from other agents
- Agent hit a blocker (missing file, unclear error)

**Recovery:**
1. Use AgentOutput tool to check what it's doing
2. If stuck on wrong path: Cancel and retry with clearer prompt
3. If needs context from other domain: Wait for other agent, then restart with context
4. If hit real blocker: Investigate blocker yourself, then retry

---

## Agents Return Conflicting Fixes

**Symptoms:** Agents edited same code differently, or made contradictory assumptions

**Causes:**
- Domains weren't actually independent
- Shared code between domains
- Agents made different assumptions about correct behavior

**Recovery:**
1. Don't apply either fix automatically
2. Read both fixes carefully
3. Identify the conflict point
4. Resolve manually based on which assumption is correct
5. Consider if domains should be merged

---

## Integration Breaks Other Tests

**Symptoms:** Fixed tests pass, but other tests now fail

**Causes:**
- Agent changed shared code
- Agent's fix was too broad
- Agent misunderstood requirements

**Recovery:**
1. Identify which agent's change caused the regression
2. Read the agent's summary - did they mention this change?
3. Evaluate if change is correct but tests need updating
4. Or if change broke something, need to refine the fix
5. Use /skill:verification-before-completion skill for final check

---

## False Independence

**Symptoms:** Fixing one domain revealed it affected another

**Recovery:**
1. Merge the domains
2. Have one agent investigate both together
3. Learn: Better independence test needed upfront
</failure_modes>

<critical_rules>
## Rules That Have No Exceptions

1. **Verify independence first** → Test with questions before dispatching
2. **3+ domains required** → 2 failures: overhead exceeds benefit, do sequentially
3. **Single message dispatch** → All agents in one parallel tool call with multiple `Agent` uses
4. **Wait for ALL agents** → Don't integrate until all complete
5. **Check conflicts manually** → Read summaries, verify no contradictions
6. **Verify integration** → Run full suite yourself, don't trust agents
7. **Checklist tracking** → Track agent progress explicitly

## Common Excuses

All of these mean: **STOP. Follow the process.**

- "Just 2 failures, can still parallelize" (Overhead exceeds benefit, do sequentially)
- "Probably independent, will dispatch and see" (Verify independence FIRST)
- "Can dispatch sequentially to save syntax" (WRONG - must dispatch in single message)
- "Agent failed, but others succeeded - ship it" (All agents must succeed or re-investigate)
- "Conflicts are minor, can ignore" (Resolve all conflicts explicitly)
- "Don't need a checklist for just tracking agents" (Use a checklist, track properly)
- "Can skip verification, agents ran tests" (Agents can make mistakes, YOU verify)
</critical_rules>

<verification_checklist>
Before completing parallel agent work:

- [ ] Verified independence with 3 questions (fix A affects B? same code? same error pattern?)
- [ ] 3+ independent domains identified (not 2 or fewer)
- [ ] Created focused agent prompts (scope, goal, constraints, output)
- [ ] Dispatched all agents in a single parallel tool call (multiple `Agent` uses)
- [ ] Waited for ALL agents to complete (didn't integrate early)
- [ ] Read all agent summaries carefully
- [ ] Checked for conflicts (same files, contradictory assumptions)
- [ ] Resolved any conflicts manually before integration
- [ ] Ran full test suite (not just fixed tests)
- [ ] Used verification-before-completion skill
- [ ] Documented which agents fixed what

**Can't check all boxes?** Return to the process and complete missing steps.
</verification_checklist>

<integration>
**This skill covers:** Parallel investigation of independent failures

**Related skills:**
- /skill:debugging-with-tools (how to investigate individual failures)
- /skill:fixing-bugs (complete bug workflow)
- /skill:verification-before-completion (verify integration)
- /skill:test-runner (run tests without context pollution)

**This skill uses:**
- Task tool (dispatch parallel agents)
- AgentOutput tool (monitor stuck agents)
- Checklist (track agent progress)

**Workflow integration:**
```
Multiple independent failures
    ↓
Verify independence (Step 1)
    ↓
Create agent tasks (Step 2)
    ↓
Dispatch in parallel (Step 3)
    ↓
Monitor progress (Step 4)
    ↓
Review + check conflicts (Step 5)
    ↓
Verify integration (Step 6)
    ↓
/skill:verification-before-completion
```

**Real example from session (2025-10-03):**
- 6 failures across 3 files
- 3 agents dispatched in parallel
- All investigations completed concurrently
- All fixes integrated successfully
- Zero conflicts between agent changes
- Time saved: 3 problems solved in parallel vs sequentially
</integration>

<resources>
**Key principles:**
- Parallelization only wins with 3+ independent problems
- Independence verification prevents wasted parallel work
- Single message dispatch is critical for true parallelism
- Conflict checking prevents integration disasters
- Full verification catches agent mistakes

**When stuck:**
- Agent not making progress → Check AgentOutput, retry with clearer prompt
- Conflicts after dispatch → Domains weren't independent, merge and retry
- Integration fails tests → Identify which agent caused regression
- Unclear if independent → Test with 3 questions (affects? same code? same error?)
</resources>
