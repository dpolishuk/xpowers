---
name: fixing-bugs
description: Use when encountering a bug - complete workflow from discovery through debugging, bd issue, test-driven fix, verification, and closure
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
Bug fixing is a complete workflow: reproduce, track in bd, debug systematically, write test, fix, verify, close. Every bug gets a bd issue and regression test.
</skill_overview>

<rigidity_level>
LOW FREEDOM - Follow exact workflow: create bd issue → debug with tools → write failing test → fix → verify → close.

Never skip tracking or regression test. Use debugging-with-tools for investigation, test-driven-development for fix.
</rigidity_level>

<quick_reference>

| Step | Action | Command/Skill |
|------|--------|---------------|
| **1. Track** | Create bd bug issue | `tm create "Bug: [description]" --type bug` |
| **2. Debug** | Systematic investigation | Use `debugging-with-tools` skill |
| **3. Test (RED)** | Write failing test reproducing bug | Use `test-driven-development` skill |
| **4. Fix (GREEN)** | Implement fix | Minimal code to pass test |
| **5. Verify** | Run full test suite | Use `verification-before-completion` skill |
| **6. Classify** | Classify status and close | `tm close bd-123` |

**FORBIDDEN:** Fix without bd issue, fix without regression test
**REQUIRED:** Every bug gets tracked, tested, verified before closing

</quick_reference>

<fix_status_values>
## Fix Status Classification

After implementing a fix, classify its status:

| Status | Definition | Next Action |
|--------|------------|-------------|
| **FIXED** | Root cause addressed, regression test passes, full suite passes | Close bd issue |
| **PARTIALLY_FIXED** | Some aspects addressed, others remain | Document what's left, keep issue open |
| **NOT_ADDRESSED** | Fix doesn't address the actual bug | Return to debugging phase |
| **CANNOT_DETERMINE** | Insufficient info to verify fix | Gather more reproduction data |

**Evidence required for each status:**
- FIXED: Regression test output showing pass, full test suite output, root cause explanation
- PARTIALLY_FIXED: List of addressed aspects with evidence, list of remaining aspects
- NOT_ADDRESSED: Explanation of why fix missed the bug, comparison to root cause
- CANNOT_DETERMINE: What information is missing, how to obtain it
</fix_status_values>

<when_to_use>
**Use when you discover a bug:**
- Test failure you need to fix
- Bug reported by user
- Unexpected behavior in development
- Regression from recent change
- Production issue (non-emergency)

**Production emergencies:** Abbreviated workflow OK (hotfix first), but still create bd issue and add regression tests afterward.
</when_to_use>

<the_process>

## 1. Create bd Bug Issue

**Track from the start:**

```bash
tm create "Bug: [Clear description]" --type bug --priority P1
# Returns: bd-123
```

**Document:**
```bash
tm update bd-123 --design "
## Bug Description
[What's wrong]

## Reproduction Steps
1. Step one
2. Step two

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happens]

## Environment
[Version, OS, etc.]"
```

## 2. Debug Systematically

**REQUIRED: Use debugging-with-tools skill**

```
Load skill: /skill:debugging-with-tools
```

**debugging-with-tools will:**
- Use internet-researcher to search for error
- Recommend debugger or instrumentation
- Use codebase-investigator to understand context
- Guide to root cause (not symptom)

**Update bd issue with findings:**
```bash
tm update bd-123 --design "[previous content]

## Investigation
[Root cause found via debugging]
[Tools used: debugger, internet search, etc.]"
```

## 3. Write Failing Test (RED Phase)

**REQUIRED: Use test-driven-development skill**

Write test that reproduces the bug:

```python
def test_rejects_empty_email():
    """Regression test for bd-123: Empty email accepted"""
    with pytest.raises(ValidationError):
        create_user(email="")  # Should fail, currently passes
```

**Run test, verify it FAILS:**
```bash
pytest tests/test_user.py::test_rejects_empty_email
# Expected: PASS (bug exists)
# Should fail AFTER fix
```

**Why critical:** If test passes before fix, it doesn't test the bug.

## 4. Implement Fix (GREEN Phase)

**Fix the root cause (not symptom):**

```python
def create_user(email: str):
    if not email or not email.strip():  # Fix
        raise ValidationError("Email required")
    # ... rest
```

**Run test, verify it now FAILS (test was written backwards by mistake earlier - fix this):**

Actually write the test to FAIL first:
```python
def test_rejects_empty_email():
    with pytest.raises(ValidationError):
        create_user(email="")
```

Run:
```bash
pytest tests/test_user.py::test_rejects_empty_email
# Should FAIL before fix (no validation)
# Should PASS after fix (validation added)
```

## 5. Verify Complete Fix

**REQUIRED: Use verification-before-completion skill**

```bash
# Run full test suite (via test-runner agent)
"Run: pytest"

# Agent returns: All tests pass (including regression test)
```

**Verify:**
- Regression test passes
- All other tests still pass
- No new warnings or errors
- Pre-commit hooks pass

## 6. Classify and Close

**REQUIRED: Classify fix status before closing:**

```bash
tm update bd-123 --design "[previous content]

## Fix Status: FIXED
**Evidence:**
- Root cause: [explanation of what caused the bug]
- Regression test: tests/test_user.py::test_rejects_empty_email PASSES
- Full suite: 145/145 tests pass
- Fix verified: [specific verification that bug is resolved]

## Fix Implemented
[Description of fix]
[File changed: src/auth/user.py:23]

## Regression Test
[Test added: tests/test_user.py::test_rejects_empty_email]"

tm close bd-123
```

**If status is not FIXED:**
- **PARTIALLY_FIXED** → Document remaining work, create follow-up bd issue, keep original open
- **NOT_ADDRESSED** → Return to Step 2 (debugging), do not close
- **CANNOT_DETERMINE** → Gather more reproduction info before closing

**Commit with bd reference:**
```bash
git commit -m "fix(bd-123): Reject empty email in user creation

Adds validation to prevent empty strings.
Regression test: test_rejects_empty_email

Closes bd-123"
```

</the_process>

<examples>

<example>
<scenario>Developer fixes bug without creating bd issue or regression test</scenario>

<code>
Developer notices: Empty email accepted in user creation

"Fixes" immediately:
```python
def create_user(email: str):
    if not email:  # Quick fix
        raise ValidationError("Email required")
```

Commits: "fix: validate email"

[No bd issue, no regression test]
</code>

<why_it_fails>
**No tracking:**
- Work not tracked in bd (can't see what was fixed)
- No link between commit and bug
- Can't verify fix meets requirements

**No regression test:**
- Bug could come back in future
- Can't prove fix works
- No protection against breaking this again

**Incomplete fix:**
- Doesn't handle `email=" "` (whitespace)
- Didn't debug to understand full issue

**Result:** Bug returns when someone changes validation logic.
</why_it_fails>

<correction>
**Complete workflow:**

```bash
# 1. Track
tm create "Bug: Empty email accepted" --type bug
# Returns: bd-123

# 2. Debug (use debugging-with-tools)
# Investigation reveals: Email validation missing entirely
# Also: Whitespace emails like " " also accepted

# 3. Write failing test (RED)
def test_rejects_empty_email():
    with pytest.raises(ValidationError):
        create_user(email="")

def test_rejects_whitespace_email():
    with pytest.raises(ValidationError):
        create_user(email="   ")

# Run: Both PASS (bug exists) - WAIT, test should FAIL before fix!
```

Actually:
```python
# Test currently PASSES (bug exists - no validation)
# We expect test to FAIL after we add validation

# 4. Fix
def create_user(email: str):
    if not email or not email.strip():
        raise ValidationError("Email required")

# 5. Verify
pytest  # All tests pass now, including regression tests

# 6. Close
tm close bd-123
git commit -m "fix(bd-123): Reject empty/whitespace email"
```

**Result:** Bug fixed, tracked, tested, won't regress.
</correction>
</example>

<example>
<scenario>Developer writes test after fix, test passes immediately, doesn't catch regression</scenario>

<code>
Developer fixes validation bug, then writes test:

```python
# Fix first
def validate_email(email):
    return "@" in email and len(email) > 0

# Then test
def test_validate_email():
    assert validate_email("user@example.com") == True
```

Test runs: PASS

Commits both together.

Later, someone changes validation:
```python
def validate_email(email):
    return True  # Breaks validation!
```

Test still PASSES (only checks happy path).
</code>

<why_it_fails>
**Test written after fix:**
- Never saw test fail
- Only tests happy path remembered
- Doesn't test the bug that was fixed
- Missed edge case: `validate_email("@@")` returns True (bug!)

**Why it happens:** Skipping TDD RED phase.
</why_it_fails>

<correction>
**TDD approach (RED-GREEN):**

```python
# 1. Write test FIRST that reproduces the bug
def test_validate_email():
    # Happy path
    assert validate_email("user@example.com") == True
    # Bug case (empty email was accepted)
    assert validate_email("") == False
    # Edge case discovered during debugging
    assert validate_email("@@") == False

# 2. Run test - should FAIL (bug exists)
pytest test_validate_email
# FAIL: validate_email("") returned True, expected False

# 3. Implement fix
def validate_email(email):
    if not email or len(email) == 0:
        return False
    return "@" in email and email.count("@") == 1

# 4. Run test - should PASS
pytest test_validate_email
# PASS: All assertions pass
```

**Later regression:**
```python
def validate_email(email):
    return True  # Someone breaks it
```

**Test catches it:**
```
FAIL: assert validate_email("") == False
Expected False, got True
```

**Result:** Regression test actually prevents bug from returning.
</correction>
</example>

<example>
<scenario>Developer fixes symptom without using debugging-with-tools to find root cause</scenario>

<code>
Bug report: "Application crashes when processing user data"

Error:
```
NullPointerException at UserService.java:45
```

Developer sees line 45:
```java
String email = user.getEmail().toLowerCase();  // Line 45
```

"Obvious fix":
```java
String email = user.getEmail() != null ? user.getEmail().toLowerCase() : "";
```

Bug "fixed"... but crashes continue with different data.
</code>

<why_it_fails>
**Symptom fix:**
- Fixed null check at crash point
- Didn't investigate WHY email is null
- Didn't use debugging-with-tools to find root cause

**Actual root cause:** User object created without email in registration flow. Email is null for all users created via broken endpoint.

**Result:** Null-check applied everywhere, root cause (broken registration) unfixed.
</why_it_fails>

<correction>
**Use debugging-with-tools skill:**

```
# Dispatch internet-researcher
"Search for: NullPointerException UserService getEmail
- Common causes of null email in user objects
- User registration validation patterns"

# Dispatch codebase-investigator
"Investigate:
- How is User object created?
- Where is email set?
- Are there paths where email can be null?
- Which endpoints create users?"

# Agent reports:
"Found: POST /register endpoint creates User without validating email field.
Email is optional in UserDTO but required in User domain object."
```

**Root cause found:** Registration doesn't validate email.

**Proper fix:**
```java
// In registration endpoint
@PostMapping("/register")
public User register(@RequestBody UserDTO dto) {
    if (dto.getEmail() == null || dto.getEmail().isEmpty()) {
        throw new ValidationException("Email required");
    }
    return userService.create(dto);
}
```

**Regression test:**
```java
@Test
void registrationRequiresEmail() {
    assertThrows(ValidationException.class, () ->
        register(new UserDTO(null, "password")));
}
```

**Result:** Root cause fixed, no more null emails created.
</correction>
</example>

</examples>

<critical_rules>

## Rules That Have No Exceptions

1. **Every bug gets a bd issue** → Track from discovery to closure
   - Create bd issue before fixing
   - Document reproduction steps
   - Update with investigation findings
   - Close only after verified

2. **Use debugging-with-tools skill** → Systematic investigation required
   - Never guess at fixes
   - Use internet-researcher for errors
   - Use debugger/instrumentation for state
   - Find root cause, not symptom

3. **Write failing test first (RED)** → Regression prevention
   - Test must fail before fix
   - Test must reproduce the bug
   - Test must pass after fix
   - If test passes immediately, it doesn't test the bug

4. **Verify complete fix** → Use verification-before-completion
   - Regression test passes
   - Full test suite passes
   - No new warnings
   - Pre-commit hooks pass

## Common Excuses

All of these mean: Stop, follow complete workflow:
- "Quick fix, no need for bd issue"
- "Obvious bug, no need to debug"
- "I'll add test later"
- "Test passes, must be fixed"
- "Just one line change"

</critical_rules>

<verification_checklist>

Before claiming bug fixed:
- [ ] bd issue created with reproduction steps
- [ ] Used debugging-with-tools to find root cause
- [ ] Wrote test that reproduces bug (RED phase)
- [ ] Verified test FAILS before fix
- [ ] Implemented fix addressing root cause
- [ ] Verified test PASSES after fix
- [ ] Ran full test suite (all pass)
- [ ] Updated bd issue with fix details
- [ ] Closed bd issue
- [ ] Committed with bd reference

</verification_checklist>

<integration>

**This skill calls:**
- debugging-with-tools (systematic investigation)
- test-driven-development (RED-GREEN-REFACTOR cycle)
- verification-before-completion (verify complete fix)

**This skill is called by:**
- When bugs discovered during development
- When test failures need fixing
- When user reports bugs

**Agents used:**
- /skill:internet-researcher (via debugging-with-tools)
- /skill:codebase-investigator (via debugging-with-tools)
- /skill:test-runner (run tests without output pollution)

</integration>

<resources>

**When stuck:**
- Don't understand bug → Use debugging-with-tools skill
- Tempted to skip tracking → Create bd issue first, always
- Test passes immediately → Not testing the bug, rewrite test
- Fix doesn't work → Return to debugging-with-tools, find actual root cause

</resources>