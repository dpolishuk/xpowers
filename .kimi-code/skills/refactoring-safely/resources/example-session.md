## Example: Complete Refactoring Session

**Goal:** Extract validation logic from UserService

**Time: 60 minutes**

### Minutes 0-5: Verify Tests Pass
```bash
Dispatch test-runner: "Run: cargo test"
Result: ✓ 234 tests pass
```

### Minutes 5-10: Create bd Task
```bash
tm create "Refactor: Extract user validation" --type task
tm update bd-456 --design "Extract validation to UserValidator class..."
tm update bd-456 --status in_progress
```

### Minutes 10-15: Step 1 - Extract email validation function
```rust
// Extract validate_email()
```
```bash
Dispatch test-runner: "Run: cargo test"
Result: ✓ 234 tests pass
git commit -m "refactor(bd-456): extract email validation"
```

### Minutes 15-20: Step 2 - Extract name validation function
```rust
// Extract validate_name()
```
```bash
Dispatch test-runner: "Run: cargo test"
Result: ✓ 234 tests pass
git commit -m "refactor(bd-456): extract name validation"
```

### Minutes 20-25: Step 3 - Create UserValidator struct
```rust
struct UserValidator { /* empty */ }
impl UserValidator { /* empty */ }
```
```bash
Dispatch test-runner: "Run: cargo test"
Result: ✓ 234 tests pass
git commit -m "refactor(bd-456): create UserValidator struct"
```

### Minutes 25-35: Steps 4-6 - Move validations to UserValidator
Each step: move one method, test, commit

### Minutes 35-45: Step 7 - Update UserService to use validator
```rust
// Use UserValidator instead of inline validation
```
```bash
Dispatch test-runner: "Run: cargo test"
Result: ✓ 234 tests pass
git commit -m "refactor(bd-456): use UserValidator in UserService"
```

### Minutes 45-55: Step 8 - Remove duplication from other services
Each service: one change, test, commit

### Minutes 55-60: Final verification and close
```bash
Dispatch test-runner: "Run: cargo test"
Result: ✓ 234 tests pass

Dispatch test-runner: "Run: cargo clippy"
Result: ✓ No warnings

tm close bd-456
```

**Result:** Refactoring complete, 8 safe commits, all tests green throughout.
