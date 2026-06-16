---
name: test-driven-development
description: Use when implementing features or fixing bugs - enforces RED-GREEN-REFACTOR cycle requiring tests to fail before writing code
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
Write the test first, watch it fail, write minimal code to pass. If you didn't watch the test fail, you don't know if it tests the right thing.
</skill_overview>

<rigidity_level>
LOW FREEDOM - Follow these exact steps in order. Do not adapt.

Violating the letter of the rules is violating the spirit of the rules.
</rigidity_level>

<quick_reference>

| Phase | Action | Command Example | Expected Result |
|-------|--------|-----------------|-----------------|
| **RED** | Write failing test | `cargo test test_name` | FAIL (feature missing) |
| **Verify RED** | Confirm correct failure | Check error message | "function not found" or assertion fails |
| **GREEN** | Write minimal code | Implement feature | Test passes |
| **Verify GREEN** | All tests pass | `cargo test` | All green, no warnings |
| **REFACTOR** | Clean up code | Improve while green | Tests still pass |

**Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

</quick_reference>

<when_to_use>
**Always use for:**
- New features
- Bug fixes
- Refactoring with behavior changes
- Any production code

**Ask your human partner for exceptions:**
- Throwaway prototypes (will be deleted)
- Generated code
- Configuration files

Thinking "skip TDD just this once"? Stop. That's rationalization.
</when_to_use>

<the_process>

## 1. RED - Write Failing Test

Write one minimal test showing what should happen.

**Requirements:**
- Test one behavior only ("and" in name? Split it)
- Clear name describing behavior
- Use real code (no mocks unless unavoidable)

See [resources/language-examples.md](resources/language-examples.md) for Rust, Swift, TypeScript examples.

## 2. Verify RED - Watch It Fail

**MANDATORY. Never skip.**

Run the test and confirm:
- ✓ Test **fails** (not errors with syntax issues)
- ✓ Failure message is expected ("function not found" or assertion fails)
- ✓ Fails because feature missing (not typos)

**If test passes:** You're testing existing behavior. Fix the test.
**If test errors:** Fix syntax error, re-run until it fails correctly.

## 3. GREEN - Write Minimal Code

Write simplest code to pass the test. Nothing more.

**Key principle:** Don't add features the test doesn't require. Don't refactor other code. Don't "improve" beyond the test.

## 4. Verify GREEN - Watch It Pass

**MANDATORY.**

Run tests and confirm:
- ✓ New test passes
- ✓ All other tests still pass
- ✓ No errors or warnings

**If test fails:** Fix code, not test.
**If other tests fail:** Fix now before proceeding.

## 5. REFACTOR - Clean Up

**Only after green:**
- Remove duplication
- Improve names
- Extract helpers

Keep tests green. Don't add behavior.

## 6. Repeat

Next failing test for next feature.

</the_process>

<examples>

<example>
<scenario>Developer writes implementation first, then adds test that passes immediately</scenario>

<code>
// Code written FIRST
def validate_email(email):
    return "@" in email  # Bug: accepts "@@"

// Test written AFTER
def test_validate_email():
    assert validate_email("user@example.com")  # Passes immediately!
    // Missing edge case: assert not validate_email("@@")
</code>

<why_it_fails>
When test passes immediately:
- Never proved the test catches bugs
- Only tested happy path you remembered
- Forgot edge cases (like "@@")
- Bug ships to production

Tests written after verify remembered cases, not required behavior.
</why_it_fails>

<correction>
**TDD approach:**

1. **RED** - Write test first (including edge case):
```python
def test_validate_email():
    assert validate_email("user@example.com")  # Will fail - function doesn't exist
    assert not validate_email("@@")            # Edge case up front
```

2. **Verify RED** - Run test, watch it fail:
```bash
NameError: function 'validate_email' is not defined
```

3. **GREEN** - Implement to pass both cases:
```python
def validate_email(email):
    return "@" in email and email.count("@") == 1
```

4. **Verify GREEN** - Both assertions pass, bug prevented.

**Result:** Test failed first, proving it works. Edge case discovered during test writing, not in production.
</correction>
</example>

<example>
<scenario>Developer has already written 3 hours of code without tests. Wants to keep it as "reference" while writing tests.</scenario>

<code>
// 200 lines of untested code exists
// Developer thinks: "I'll keep this and write tests that match it"
// Or: "I'll use it as reference to speed up TDD"
</code>

<why_it_fails>
**Keeping code as "reference":**
- You'll copy it (that's testing after, with extra steps)
- You'll adapt it (biased by implementation)
- Tests will match code, not requirements
- You'll justify shortcuts: "I already know this works"

**Result:** All the problems of test-after, none of the benefits of TDD.
</why_it_fails>

<correction>
**Delete it. Completely.**

```bash
git stash  # Or delete the file
```

**Then start TDD:**
1. Write first failing test from requirements (not from code)
2. Watch it fail
3. Implement fresh (might be different from original, that's OK)
4. Watch it pass

**Why delete:**
- Sunk cost is already gone
- 3 hours implementing ≠ 3 hours with TDD (TDD might be 2 hours total)
- Code without tests is technical debt
- Fresh implementation from tests is usually better

**What you gain:**
- Tests that actually verify behavior
- Confidence code works
- Ability to refactor safely
- No bugs from untested edge cases
</correction>
</example>

<example>
<scenario>Test is hard to write. Developer thinks "design must be unclear, but I'll implement first to explore."</scenario>

<code>
// Test attempt:
func testUserServiceCreatesAccount() {
    // Need to mock database, email service, payment gateway, logger...
    // This is getting complicated, maybe I should just implement first
}
</code>

<why_it_fails>
**"Test is hard" is valuable signal:**
- Hard to test = hard to use
- Too many dependencies = coupling too tight
- Complex setup = design needs simplification

**Implementing first ignores this signal:**
- Build the complex design
- Lock in the coupling
- Now forced to write complex tests (or skip them)
</why_it_fails>

<correction>
**Listen to the test.**

Hard to test? Simplify the interface:

```swift
// Instead of:
class UserService {
    init(db: Database, email: EmailService, payments: PaymentGateway, logger: Logger) { }
    func createAccount(email: String, password: String, paymentToken: String) throws { }
}

// Make testable:
class UserService {
    func createAccount(request: CreateAccountRequest) -> Result<Account, Error> {
        // Dependencies injected through request or passed separately
    }
}
```

**Test becomes simple:**
```swift
func testCreatesAccountFromRequest() {
    let service = UserService()
    let request = CreateAccountRequest(email: "user@example.com")
    let result = service.createAccount(request: request)
    XCTAssertEqual(result.email, "user@example.com")
}
```

**TDD forces good design.** If test is hard, fix design before implementing.
</correction>
</example>

</examples>

<critical_rules>

## Rules That Have No Exceptions

1. **Write code before test?** → Delete it. Start over.
   - Never keep as "reference"
   - Never "adapt" while writing tests
   - Delete means delete

2. **Test passes immediately?** → Not TDD. Fix the test or delete the code.
   - Passing immediately proves nothing
   - You're testing existing behavior, not required behavior

3. **Can't explain why test failed?** → Fix until failure makes sense.
   - "function not found" = good (feature doesn't exist)
   - Weird error = bad (fix test, re-run)

4. **Want to skip "just this once"?** → That's rationalization. Stop.
   - TDD is faster than debugging in production
   - "Too simple to test" = test takes 30 seconds
   - "Already manually tested" = not systematic, not repeatable

## Common Excuses

All of these mean: Stop, follow TDD:
- "This is different because..."
- "I'm being pragmatic, not dogmatic"
- "It's about spirit not ritual"
- "Tests after achieve the same goals"
- "Deleting X hours of work is wasteful"

</critical_rules>

<verification_checklist>

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test **fail** before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass with no warnings
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

**Can't check all boxes?** You skipped TDD. Start over.

</verification_checklist>

<integration>

**This skill calls:**
- verification-before-completion (running tests to verify)

**This skill is called by:**
- fixing-bugs (write failing test reproducing bug)
- executing-plans (when implementing bd tasks)
- refactoring-safely (keep tests green while refactoring)

**Agents used:**
- /skill:test-runner (run tests, return summary only)

</integration>

<resources>

**Detailed language-specific examples:**
- [Rust, Swift, TypeScript examples](resources/language-examples.md) - Complete RED-GREEN-REFACTOR cycles
- [Language-specific test commands](resources/language-examples.md#verification-commands-by-language)

**When stuck:**
- Test too complicated? → Design too complicated, simplify interface
- Must mock everything? → Code too coupled, use dependency injection
- Test setup huge? → Extract helpers, or simplify design

</resources>