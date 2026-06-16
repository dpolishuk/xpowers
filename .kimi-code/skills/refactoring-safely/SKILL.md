---
name: refactoring-safely
description: Use when refactoring code - test-preserving transformations in small steps, running tests between each change
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
Refactoring changes code structure without changing behavior; tests must stay green throughout or you're rewriting, not refactoring.
</skill_overview>

<rigidity_level>
MEDIUM FREEDOM - Follow the change→test→commit cycle strictly, but adapt the specific refactoring patterns to your language and codebase.
</rigidity_level>

<quick_reference>
| Step | Action | Verify |
|------|--------|--------|
| 1 | Run full test suite | ALL pass |
| 2 | Create bd refactoring task | Track work |
| 3 | Make ONE small change | Compiles |
| 4 | Run tests immediately | ALL still pass |
| 5 | Commit with descriptive message | History clear |
| 6 | Repeat 3-5 until complete | Each step safe |
| 7 | Final verification & close bd | Done |

**Core cycle:** Change → Test → Commit (repeat until complete)
</quick_reference>

<when_to_use>
- Improving code structure without changing functionality
- Extracting duplicated code into shared utilities
- Renaming for clarity
- Reorganizing file/module structure
- Simplifying complex code while preserving behavior

**Don't use for:**
- Changing functionality (use feature development)
- Fixing bugs (use /skill:fixing-bugs)
- Adding features while restructuring (do separately)
- Code without tests (write tests first using /skill:test-driven-development)
</when_to_use>

<the_process>
## 1. Verify Tests Pass

**BEFORE any refactoring:**

```bash
# Use test-runner agent to keep context clean
Dispatch /skill:test-runner agent: "Run: cargo test"
```

**Verify:** ALL tests pass. If any fail, fix them FIRST, then refactor.

**Why:** Failing tests mean you can't detect if refactoring breaks things.

---

## 2. Create bd Task for Refactoring

Track the refactoring work:

```bash
tm create "Refactor: Extract user validation logic" \
  --type task \
  --priority P2

tm update bd-456 --design "
## Goal
Extract user validation logic from UserService into separate Validator class.

## Why
- Validation duplicated across 3 services
- Makes testing individual validations difficult
- Violates single responsibility

## Approach
1. Create UserValidator class
2. Extract email validation
3. Extract name validation
4. Extract age validation
5. Update UserService to use validator
6. Remove duplication from other services

## Success Criteria
- All existing tests still pass
- No behavior changes
- Validator has 100% test coverage
"

tm update bd-456 --status in_progress
```

---

## 3. Make ONE Small Change

The smallest transformation that compiles.

**Examples of "small":**
- Extract one method
- Rename one variable
- Move one function to different file
- Inline one constant
- Extract one interface

**NOT small:**
- Extracting multiple methods at once
- Renaming + moving + restructuring
- "While I'm here" improvements

**Example:**

```rust
// Before
fn create_user(name: &str, email: &str) -> Result<User> {
    if email.is_empty() {
        return Err(Error::InvalidEmail);
    }
    if !email.contains('@') {
        return Err(Error::InvalidEmail);
    }

    let user = User { name, email };
    Ok(user)
}

// After - ONE small change (extract email validation)
fn create_user(name: &str, email: &str) -> Result<User> {
    validate_email(email)?;

    let user = User { name, email };
    Ok(user)
}

fn validate_email(email: &str) -> Result<()> {
    if email.is_empty() {
        return Err(Error::InvalidEmail);
    }
    if !email.contains('@') {
        return Err(Error::InvalidEmail);
    }
    Ok(())
}
```

---

## 4. Run Tests Immediately

After EVERY small change:

```bash
Dispatch /skill:test-runner agent: "Run: cargo test"
```

**Verify:** ALL tests still pass.

**If tests fail:**
1. STOP
2. Undo the change: `git restore src/file.rs`
3. Understand why it broke
4. Make smaller change
5. Try again

**Never proceed with failing tests.**

---

## 5. Commit the Small Change

Commit each safe transformation:

```bash
Dispatch /skill:test-runner agent: "Run: git add src/user_service.rs && git commit -m 'refactor(bd-456): extract email validation to function

No behavior change. All tests pass.

Part of bd-456'"
```

**Why commit so often:**
- Easy to undo if next step breaks
- Clear history of transformations
- Can review each step independently
- Proves tests passed at each point

---

## 6. Repeat Until Complete

Repeat steps 3-5 for each small transformation:

```
1. Extract validate_email() ✓ (committed)
2. Extract validate_name() ✓ (committed)
3. Extract validate_age() ✓ (committed)
4. Create UserValidator struct ✓ (committed)
5. Move validations into UserValidator ✓ (committed)
6. Update UserService to use validator ✓ (committed)
7. Remove validation from OrderService ✓ (committed)
8. Remove validation from AccountService ✓ (committed)
```

**Pattern:** change → test → commit (repeat)

---

## 7. Final Verification

After all transformations complete:

```bash
# Full test suite
Dispatch /skill:test-runner agent: "Run: cargo test"

# Linter
Dispatch /skill:test-runner agent: "Run: cargo clippy"
```

**Review the changes:**

```bash
# See all refactoring commits
git log --oneline | grep "bd-456"

# Review full diff
git diff main...HEAD
```

**Checklist:**
- [ ] All tests pass
- [ ] No new warnings
- [ ] No behavior changes
- [ ] Code is cleaner/simpler
- [ ] Each commit is small and safe

**Close bd task:**

```bash
tm update bd-456 --design "
... (append to existing design)

## Completed
- Created UserValidator class with email, name, age validation
- Removed duplicated validation from 3 services
- All tests pass (verified)
- No behavior changes
- 8 small transformations, each tested
"

tm close bd-456
```
</the_process>

<examples>
<example>
<scenario>Developer changes behavior while "refactoring"</scenario>

<code>
// Original code
fn validate_email(email: &str) -> Result<()> {
    if email.is_empty() {
        return Err(Error::InvalidEmail);
    }
    if !email.contains('@') {
        return Err(Error::InvalidEmail);
    }
    Ok(())
}

// "Refactored" version
fn validate_email(email: &str) -> Result<()> {
    if email.is_empty() {
        return Err(Error::InvalidEmail);
    }
    if !email.contains('@') {
        return Err(Error::InvalidEmail);
    }
    // NEW: Added extra validation
    if !email.contains('.') {  // BEHAVIOR CHANGE
        return Err(Error::InvalidEmail);
    }
    Ok(())
}
</code>

<why_it_fails>
- This changes behavior (now rejects emails like "user@localhost")
- Tests might fail, or worse, pass and ship breaking change
- Not refactoring - this is modifying functionality
- Users who relied on old behavior experience regression
</why_it_fails>

<correction>
**Correct approach:**

1. Extract validation (pure refactoring, no behavior change)
2. Commit with tests passing
3. THEN add new validation as separate feature with new tests
4. Two clear commits: refactoring vs. feature addition

**What you gain:**
- Clear history of what changed when
- Easy to revert feature without losing refactoring
- Tests document exact behavior changes
- No surprises in production
</correction>
</example>

<example>
<scenario>Developer does big-bang refactoring</scenario>

<code>
# Changes made all at once:
- Renamed 15 functions across 5 files
- Extracted 3 new classes
- Moved code between 10 files
- Reorganized module structure
- Updated all import statements

# Then runs tests
$ cargo test
... 23 test failures ...

# Now what? Which change broke what?
</code>

<why_it_fails>
- Can't identify which specific change broke tests
- Reverting means losing ALL work
- Fixing requires re-debugging entire refactoring
- Wastes hours trying to untangle failures
- Might give up and revert everything
</why_it_fails>

<correction>
**Correct approach:**

1. Rename ONE function → test → commit
2. Extract ONE class → test → commit
3. Move ONE file → test → commit
4. Continue one change at a time

**If test fails:**
- Know exactly which change broke it
- Revert ONE commit, not all work
- Fix or make smaller change
- Continue from known-good state

**What you gain:**
- Tests break → immediately know why
- Each commit is reviewable independently
- Can stop halfway with useful progress
- Confidence from continuous green tests
- Clear history for future developers
</correction>
</example>

<example>
<scenario>Developer refactors code without tests</scenario>

<code>
// Legacy code with no tests
fn process_payment(amount: f64, user_id: i64) -> Result<PaymentId> {
    // 200 lines of complex payment logic
    // Multiple edge cases
    // No tests exist
}

// Developer refactors without tests:
// - Extracts 5 methods
// - Renames variables
// - Simplifies conditionals
// - "Looks good to me!"

// Deploys to production
// 💥 Payments fail for amounts over $1000
// Edge case handling was accidentally changed
</code>

<why_it_fails>
- No tests to verify behavior preserved
- Complex logic has hidden edge cases
- Subtle behavior changes go unnoticed
- Breaks in production, not development
- Costs customer trust and emergency debugging
</why_it_fails>

<correction>
**Correct approach:**

1. **Write tests FIRST** (using /skill:test-driven-development)
   - Test happy path
   - Test all edge cases (amounts over $1000, etc.)
   - Test error conditions
   - Run tests → all pass (documenting current behavior)

2. **Then refactor with tests as safety net**
   - Extract method → run tests → commit
   - Rename → run tests → commit
   - Simplify → run tests → commit

3. **Tests catch any behavior changes immediately**

**What you gain:**
- Confidence behavior is preserved
- Edge cases documented in tests
- Catches subtle changes before production
- Future refactoring is also safe
- Tests serve as documentation
</correction>
</example>
</examples>

<refactor_vs_rewrite>
## When to Refactor

- Tests exist and pass
- Changes are incremental
- Business logic stays same
- Can transform in small, safe steps
- Each step independently valuable

## When to Rewrite

- No tests exist (write tests first, then refactor)
- Fundamental architecture change needed
- Easier to rebuild than modify
- Requirements changed significantly
- After 3+ failed refactoring attempts

**Rule:** If you need to change test assertions (not just add tests), you're rewriting, not refactoring.

## Strangler Fig Pattern (Hybrid)

**When to use:**
- Need to replace legacy system but can't tolerate downtime
- Want incremental migration with continuous monitoring
- System too large to refactor in one go

**How it works:**

1. **Transform:** Create modernized components alongside legacy
2. **Coexist:** Both systems run in parallel (façade routes requests)
3. **Eliminate:** Retire old functionality piece by piece

**Example:**

```
Legacy: Monolithic user service (50K LOC)
Goal: Microservices architecture

Step 1 (Transform):
- Create new UserService microservice
- Implement user creation endpoint
- Tests pass in isolation

Step 2 (Coexist):
- Add routing layer (façade)
- Route POST /users to new service
- Route GET /users to legacy service (for now)
- Monitor both, compare results

Step 3 (Eliminate):
- Once confident, migrate GET /users to new service
- Remove user creation from legacy
- Repeat for remaining endpoints
```

**Benefits:**
- Incremental replacement reduces risk
- Legacy continues operating during transition
- Can pause/rollback at any point
- Each migration step is independently valuable

**Use refactoring within components, Strangler Fig for replacing systems.**
</refactor_vs_rewrite>

<critical_rules>
## Rules That Have No Exceptions

1. **Tests must stay green** throughout refactoring → If they fail, you changed behavior (stop and undo)
2. **Commit after each small change** → Large commits hide which change broke what
3. **One transformation at a time** → Multiple changes = impossible to debug failures
4. **Run tests after EVERY change** → Delayed testing doesn't tell you which change broke it
5. **If tests fail 3+ times, question approach** → Might need to rewrite instead, or add tests first

## Common Excuses

All of these mean: **Stop and return to the change→test→commit cycle**

- "Small refactoring, don't need tests between steps"
- "I'll test at the end"
- "Tests are slow, I'll run once at the end"
- "Just fixing bugs while refactoring" (bug fixes = behavior changes = not refactoring)
- "Easier to do all at once"
- "I know it works without tests"
- "While I'm here, I'll also..." (scope creep during refactoring)
- "Tests will fail temporarily but I'll fix them" (tests must stay green)
</critical_rules>

<verification_checklist>
Before marking refactoring complete:

- [ ] All tests pass (verified with /skill:test-runner agent)
- [ ] No new linter warnings
- [ ] No behavior changes introduced
- [ ] Code is cleaner/simpler than before
- [ ] Each commit in history is small and safe
- [ ] bd task documents what was done and why
- [ ] Can explain what each transformation did

**Can't check all boxes?** Return to process and fix before closing bd task.
</verification_checklist>

<integration>
**This skill requires:**
- /skill:test-driven-development (for writing tests before refactoring if none exist)
- /skill:verification-before-completion (for final verification)
- /skill:test-runner agent (for running tests without context pollution)

**This skill is called by:**
- General development workflows when improving code structure
- After features are complete and working
- When preparing code for new features

**Agents used:**
- test-runner (runs tests/commits without polluting main context)
</integration>

<resources>
**Detailed guides:**
- [Common refactoring patterns](resources/refactoring-patterns.md) - Extract Method, Extract Class, Inline, etc.
- [Complete refactoring session example](resources/example-session.md) - Minute-by-minute walkthrough

**When stuck:**
- Tests fail after change → Undo (git restore), make smaller change
- 3+ failures → Question if refactoring is right approach, consider rewrite
- No tests exist → Use /skill:test-driven-development to write tests first
- Unsure how small → If it touches more than one function/file, it's too big
</resources>