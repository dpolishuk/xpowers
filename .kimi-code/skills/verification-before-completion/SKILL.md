---
name: verification-before-completion
description: Use before claiming work complete, fixed, or passing - requires running verification commands and confirming output; evidence before assertions always
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
Claiming work is complete without verification is dishonesty, not efficiency. Evidence before claims, always.
</skill_overview>

<rigidity_level>
LOW FREEDOM - NO exceptions. Run verification command, read output, THEN make claim.

No shortcuts. No "should work". No partial verification. Run it, prove it.
</rigidity_level>

<quick_reference>

| Claim | Verification Required | Not Sufficient |
|-------|----------------------|----------------|
| **Tests pass** | Run full test command, see 0 failures | Previous run, "should pass" |
| **Build succeeds** | Run build, see exit 0 | Linter passing |
| **Bug fixed** | Test original symptom, passes | Code changed |
| **Task complete** | Check all success criteria, run verifications | "Implemented bd-3" |
| **Epic complete** | `tm list --status open --parent bd-1` shows 0 | "All tasks done" |

**Iron Law:** NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE

**Use test-runner agent for:** Tests, pre-commit hooks, commits (keeps verbose output out of context)

</quick_reference>

<when_to_use>
**ALWAYS before:**
- Any success/completion claim
- Any expression of satisfaction
- Committing, PR creation, task completion
- Moving to next task
- ANY communication suggesting completion/correctness

**Red flags you need this:**
- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!")
- About to commit/push without verification
- Trusting agent success reports
- Relying on partial verification
</when_to_use>

<the_process>

## The Gate Function

Before claiming ANY status:

### 1. Identify
What command proves this claim?

### 2. Run
Execute the full command (fresh, complete).

**For tests/hooks/commits:** Use `/skill:test-runner` agent
- Agent captures verbose output in its context
- Returns only summary + failures
- Prevents context pollution

**For other commands:** Run directly and capture output

### 3. Read
Full output, check exit code, count failures.

### 4. Verify
Does output confirm the claim?
- If NO: State actual status with evidence
- If YES: State claim with evidence

### 5. Only Then
Make the claim.

**Skip any step = lying, not verifying**

</the_process>

<examples>

<example>
<scenario>Developer claims tests pass without running them</scenario>

<code>
Developer modifies authentication logic.

Developer thinks: "This fix is straightforward, tests should pass now"

Developer writes: "Great! All tests passing. The bug is fixed."

[No test command run, no output shown]
</code>

<why_it_fails>
**No evidence:**
- "Should pass" ≠ evidence
- Confidence ≠ verification
- Might have broken other tests
- Might not have fixed the bug

**Why dangerous:**
- Broken code ships
- Trust broken with partner
- Wastes time on false completion
</why_it_fails>

<correction>
**Run verification:**

```bash
# Dispatch test-runner agent
"Run: cargo test"
```

**Agent returns:**
```
Summary: 33 passed, 1 failed
Failures:
- test_login_with_expired_token: assertion failed
  Expected: Err(AuthError::TokenExpired)
  Got: Ok(User { id: 123 })
```

**State actual status:**
```
Tests: 33 passed, 1 failed.
Failure: test_login_with_expired_token still fails.
The fix didn't handle expired tokens.
Investigating...
```

**Result:** Accurate status, bug caught before committing.
</correction>
</example>

<example>
<scenario>Developer closes bd task without verifying success criteria</scenario>

<code>
bd-3 success criteria:
- [ ] All functions fully implemented (no stubs, no TODOs)
- [ ] Tests written and passing: test_generate_token, test_verify_token
- [ ] Pre-commit hooks pass

Developer implements token functions.

Developer thinks: "I implemented everything, task complete"

Runs: tm close bd-3

[No verification commands run]
</code>

<why_it_fails>
**Success criteria not verified:**
- Might have TODO comments left
- Specific tests not run
- Pre-commit hooks not checked

**Result:** Incomplete task closed, issues discovered later.
</why_it_fails>

<correction>
**Verify each criterion:**

```bash
# 1. Check for TODOs
rg "TODO|FIXME|todo!|unimplemented!" src/
# Output: [nothing found] ✅

# 2. Run specific tests
cargo test test_generate_token test_verify_token
# Output: test result: ok. 2 passed ✅

# 3. Run pre-commit hooks (via test-runner agent)
"Run: cargo fmt --check && cargo clippy && cargo test"
```

**Agent returns:**
```
All checks passed:
- cargo fmt: no formatting issues
- cargo clippy: no warnings
- cargo test: 34/34 passed
```

**THEN close task:**
```bash
tm close bd-3
```

**Result:** Task actually complete, all criteria met with evidence.
</correction>
</example>

<example>
<scenario>Developer claims build works based on linter passing</scenario>

<code>
Developer fixes TypeScript errors flagged by linter.

Runs: npm run lint
Output: ✅ No issues found

Developer writes: "Build passes! Ready to commit."

[No build command run]
</code>

<why_it_fails>
**Linter ≠ compiler:**
- Linter checks style and simple errors
- Doesn't verify imports, types, compilation
- Build might still fail

**Why it happens:** Partial verification, extrapolation.
</why_it_fails>

<correction>
**Run actual build:**

```bash
npm run build
```

**Output:**
```
ERROR in src/auth/service.ts:23:15
TS2304: Cannot find name 'validateToken'
Did you mean 'verifyToken'?
```

**State actual status:**
```
Linter passes, but build fails.
Error: validateToken not defined (should be verifyToken).
Fixing...
```

**After fix, run build again:**
```bash
npm run build
# Output: ✓ built in 1.2s
```

**Now can claim:**
```
Build passes. [Evidence: npm run build exit 0]
Ready to commit.
```

**Result:** Actual build status verified, error caught.
</correction>
</example>

</examples>

<critical_rules>

## Rules That Have No Exceptions

1. **No claims without fresh verification** → Run command, see output, THEN claim
   - "Should work" = forbidden
   - "Looks correct" = forbidden
   - Previous run ≠ fresh verification

2. **Use test-runner agent for verbose commands** → Tests, hooks, commits
   - Prevents context pollution
   - Returns summary + failures only
   - Never run `git commit` or `cargo test` directly if output is verbose

3. **Verify ALL success criteria** → Not just "tests pass"
   - Read each criterion from bd task
   - Run verification for each
   - Check all pass before closing

4. **Evidence in every claim** → Show the output
   - Not: "Tests pass"
   - Yes: "Tests pass [Ran: cargo test, Output: 34/34 passed]"

## Common Excuses

All of these mean: Stop, run verification:
- "Should work now"
- "I'm confident this fixes it"
- "Just this once"
- "Linter passed" (when claiming build works)
- "Agent said success" (without independent verification)
- "I'm tired" (exhaustion ≠ excuse)
- "Partial check is enough"

## Pre-Commit Hook Assumption

**If your project uses pre-commit hooks enforcing tests:**
- All test failures are from your current changes
- Never check if errors were "pre-existing"
- Don't run `git checkout <sha> && pytest` to verify
- Pre-commit hooks guarantee previous commit passed
- Just fix the error directly

</critical_rules>

<verification_checklist>

Before claiming tests pass:
- [ ] Ran full test command (not partial)
- [ ] Saw output showing 0 failures
- [ ] Used test-runner agent if output verbose

Before claiming build succeeds:
- [ ] Ran build command (not just linter)
- [ ] Saw exit code 0
- [ ] Checked for compilation errors

Before closing bd task:
- [ ] Re-read success criteria from bd task
- [ ] Ran verification for each criterion
- [ ] Saw evidence all pass
- [ ] THEN closed task

Before closing bd epic:
- [ ] Ran `tm list --status open --parent bd-1`
- [ ] Saw 0 open tasks
- [ ] Ran `tm dep tree bd-1`
- [ ] Confirmed all tasks closed
- [ ] THEN closed epic

</verification_checklist>

<integration>

**This skill calls:**
- test-runner (for verbose verification commands)

**This skill is called by:**
- test-driven-development (verify tests pass/fail)
- executing-plans (verify task success criteria)
- refactoring-safely (verify tests still pass)
- ALL skills before completion claims

**Agents used:**
- /skill:test-runner (run tests, hooks, commits without output pollution)

</integration>

<resources>

**When stuck:**
- Tempted to say "should work" → Run the verification
- Agent reports success → Check VCS diff, verify independently
- Partial verification → Run complete command
- Tired and want to finish → Run verification anyway, no exceptions

**Verification patterns:**
- Tests: Use test-runner agent, check 0 failures
- Build: Run build command, check exit 0
- bd task: Verify each success criterion
- bd epic: Check all tasks closed with tm list/dep tree

</resources>