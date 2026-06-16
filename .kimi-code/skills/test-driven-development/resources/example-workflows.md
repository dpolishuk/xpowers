# TDD Workflow Examples

This guide shows complete TDD workflows for common scenarios: bug fixes and feature additions.

## Example: Bug Fix

### Bug

Empty email is accepted when it should be rejected.

### RED Phase: Write Failing Test

**Swift:**
```swift
func testRejectsEmptyEmail() async throws {
    let result = try await submitForm(FormData(email: ""))
    XCTAssertEqual(result.error, "Email required")
}
```

### Verify RED: Watch It Fail

```bash
$ swift test --filter FormTests.testRejectsEmptyEmail
FAIL: XCTAssertEqual failed: ("nil") is not equal to ("Optional("Email required")")
```

**Confirms:**
- Test fails (not errors)
- Failure message shows email not being validated
- Fails because feature missing (not typos)

### GREEN Phase: Minimal Code

```swift
struct FormResult {
    var error: String?
}

func submitForm(_ data: FormData) async throws -> FormResult {
    if data.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return FormResult(error: "Email required")
    }
    // ... rest of form processing
    return FormResult()
}
```

### Verify GREEN: Watch It Pass

```bash
$ swift test --filter FormTests.testRejectsEmptyEmail
Test Case '-[FormTests testRejectsEmptyEmail]' passed
```

**Confirms:**
- Test passes
- Other tests still pass
- No errors or warnings

### REFACTOR: Clean Up

If multiple fields need validation:

```swift
extension FormData {
    func validate() -> String? {
        if email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Email required"
        }
        // Add other validations...
        return nil
    }
}

func submitForm(_ data: FormData) async throws -> FormResult {
    if let error = data.validate() {
        return FormResult(error: error)
    }
    // ... rest of form processing
    return FormResult()
}
```

Run tests again to confirm still green.

---

## Example: Feature Addition

### Feature

Calculate average of non-empty list.

### RED Phase: Write Failing Test

**TypeScript:**
```typescript
describe('average', () => {
  it('calculates average of non-empty list', () => {
    expect(average([1, 2, 3])).toBe(2);
  });
});
```

### Verify RED: Watch It Fail

```bash
$ npm test -- --testNamePattern="average"
FAIL: ReferenceError: average is not defined
```

**Confirms:**
- Function doesn't exist yet
- Test would verify the behavior when function exists

### GREEN Phase: Minimal Code

```typescript
function average(numbers: number[]): number {
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return sum / numbers.length;
}
```

### Verify GREEN: Watch It Pass

```bash
$ npm test -- --testNamePattern="average"
PASS: calculates average of non-empty list
```

### Add Edge Case: Empty List

**RED:**
```typescript
it('returns 0 for empty list', () => {
  expect(average([])).toBe(0);
});
```

**Verify RED:**
```bash
$ npm test -- --testNamePattern="average.*empty"
FAIL: Expected: 0, Received: NaN
```

**GREEN:**
```typescript
function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return sum / numbers.length;
}
```

**Verify GREEN:**
```bash
$ npm test -- --testNamePattern="average"
PASS: 2 tests passed
```

### REFACTOR: Clean Up

No duplication or unclear naming, so no refactoring needed. Move to next feature.

---

## Example: Refactoring with Tests

### Scenario

Existing function works but is hard to read. Tests exist and pass.

### Current Code

```rust
fn process(data: Vec<i32>) -> i32 {
    let mut result = 0;
    for item in data {
        if item > 0 {
            result += item * 2;
        }
    }
    result
}
```

### Existing Tests (Already Green)

```rust
#[test]
fn processes_positive_numbers() {
    assert_eq!(process(vec![1, 2, 3]), 12); // (1*2) + (2*2) + (3*2) = 12
}

#[test]
fn ignores_negative_numbers() {
    assert_eq!(process(vec![1, -2, 3]), 8); // (1*2) + (3*2) = 8
}

#[test]
fn handles_empty_list() {
    assert_eq!(process(vec![]), 0);
}
```

### REFACTOR: Improve Clarity

```rust
fn process(data: Vec<i32>) -> i32 {
    data.iter()
        .filter(|&&n| n > 0)
        .map(|&n| n * 2)
        .sum()
}
```

### Verify Still Green

```bash
$ cargo test
running 3 tests
test processes_positive_numbers ... ok
test ignores_negative_numbers ... ok
test handles_empty_list ... ok

test result: ok. 3 passed; 0 failed
```

**Key:** Tests prove refactoring didn't break behavior.

---

## Common Patterns

### Pattern: Adding Validation

1. **RED:** Test that invalid input is rejected
2. **Verify RED:** Confirm invalid input currently accepted
3. **GREEN:** Add validation check
4. **Verify GREEN:** Confirm validation works
5. **REFACTOR:** Extract validation if reusable

### Pattern: Adding Error Handling

1. **RED:** Test that error condition is caught
2. **Verify RED:** Confirm error currently unhandled
3. **GREEN:** Add error handling
4. **Verify GREEN:** Confirm error handled correctly
5. **REFACTOR:** Consolidate error handling if duplicated

### Pattern: Optimizing Performance

1. **Ensure tests exist and pass** (if not, add tests first)
2. **REFACTOR:** Optimize implementation
3. **Verify GREEN:** Confirm tests still pass
4. **Measure:** Confirm performance improved

**Note:** Never optimize without tests. You can't prove optimization didn't break behavior.

---

## Workflow Checklist

### For Each New Feature

- [ ] Write one failing test
- [ ] Run test, confirm it fails correctly
- [ ] Write minimal code to pass
- [ ] Run test, confirm it passes
- [ ] Run all tests, confirm no regressions
- [ ] Refactor if needed (staying green)
- [ ] Commit

### For Each Bug Fix

- [ ] Write test reproducing the bug
- [ ] Run test, confirm it fails (reproduces bug)
- [ ] Fix the bug (minimal change)
- [ ] Run test, confirm it passes (bug fixed)
- [ ] Run all tests, confirm no regressions
- [ ] Commit

### For Each Refactoring

- [ ] Confirm tests exist and pass
- [ ] Make one small refactoring change
- [ ] Run tests, confirm still green
- [ ] Repeat until refactoring complete
- [ ] Commit

---

## Anti-Patterns to Avoid

### ❌ Writing Multiple Tests Before Implementing

**Why bad:** You can't tell which test makes implementation fail. Write one, implement, repeat.

### ❌ Changing Test to Make It Pass

**Why bad:** Test should define correct behavior. If test is wrong, fix test first, then re-run RED phase.

### ❌ Adding Features Not Covered by Tests

**Why bad:** Untested code. If you need a feature, write test first.

### ❌ Skipping RED Verification

**Why bad:** Test might pass immediately, meaning it doesn't test anything new.

### ❌ Skipping GREEN Verification

**Why bad:** Test might fail for unexpected reason. Always verify expected pass.

---

## Remember

- **One test at a time:** Write test, implement, repeat
- **Watch it fail:** Proves test actually tests something
- **Watch it pass:** Proves implementation works
- **Stay green:** All tests pass before moving on
- **Refactor freely:** Tests catch breaks
