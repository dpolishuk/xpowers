---
name: testing-anti-patterns
description: Use when writing or changing tests, adding mocks - prevents testing mock behavior, production pollution with test-only methods, and mocking without understanding dependencies
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
Tests must verify real behavior, not mock behavior; mocks are tools to isolate, not things to test.
</skill_overview>

<rigidity_level>
LOW FREEDOM - The 3 Iron Laws are absolute (never test mocks, never add test-only methods, never mock without understanding). Apply gate functions strictly.
</rigidity_level>

<quick_reference>
## The 3 Iron Laws

1. **NEVER test mock behavior** → Test real component behavior
2. **NEVER add test-only methods to production** → Use test utilities instead
3. **NEVER mock without understanding** → Know dependencies before mocking

## Gate Functions (Use Before Action)

**Before asserting on any mock:**
- Ask: "Am I testing real behavior or mock existence?"
- If mock existence → STOP, delete assertion

**Before adding method to production:**
- Ask: "Is this only used by tests?"
- If yes → STOP, put in test utilities

**Before mocking:**
- Ask: "What side effects does real method have?"
- Ask: "Does test depend on those side effects?"
- If depends → Mock lower level, not this method
</quick_reference>

<when_to_use>
- Writing new tests
- Adding mocks to tests
- Tempted to add method only tests will use
- Test failing and considering mocking something
- Unsure whether to mock a dependency
- Test setup becoming complex with mocks

**Critical moment:** Before you add a mock or test-only method, use this skill's gate functions.
</when_to_use>

<the_iron_laws>
## Law 1: Never Test Mock Behavior

**Anti-pattern:**
```rust
// ❌ BAD: Testing that mock exists
#[test]
fn test_processes_request() {
    let mock_service = MockApiService::new();
    let handler = RequestHandler::new(Box::new(mock_service));

    // Testing mock existence, not behavior
    assert!(handler.service().is_mock());
}
```

**Why wrong:** Verifies mock works, not that code works.

**Fix:**
```rust
// ✅ GOOD: Test real behavior
#[test]
fn test_processes_request() {
    let service = TestApiService::new();  // Real implementation or full fake
    let handler = RequestHandler::new(Box::new(service));

    let result = handler.process_request("data");
    assert_eq!(result.status, StatusCode::OK);
}
```

---

## Law 2: Never Add Test-Only Methods to Production

**Anti-pattern:**
```rust
// ❌ BAD: reset() only used in tests
pub struct Connection {
    pool: Arc<ConnectionPool>,
}

impl Connection {
    pub fn reset(&mut self) {  // Looks like production API!
        self.pool.clear_all();
    }
}

// In tests
#[test]
fn test_something() {
    let mut conn = Connection::new();
    conn.reset();  // Test-only method
}
```

**Why wrong:**
- Production code polluted with test-only methods
- Dangerous if accidentally called in production
- Confuses object lifecycle with entity lifecycle

**Fix:**
```rust
// ✅ GOOD: Test utilities handle cleanup
// Connection has no reset()

// In tests/test_utils.rs
pub fn cleanup_connection(conn: &Connection) {
    if let Some(pool) = conn.get_pool() {
        pool.clear_test_data();
    }
}

// In tests
#[test]
fn test_something() {
    let conn = Connection::new();
    cleanup_connection(&conn);
}
```

---

## Law 3: Never Mock Without Understanding

**Anti-pattern:**
```rust
// ❌ BAD: Mock breaks test logic
#[test]
fn test_detects_duplicate_server() {
    // Mock prevents config write that test depends on!
    let mut config_manager = MockConfigManager::new();
    config_manager.expect_add_server()
        .returning(|_| Ok(()));  // No actual config write!

    config_manager.add_server(&config).unwrap();
    config_manager.add_server(&config).unwrap();  // Should fail - but won't!
}
```

**Why wrong:** Mocked method had side effect test depended on (writing config).

**Fix:**
```rust
// ✅ GOOD: Mock at correct level
#[test]
fn test_detects_duplicate_server() {
    // Mock the slow part, preserve behavior test needs
    let server_manager = MockServerManager::new();  // Just mock slow server startup
    let config_manager = ConfigManager::new_with_manager(server_manager);

    config_manager.add_server(&config).unwrap();  // Config written
    let result = config_manager.add_server(&config);  // Duplicate detected ✓
    assert!(result.is_err());
}
```
</the_iron_laws>

<gate_functions>
## Gate Function 1: Before Asserting on Mock

```
BEFORE any assertion that checks mock elements:

1. Ask: "Am I testing real component behavior or just mock existence?"

2. If testing mock existence:
   STOP - Delete the assertion or unmock the component

3. Test real behavior instead
```

**Examples of mock existence testing (all wrong):**
- `assert!(handler.service().is_mock())`
- `XCTAssertTrue(manager.delegate is MockDelegate)`
- `expect(component.database).toBe(mockDb)`

---

## Gate Function 2: Before Adding Method to Production

```
BEFORE adding any method to production class:

1. Ask: "Is this only used by tests?"

2. If yes:
   STOP - Don't add it
   Put it in test utilities instead

3. Ask: "Does this class own this resource's lifecycle?"

4. If no:
   STOP - Wrong class for this method
```

**Red flags:**
- Method named `reset()`, `clear()`, `cleanup()` in production class
- Method only has `#[cfg(test)]` callers
- Method added "for testing purposes"

---

## Gate Function 3: Before Mocking

```
BEFORE mocking any method:

STOP - Don't mock yet

1. Ask: "What side effects does the real method have?"
2. Ask: "Does this test depend on any of those side effects?"
3. Ask: "Do I fully understand what this test needs?"

If depends on side effects:
  → Mock at lower level (the actual slow/external operation)
  → OR use test doubles that preserve necessary behavior
  → NOT the high-level method the test depends on

If unsure what test depends on:
  → Run test with real implementation FIRST
  → Observe what actually needs to happen
  → THEN add minimal mocking at the right level
```

**Red flags:**
- "I'll mock this to be safe"
- "This might be slow, better mock it"
- Mocking without understanding dependency chain
</gate_functions>

<examples>
<example>
<scenario>Developer tests mock behavior instead of real behavior</scenario>

<code>
#[test]
fn test_user_service_initialized() {
    let mock_db = MockDatabase::new();
    let service = UserService::new(mock_db);

    // Testing that mock exists
    assert_eq!(service.database().connection_string(), "mock://test");
    assert!(service.database().is_test_mode());
}
</code>

<why_it_fails>
- Assertions check mock properties, not service behavior
- Test passes when mock is correct, fails when mock is wrong
- Tells you nothing about whether UserService works
- Would pass even if UserService.new() does nothing
- False confidence - mock works, but does service work?
</why_it_fails>

<correction>
**Apply Gate Function 1:**

"Am I testing real behavior or mock existence?"
→ Testing mock existence (connection_string(), is_test_mode() are mock properties)

**Fix:**

```rust
#[test]
fn test_user_service_creates_user() {
    let db = TestDatabase::new();  // Real test implementation
    let service = UserService::new(db);

    // Test real behavior
    let user = service.create_user("alice", "alice@example.com").unwrap();
    assert_eq!(user.name, "alice");
    assert_eq!(user.email, "alice@example.com");

    // Verify user was saved
    let retrieved = service.get_user(user.id).unwrap();
    assert_eq!(retrieved.name, "alice");
}
```

**What you gain:**
- Tests actual UserService behavior
- Validates create and retrieve work
- Would fail if service broken (even with working mock)
- Confidence service actually works
</correction>
</example>

<example>
<scenario>Developer adds test-only method to production class</scenario>

<code>
// Production code
pub struct Database {
    pool: ConnectionPool,
}

impl Database {
    pub fn new() -> Self { /* ... */ }

    // Added "for testing"
    pub fn reset(&mut self) {
        self.pool.clear();
        self.pool.reinitialize();
    }
}

// Tests
#[test]
fn test_user_creation() {
    let mut db = Database::new();
    // ... test logic ...
    db.reset();  // Clean up
}

#[test]
fn test_user_deletion() {
    let mut db = Database::new();
    // ... test logic ...
    db.reset();  // Clean up
}
</code>

<why_it_fails>
- Production Database polluted with test-only reset()
- reset() looks like legitimate API to other developers
- Dangerous if accidentally called in production (clears all data!)
- Violates single responsibility (Database manages connections, not test lifecycle)
- Every test class now needs reset() added
</why_it_fails>

<correction>
**Apply Gate Function 2:**

"Is this only used by tests?" → YES
"Does Database class own test lifecycle?" → NO

**Fix:**

```rust
// Production code (NO reset method)
pub struct Database {
    pool: ConnectionPool,
}

impl Database {
    pub fn new() -> Self { /* ... */ }
    // No reset() - production code clean
}

// Test utilities (tests/test_utils.rs)
pub fn create_test_database() -> Database {
    Database::new()
}

pub fn cleanup_database(db: &mut Database) {
    // Access internals properly for cleanup
    if let Some(pool) = db.get_pool_mut() {
        pool.clear_test_data();
    }
}

// Tests
#[test]
fn test_user_creation() {
    let mut db = create_test_database();
    // ... test logic ...
    cleanup_database(&mut db);
}
```

**What you gain:**
- Production code has no test pollution
- No risk of accidental production calls
- Clear separation: Database manages connections, test utils manage test lifecycle
- Test utilities can evolve without changing production code
</correction>
</example>

<example>
<scenario>Developer mocks without understanding dependencies</scenario>

<code>
#[test]
fn test_detects_duplicate_server() {
    // "I'll mock ConfigManager to speed up the test"
    let mut mock_config = MockConfigManager::new();
    mock_config.expect_add_server()
        .times(2)
        .returning(|_| Ok(()));  // Always returns Ok!

    // Test expects duplicate detection
    mock_config.add_server(&server_config).unwrap();
    let result = mock_config.add_server(&server_config);

    // Assertion fails! Mock always returns Ok, no duplicate detection
    assert!(result.is_err());  // FAILS
}
</code>

<why_it_fails>
- Mocked add_server() without understanding it writes config
- Mock returns Ok() both times (no duplicate detection)
- Test depends on ConfigManager's internal state tracking
- Mock eliminates the behavior test needs to verify
- "Speeding up" by mocking broke the test
</why_it_fails>

<correction>
**Apply Gate Function 3:**

"What side effects does add_server() have?" → Writes to config file, tracks added servers
"Does test depend on those?" → YES! Test needs duplicate detection
"Do I understand what test needs?" → Now yes

**Fix:**

```rust
#[test]
fn test_detects_duplicate_server() {
    // Mock at the RIGHT level - just the slow I/O
    let mock_file_system = MockFileSystem::new();  // Mock slow file writes
    let config_manager = ConfigManager::new_with_fs(mock_file_system);

    // ConfigManager's duplicate detection still works
    config_manager.add_server(&server_config).unwrap();
    let result = config_manager.add_server(&server_config);

    // Passes! ConfigManager tracks duplicates, only file I/O is mocked
    assert!(result.is_err());
}
```

**What you gain:**
- Test verifies real duplicate detection logic
- Only mocked the actual slow part (file I/O)
- ConfigManager's internal tracking works normally
- Test actually validates the feature
</correction>
</example>
</examples>

<additional_anti_patterns>
## Anti-Pattern 4: Incomplete Mocks

**Problem:** Mock only fields you think you need, omit others.

```rust
// ❌ BAD: Partial mock
struct MockResponse {
    status: String,
    data: UserData,
    // Missing: metadata that downstream code uses
}

impl ApiResponse for MockResponse {
    fn metadata(&self) -> &Metadata {
        panic!("metadata not implemented!")  // Breaks at runtime!
    }
}
```

**Fix:** Mirror real API completely.

```rust
// ✅ GOOD: Complete mock
struct MockResponse {
    status: String,
    data: UserData,
    metadata: Metadata,  // All fields real API returns
}
```

**Gate function:**
```
BEFORE creating mock responses:
  1. Examine actual API response structure
  2. Include ALL fields system might consume
  3. Verify mock matches real schema completely
```

---

## Anti-Pattern 5: Over-Complex Mocks

**Warning signs:**
- Mock setup longer than test logic
- Mocking everything to make test pass
- Test breaks when mock changes

**Consider:** Integration tests with real components often simpler than complex mocks.
</additional_anti_patterns>

<tdd_prevention>
## TDD Prevents These Anti-Patterns

**Why TDD helps:**

1. **Write test first** → Forces thinking about what you're actually testing
2. **Watch it fail** → Confirms test tests real behavior, not mocks
3. **Minimal implementation** → No test-only methods creep in
4. **Real dependencies** → See what test needs before mocking

**If you're testing mock behavior, you violated TDD** - you added mocks without watching test fail against real code first.

**REQUIRED BACKGROUND:** You MUST understand /skill:test-driven-development before using this skill.
</tdd_prevention>

<critical_rules>
## Rules That Have No Exceptions

1. **Never test mock behavior** → Test real component behavior always
2. **Never add test-only methods to production** → Pollutes production code
3. **Never mock without understanding** → Must know dependencies and side effects
4. **Use gate functions before action** → Before asserting, adding methods, or mocking
5. **Follow TDD** → Write test first, watch fail, prevents testing mocks

## Common Excuses

All of these mean: **STOP. Apply the gate function.**

- "Just checking the mock is wired up" (Testing mock, not behavior)
- "Need reset() for test cleanup" (Test-only method, use test utilities)
- "I'll mock this to be safe" (Don't understand dependencies)
- "Mock setup is complex but necessary" (Probably over-mocking)
- "This will speed up tests" (Might break test logic)
</critical_rules>

<verification_checklist>
Before claiming tests are correct:

- [ ] No assertions on mock elements (no `is_mock()`, `is MockType`, etc.)
- [ ] No test-only methods in production classes
- [ ] All mocks preserve side effects test depends on
- [ ] Mock at lowest level needed (mock slow I/O, not business logic)
- [ ] Understand why each mock is necessary
- [ ] Mock structure matches real API completely
- [ ] Test logic shorter/equal to mock setup (not longer)
- [ ] Followed TDD (test failed with real code before mocking)

**Can't check all boxes?** Apply gate functions and refactor.
</verification_checklist>

<integration>
**This skill requires:**
- /skill:test-driven-development (prevents these anti-patterns)
- Understanding of mocking vs. faking vs. stubbing

**This skill is called by:**
- When writing tests
- When adding mocks
- When test setup becoming complex
- /skill:test-driven-development (use gate functions during RED phase)

**Red flags triggering this skill:**
- Assertion checks for `*-mock` test IDs
- Methods only called in test files
- Mock setup >50% of test
- Test fails when you remove mock
- Can't explain why mock needed
</integration>

<resources>
**Detailed guides:**
- [Mocking vs Faking vs Stubbing](resources/test-doubles.md)
- [Test utilities patterns](resources/test-utilities.md)
- [When to use integration tests](resources/integration-vs-unit.md)

**When stuck:**
- Mock too complex → Consider integration test with real components
- Unsure what to mock → Run with real implementation first, observe
- Test failing mysteriously → Check if mock breaks test logic (use Gate Function 3)
- Production polluted → Move all test helpers to test_utils
</resources>