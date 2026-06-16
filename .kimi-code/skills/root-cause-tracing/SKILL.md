---
name: root-cause-tracing
description: Use when errors occur deep in execution - traces bugs backward through call stack to find original trigger, not just symptom
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
Bugs manifest deep in the call stack; trace backward until you find the original trigger, then fix at source, not where error appears.
</skill_overview>

<rigidity_level>
MEDIUM FREEDOM - Follow the backward tracing process strictly, but adapt instrumentation and debugging techniques to your language and tools.
</rigidity_level>

<quick_reference>
| Step | Action | Question |
|------|--------|----------|
| 1 | Read error completely | What failed and where? |
| 2 | Find immediate cause | What code directly threw this? |
| 3 | Trace backward one level | What called this code? |
| 4 | Keep tracing up stack | What called that? |
| 5 | Find where bad data originated | Where was invalid value created? |
| 6 | Fix at source | Address root cause |
| 7 | Add defense at each layer | Validate assumptions as backup |

**Core rule:** Never fix just where error appears. Fix where problem originates.
</quick_reference>

<when_to_use>
- Error happens deep in execution (not at entry point)
- Stack trace shows long call chain
- Unclear where invalid data originated
- Need to find which test/code triggers problem
- Error message points to utility/library code

**Example symptoms:**
- "Database rejects empty string" ← Where did empty string come from?
- "File not found: ''" ← Why is path empty?
- "Invalid argument to function" ← Who passed invalid argument?
- "Null pointer dereference" ← What should have been initialized?
</when_to_use>

<the_process>
## 1. Observe the Symptom

Read the complete error:

```
Error: Invalid email format: ""
  at validateEmail (validator.ts:42)
  at UserService.create (user-service.ts:18)
  at ApiHandler.createUser (api-handler.ts:67)
  at HttpServer.handleRequest (server.ts:123)
  at TestCase.test_create_user (user.test.ts:10)
```

**Symptom:** Email validation fails on empty string
**Location:** Deep in validator utility

**DON'T fix here yet.** This might be symptom, not source.

---

## 2. Find Immediate Cause

What code directly causes this?

```typescript
// validator.ts:42
function validateEmail(email: string): boolean {
  if (!email) throw new Error(`Invalid email format: "${email}"`);
  return EMAIL_REGEX.test(email);
}
```

**Question:** Why is email empty? Keep tracing.

---

## 3. Trace Backward: What Called This?

Use stack trace:

```typescript
// user-service.ts:18
create(request: UserRequest): User {
  validateEmail(request.email); // Called with request.email = ""
  // ...
}
```

**Question:** Why is `request.email` empty? Keep tracing.

---

## 4. Keep Tracing Up the Stack

```typescript
// api-handler.ts:67
async createUser(req: Request): Promise<Response> {
  const userRequest = {
    name: req.body.name,
    email: req.body.email || "", // ← FOUND IT!
  };
  return this.userService.create(userRequest);
}
```

**Root cause found:** API handler provides default empty string when email missing.

---

## 5. Identify the Pattern

**Why empty string as default?**
- Misguided "safety": Thought empty string better than undefined
- Should reject invalid request at API boundary
- Downstream code assumes data already validated

---

## 6. Fix at Source

```typescript
// api-handler.ts (SOURCE FIX)
async createUser(req: Request): Promise<Response> {
  if (!req.body.email) {
    return Response.badRequest("Email is required");
  }
  const userRequest = {
    name: req.body.name,
    email: req.body.email, // No default, already validated
  };
  return this.userService.create(userRequest);
}
```

---

## 7. Add Defense in Depth

After fixing source, add validation at each layer as backup:

```typescript
// Layer 1: API - Reject invalid input (PRIMARY FIX)
if (!req.body.email) return Response.badRequest("Email required");

// Layer 2: Service - Validate assumptions
assert(request.email, "email must be present");

// Layer 3: Utility - Defensive check
if (!email) throw new Error("invariant violated: email empty");
```

**Primary fix at source. Defense is backup, not replacement.**
</the_process>

<debugging_approaches>
## Option 1: Guide User Through Debugger

**IMPORTANT:** Claude cannot run interactive debuggers. Guide user through debugger commands.

```
"Let's use lldb to trace backward through the call stack.

Please run these commands:
  lldb target/debug/myapp
  (lldb) breakpoint set --file validator.rs --line 42
  (lldb) run

When breakpoint hits:
  (lldb) frame variable email     # Check value here
  (lldb) bt                       # See full call stack
  (lldb) up                       # Move to caller
  (lldb) frame variable request   # Check values in caller
  (lldb) up                       # Move up again
  (lldb) frame variable           # Where empty string created?

Please share:
  1. Value of 'email' at validator.rs:42
  2. Value of 'request.email' in user_service.rs
  3. Value of 'req.body.email' in api_handler.rs
  4. Where does empty string first appear?"
```

---

## Option 2: Add Instrumentation (Claude CAN Do This)

When debugger not available or issue intermittent:

```rust
// Add at error location
fn validate_email(email: &str) -> Result<()> {
    eprintln!("DEBUG validate_email called:");
    eprintln!("  email: {:?}", email);
    eprintln!("  backtrace: {}", std::backtrace::Backtrace::capture());

    if email.is_empty() {
        return Err(Error::InvalidEmail);
    }
    // ...
}
```

**Critical:** Use `eprintln!()` or `console.error()` in tests (not logger - may be suppressed).

**Run and analyze:**

```bash
cargo test 2>&1 | grep "DEBUG validate_email" -A 10
```

Look for:
- Test file names in backtraces
- Line numbers triggering the call
- Patterns (same test? same parameter?)
</debugging_approaches>

<finding_polluting_tests>
## Finding Which Test Pollutes

When something appears during tests but you don't know which:

**Binary search approach:**

```bash
# Run half the tests
npm test tests/first-half/*.test.ts
# Pollution appears? Yes → in first half, No → second half

# Subdivide
npm test tests/first-quarter/*.test.ts

# Continue until specific file
npm test tests/auth/login.test.ts  ← Found it!
```

**Or test isolation:**

```bash
# Run tests one at a time
for test in tests/**/*.test.ts; do
  echo "Testing: $test"
  npm test "$test"
  if [ -d .git ]; then
    echo "FOUND POLLUTER: $test"
    break
  fi
done
```
</finding_polluting_tests>

<examples>
<example>
<scenario>Developer fixes symptom, not source</scenario>

<code>
# Error appears in git utility:
fn git_init(directory: &str) {
    Command::new("git")
        .arg("init")
        .current_dir(directory)
        .run()
}

# Error: "Invalid argument: empty directory"

# Developer adds validation at symptom:
fn git_init(directory: &str) {
    if directory.is_empty() {
        panic!("Directory cannot be empty"); // Band-aid
    }
    Command::new("git").arg("init").current_dir(directory).run()
}
</code>

<why_it_fails>
- Fixes symptom, not source (where empty string created)
- Same bug will appear elsewhere directory is used
- Doesn't explain WHY directory was empty
- Future code might make same mistake
- Band-aid hides the real problem
</why_it_fails>

<correction>
**Trace backward:**

1. git_init called with directory=""
2. WorkspaceManager.init(projectDir="")
3. Session.create(projectDir="")
4. Test: Project.create(context.tempDir)
5. **SOURCE:** context.tempDir="" (accessed before beforeEach!)

**Fix at source:**

```typescript
function setupTest() {
  let _tempDir: string | undefined;

  return {
    beforeEach() {
      _tempDir = makeTempDir();
    },
    get tempDir(): string {
      if (!_tempDir) {
        throw new Error("tempDir accessed before beforeEach!");
      }
      return _tempDir;
    }
  };
}
```

**What you gain:**
- Fixes actual bug (test timing issue)
- Prevents same mistake elsewhere
- Clear error at source, not deep in stack
- No empty strings propagating through system
</correction>
</example>

<example>
<scenario>Developer stops tracing too early</scenario>

<code>
# Error in API handler
async createUser(req: Request): Promise<Response> {
  const userRequest = {
    name: req.body.name,
    email: req.body.email || "", // Suspicious!
  };
  return this.userService.create(userRequest);
}

# Developer sees empty string default and "fixes" it:
email: req.body.email || "noreply@example.com"

# Ships to production
# Bug: Users created without email input get noreply@example.com
# Database has fake emails, can't distinguish missing from real
</code>

<why_it_fails>
- Stopped at first suspicious code
- Didn't question WHY empty string was default
- "Fixed" by replacing with different wrong default
- Root cause: shouldn't accept missing email at all
- Validation should happen at API boundary
</why_it_fails>

<correction>
**Keep tracing to understand intent:**

1. Why was empty string default?
2. Should email be optional or required?
3. What does API spec say?
4. What does database schema say?

**Findings:**
- Email column is NOT NULL in database
- API docs say email is required
- Empty string was workaround, not design

**Fix at source (validate at boundary):**

```typescript
async createUser(req: Request): Promise<Response> {
  // Validate at API boundary
  if (!req.body.email) {
    return Response.badRequest("Email is required");
  }

  const userRequest = {
    name: req.body.name,
    email: req.body.email, // No default needed
  };
  return this.userService.create(userRequest);
}
```

**What you gain:**
- Validates at correct layer (API boundary)
- Clear error message to client
- No invalid data propagates downstream
- Database constraints enforced
- Matches API specification
</correction>
</example>

<example>
<scenario>Complex multi-layer trace to find original trigger</scenario>

<code>
# Problem: .git directory appearing in source code directory during tests

# Symptom location:
Error: Cannot initialize git repo (repo already exists)
Location: src/workspace/git.rs:45

# Developer adds check:
if Path::new(".git").exists() {
    return Err("Git already initialized");
}

# Doesn't help - still appears in wrong place!
</code>

<why_it_fails>
- Detects symptom, doesn't prevent it
- .git still created in wrong directory
- Doesn't explain HOW it gets there
- Pollution still happens, just detected
</why_it_fails>

<correction>
**Trace through multiple layers:**

```
1. git init runs with cwd=""
   ↓ Why is cwd empty?

2. WorkspaceManager.init(projectDir="")
   ↓ Why is projectDir empty?

3. Session.create(projectDir="")
   ↓ Why was empty string passed?

4. Test: Project.create(context.tempDir)
   ↓ Why is context.tempDir empty?

5. ROOT CAUSE:
   const context = setupTest(); // tempDir="" initially
   Project.create(context.tempDir); // Accessed at top level!

   beforeEach(() => {
     context.tempDir = makeTempDir(); // Assigned here
   });

   TEST ACCESSED TEMPDIR BEFORE BEFOREEACH RAN!
```

**Fix at source (make early access impossible):**

```typescript
function setupTest() {
  let _tempDir: string | undefined;

  return {
    beforeEach() {
      _tempDir = makeTempDir();
    },
    get tempDir(): string {
      if (!_tempDir) {
        throw new Error("tempDir accessed before beforeEach!");
      }
      return _tempDir;
    }
  };
}
```

**Then add defense at each layer:**

```rust
// Layer 1: Test framework (PRIMARY FIX)
// Getter throws if accessed early

// Layer 2: Project validation
fn create(directory: &str) -> Result<Self> {
    if directory.is_empty() {
        return Err("Directory cannot be empty");
    }
    // ...
}

// Layer 3: Workspace validation
fn init(path: &Path) -> Result<()> {
    if !path.exists() {
        return Err("Path must exist");
    }
    // ...
}

// Layer 4: Environment guard
fn git_init(dir: &Path) -> Result<()> {
    if env::var("NODE_ENV") != Ok("test".to_string()) {
        if !dir.starts_with("/tmp") {
            panic!("Refusing to git init outside test dir");
        }
    }
    // ...
}
```

**What you gain:**
- Primary fix prevents early access (source)
- Each layer validates assumptions (defense)
- Clear error at source, not deep in stack
- Environment guard prevents production pollution
- Multi-layer defense catches future mistakes
</correction>
</example>
</examples>

<critical_rules>
## Rules That Have No Exceptions

1. **Never fix just where error appears** → Trace backward to find source
2. **Don't stop at first suspicious code** → Keep tracing to original trigger
3. **Fix at source first** → Defense is backup, not primary fix
4. **Use debugger OR instrumentation** → Don't guess at call chain
5. **Add defense at each layer** → After fixing source, validate assumptions throughout

## Common Excuses

All of these mean: **STOP. Trace backward to find source.**

- "Error is obvious here, I'll add validation" (That's a symptom fix)
- "Stack trace shows the problem" (Shows symptom location, not source)
- "This code should handle empty values" (Why is value empty? Find source.)
- "Too deep to trace, I'll add defensive check" (Defense without source fix = band-aid)
- "Multiple places could cause this" (Trace to find which one actually does)
</critical_rules>

<verification_checklist>
Before claiming root cause fixed:

- [ ] Traced backward through entire call chain
- [ ] Found where invalid data was created (not just passed)
- [ ] Identified WHY invalid data was created (pattern/assumption)
- [ ] Fixed at source (where bad data originates)
- [ ] Added defense at each layer (validate assumptions)
- [ ] Verified fix with test (reproduces original bug, passes with fix)
- [ ] Confirmed no other code paths have same pattern

**Can't check all boxes?** Keep tracing backward.
</verification_checklist>

<integration>
**This skill is called by:**
- /skill:debugging-with-tools (Phase 2: Trace Backward Through Call Stack)
- When errors occur deep in execution
- When unclear where invalid data originated

**This skill requires:**
- Stack traces or debugger access
- Ability to add instrumentation (logging)
- Understanding of call chain

**This skill calls:**
- /skill:test-driven-development (write regression test after finding source)
- /skill:verification-before-completion (verify fix works)
</integration>

<resources>
**Detailed guides:**
- [Debugger commands by language](resources/debugger-reference.md)
- [Instrumentation patterns](resources/instrumentation-patterns.md)
- [Defense-in-depth examples](resources/defense-patterns.md)

**When stuck:**
- Can't find source → Add instrumentation at each layer, run test
- Stack trace unclear → Use debugger to inspect variables at each frame
- Multiple suspects → Add instrumentation to all, find which actually executes
- Intermittent issue → Add instrumentation and wait for reproduction
</resources>