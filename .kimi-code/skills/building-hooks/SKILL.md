---
name: building-hooks
description: Use when creating Claude Code hooks - covers hook patterns, composition, testing, progressive enhancement from simple to advanced
---

<skill_overview>
Hooks encode business rules at application level; start with observation, add automation, enforce only when patterns clear.
</skill_overview>

<rigidity_level>
MEDIUM FREEDOM - Follow progressive enhancement (observe → automate → enforce) strictly. Hook patterns are adaptable, but always start non-blocking and test thoroughly.
</rigidity_level>

<quick_reference>
| Phase | Approach | Example |
|-------|----------|---------|
| 1. Observe | Non-blocking, report only | Log edits, display reminders |
| 2. Automate | Background tasks, non-blocking | Auto-format, run builds |
| 3. Enforce | Blocking only when necessary | Block dangerous ops, require fixes |

**Most used events:** UserPromptSubmit (before processing), Stop (after completion)

**Critical:** Start Phase 1, observe for a week, then Phase 2. Only add Phase 3 if absolutely necessary.
</quick_reference>

<when_to_use>
Use hooks for:
- Automatic quality checks (build, lint, format)
- Workflow automation (skill activation, context injection)
- Error prevention (catching issues early)
- Consistent behavior (formatting, conventions)

**Never use hooks for:**
- Complex business logic (use tools/scripts)
- Slow operations that block workflow (use background jobs)
- Anything requiring LLM reasoning (hooks are deterministic)
</when_to_use>

<hook_lifecycle_events>
| Event | When Fires | Use Cases |
|-------|------------|-----------|
| UserPromptSubmit | Before Claude processes prompt | Validation, context injection, skill activation |
| Stop | After Claude finishes | Build checks, formatting, quality reminders |
| PostToolUse | After each tool execution | Logging, tracking, validation |
| PreToolUse | Before tool execution | Permission checks, validation |
| ToolError | When tool fails | Error handling, fallbacks |
| SessionStart | New session begins | Environment setup, context loading |
| SessionEnd | Session closes | Cleanup, logging |
| Error | Unhandled error | Error recovery, notifications |
</hook_lifecycle_events>

<progressive_enhancement>
## Phase 1: Observation (Non-Blocking)

**Goal:** Understand patterns before acting

**Examples:**
- Log file edits (PostToolUse)
- Display reminders (Stop, non-blocking)
- Track metrics

**Duration:** Observe for 1 week minimum

---

## Phase 2: Automation (Background)

**Goal:** Automate tedious tasks

**Examples:**
- Auto-format edited files (Stop)
- Run builds after changes (Stop)
- Inject helpful context (UserPromptSubmit)

**Requirement:** Fast (<2 seconds), non-blocking

---

## Phase 3: Enforcement (Blocking)

**Goal:** Prevent errors, enforce standards

**Examples:**
- Block dangerous operations (PreToolUse)
- Require fixes before continuing (Stop, blocking)
- Validate inputs (UserPromptSubmit, blocking)

**Requirement:** Only add when patterns clear from Phase 1-2
</progressive_enhancement>

<common_hook_patterns>
## Pattern 1: Build Checker (Stop Hook)

**Problem:** TypeScript errors left behind

**Solution:**
```bash
#!/bin/bash
# Stop hook - runs after Claude finishes

# Check modified repos
modified_repos=$(grep -h "edited" ~/.claude/edit-log.txt | cut -d: -f1 | sort -u)

for repo in $modified_repos; do
  echo "Building $repo..."
  cd "$repo" && npm run build 2>&1 | tee /tmp/build-output.txt

  error_count=$(grep -c "error TS" /tmp/build-output.txt || echo "0")

  if [ "$error_count" -gt 0 ]; then
    if [ "$error_count" -ge 5 ]; then
      echo "⚠️  Found $error_count errors - consider error-resolver agent"
    else
      echo "🔴 Found $error_count TypeScript errors:"
      grep "error TS" /tmp/build-output.txt
    fi
  else
    echo "✅ Build passed"
  fi
done
```

**Configuration:**
```json
{
  "event": "Stop",
  "command": "~/.claude/hooks/build-checker.sh",
  "description": "Run builds on modified repos",
  "blocking": false
}
```

**Result:** Zero errors left behind

---

## Pattern 2: Auto-Formatter (Stop Hook)

**Problem:** Inconsistent formatting

**Solution:**
```bash
#!/bin/bash
# Stop hook - format all edited files

edited_files=$(tail -20 ~/.claude/edit-log.txt | grep "^/" | sort -u)

for file in $edited_files; do
  repo_dir=$(dirname "$file")
  while [ "$repo_dir" != "/" ]; do
    if [ -f "$repo_dir/.prettierrc" ]; then
      echo "Formatting $file..."
      cd "$repo_dir" && npx prettier --write "$file"
      break
    fi
    repo_dir=$(dirname "$repo_dir")
  done
done

echo "✅ Formatting complete"
```

**Result:** All code consistently formatted

---

## Pattern 3: Error Handling Reminder (Stop Hook)

**Problem:** Claude forgets error handling

**Solution:**
```bash
#!/bin/bash
# Stop hook - gentle reminder

edited_files=$(tail -20 ~/.claude/edit-log.txt | grep "^/")

risky_patterns=0
for file in $edited_files; do
  if grep -q "try\|catch\|async\|await\|prisma\|router\." "$file"; then
    ((risky_patterns++))
  fi
done

if [ "$risky_patterns" -gt 0 ]; then
  cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 ERROR HANDLING SELF-CHECK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  Risky Patterns Detected
   $risky_patterns file(s) with async/try-catch/database operations

   ❓ Did you add proper error handling?
   ❓ Are errors logged appropriately?

   💡 Consider: Sentry.captureException(), proper logging
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
fi
```

**Result:** Claude self-checks without blocking

---

## Pattern 4: Skills Auto-Activation

**See:** /skill:skills-auto-activation for complete implementation

**Summary:** Analyzes prompt keywords, injects skill activation reminder before Claude processes.
</common_hook_patterns>

<hook_composition>
## Naming for Order Control

Multiple hooks for same event run in **alphabetical order** by filename.

**Use numeric prefixes:**

```
hooks/
├── 00-log-prompt.sh       # First (logging)
├── 10-inject-context.sh   # Second (context)
├── 20-activate-skills.sh  # Third (skills)
└── 99-notify.sh           # Last (notifications)
```

## Hook Dependencies

If Hook B depends on Hook A's output:

1. **Option 1:** Numeric prefixes (A before B)
2. **Option 2:** Combine into single hook
3. **Option 3:** File-based communication

**Example:**
```bash
# 10-track-edits.sh writes to edit-log.txt
# 20-check-builds.sh reads from edit-log.txt
```
</hook_composition>

<testing_hooks>
## Test in Isolation

```bash
# Manually trigger
bash ~/.claude/hooks/build-checker.sh

# Check exit code
echo $?  # 0 = success
```

## Test with Mock Data

```bash
# Create mock log
echo "/path/to/test/file.ts" > /tmp/test-edit-log.txt

# Run with test data
EDIT_LOG=/tmp/test-edit-log.txt bash ~/.claude/hooks/build-checker.sh
```

## Test Non-Blocking Behavior

- Hook exits quickly (<2 seconds)
- Doesn't block Claude
- Provides clear output

## Test Blocking Behavior

- Blocking decision correct
- Reason message helpful
- Escape hatch exists

## Debugging

**Enable logging:**
```bash
set -x  # Debug output
exec 2>~/.claude/hooks/debug.log
```

**Check execution:**
```bash
tail -f ~/.claude/logs/hooks.log
```

**Common issues:**
- Timeout (>10 second default)
- Wrong working directory
- Missing environment variables
- File permissions
</testing_hooks>

<examples>
<example>
<scenario>Developer adds blocking hook immediately without observation</scenario>

<code>
# Developer frustrated by TypeScript errors
# Creates blocking Stop hook immediately:

#!/bin/bash
npm run build

if [ $? -ne 0 ]; then
  echo "BUILD FAILED - BLOCKING"
  exit 1  # Blocks Claude
fi
</code>

<why_it_fails>
- No observation period to understand patterns
- Blocks even for minor errors
- No escape hatch if hook misbehaves
- Might block during experimentation
- Frustrates workflow when building is slow
- Haven't identified when blocking is actually needed
</why_it_fails>

<correction>
**Phase 1: Observe (1 week)**

```bash
#!/bin/bash
# Non-blocking observation
npm run build 2>&1 | tee /tmp/build.log

if grep -q "error TS" /tmp/build.log; then
  echo "🔴 Build errors found (not blocking)"
fi
```

**After 1 week, review:**
- How often do errors appear?
- Are they usually fixed quickly?
- Do they cause real problems or just noise?

**Phase 2: If errors are frequent, automate**

```bash
#!/bin/bash
# Still non-blocking, but more helpful
npm run build 2>&1 | tee /tmp/build.log

error_count=$(grep -c "error TS" /tmp/build.log || echo "0")

if [ "$error_count" -ge 5 ]; then
  echo "⚠️  $error_count errors - consider using error-resolver agent"
elif [ "$error_count" -gt 0 ]; then
  echo "🔴 $error_count errors (not blocking):"
  grep "error TS" /tmp/build.log | head -5
fi
```

**Phase 3: Only if observation shows blocking is necessary**

Never reached - non-blocking works fine!

**What you gain:**
- Understood patterns before acting
- Non-blocking keeps workflow smooth
- Helpful messages without friction
- Can experiment without frustration
</correction>
</example>

<example>
<scenario>Hook is slow, blocks workflow</scenario>

<code>
#!/bin/bash
# Stop hook that's too slow

# Run full test suite (takes 45 seconds!)
npm test

# Run linter (takes 10 seconds)
npm run lint

# Run build (takes 30 seconds)
npm run build

# Total: 85 seconds of blocking!
</code>

<why_it_fails>
- Hook takes 85 seconds to complete
- Blocks Claude for entire duration
- User can't continue working
- Frustrating, likely to be disabled
- Defeats purpose of automation
</why_it_fails>

<correction>
**Make hook fast (<2 seconds):**

```bash
#!/bin/bash
# Stop hook - fast checks only

# Quick syntax check (< 1 second)
npm run check-syntax

if [ $? -ne 0 ]; then
  echo "🔴 Syntax errors found"
  echo "💡 Run 'npm test' manually for full test suite"
fi

echo "✅ Quick checks passed (run 'npm test' for full suite)"
```

**Or run slow checks in background:**

```bash
#!/bin/bash
# Stop hook - trigger background job

# Start tests in background
(
  npm test > /tmp/test-results.txt 2>&1
  if [ $? -ne 0 ]; then
    echo "🔴 Tests failed (see /tmp/test-results.txt)"
  fi
) &

echo "⏳ Tests running in background (check /tmp/test-results.txt)"
```

**What you gain:**
- Hook completes instantly
- Workflow not blocked
- Still get quality checks
- User can continue working
</correction>
</example>

<example>
<scenario>Hook has no error handling, fails silently</scenario>

<code>
#!/bin/bash
# Hook with no error handling

file=$(tail -1 ~/.claude/edit-log.txt)
prettier --write "$file"
</code>

<why_it_fails>
- If edit-log.txt missing → hook fails silently
- If file path invalid → prettier errors not caught
- If prettier not installed → silent failure
- No logging, can't debug
- User has no idea hook ran or failed
</why_it_fails>

<correction>
**Add error handling:**

```bash
#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars

# Log execution
echo "[$(date)] Hook started" >> ~/.claude/hooks/formatter.log

# Validate input
if [ ! -f ~/.claude/edit-log.txt ]; then
  echo "[$(date)] ERROR: edit-log.txt not found" >> ~/.claude/hooks/formatter.log
  exit 1
fi

file=$(tail -1 ~/.claude/edit-log.txt | grep "^/.*\.ts$")

if [ -z "$file" ]; then
  echo "[$(date)] No TypeScript file to format" >> ~/.claude/hooks/formatter.log
  exit 0
fi

if [ ! -f "$file" ]; then
  echo "[$(date)] ERROR: File not found: $file" >> ~/.claude/hooks/formatter.log
  exit 1
fi

# Check prettier exists
if ! command -v prettier &> /dev/null; then
  echo "[$(date)] ERROR: prettier not installed" >> ~/.claude/hooks/formatter.log
  exit 1
fi

# Format
echo "[$(date)] Formatting: $file" >> ~/.claude/hooks/formatter.log
if prettier --write "$file" 2>&1 | tee -a ~/.claude/hooks/formatter.log; then
  echo "✅ Formatted $file"
else
  echo "🔴 Formatting failed (see ~/.claude/hooks/formatter.log)"
fi
```

**What you gain:**
- Errors logged and visible
- Graceful handling of missing files
- Can debug when issues occur
- Clear feedback to user
- Hook doesn't fail silently
</correction>
</example>
</examples>

<security>
**Hooks run with your credentials and have full system access.**

## Best Practices

1. **Review code carefully** - Hooks execute any command
2. **Use absolute paths** - Don't rely on PATH
3. **Validate inputs** - Don't trust file paths blindly
4. **Limit scope** - Only access what's needed
5. **Log actions** - Track what hooks do
6. **Test thoroughly** - Especially blocking hooks

## Dangerous Patterns

❌ **Don't:**
```bash
# DANGEROUS - executes arbitrary code
cmd=$(tail -1 ~/.claude/edit-log.txt)
eval "$cmd"
```

✅ **Do:**
```bash
# SAFE - validates and sanitizes
file=$(tail -1 ~/.claude/edit-log.txt | grep "^/.*\.ts$")
if [ -f "$file" ]; then
  prettier --write "$file"
fi
```
</security>

<critical_rules>
## Rules That Have No Exceptions

1. **Start with Phase 1 (observe)** → Understand patterns before acting
2. **Keep hooks fast (<2 seconds)** → Don't block workflow
3. **Test thoroughly** → Hooks have full system access
4. **Add error handling and logging** → Silent failures are debugging nightmares
5. **Use progressive enhancement** → Observe → Automate → Enforce (only if needed)

## Common Excuses

All of these mean: **STOP. Follow progressive enhancement.**

- "Hook is simple, don't need testing" (Untested hooks fail in production)
- "Blocking is fine, need to enforce" (Start non-blocking, observe first)
- "I'll add error handling later" (Hook errors silent, add now)
- "Hook is slow but thorough" (Slow hooks block workflow, optimize)
- "Need access to everything" (Minimal permissions only)
</critical_rules>

<verification_checklist>
Before deploying hook:

- [ ] Tested in isolation (manual execution)
- [ ] Tested with mock data
- [ ] Completes quickly (<2 seconds for non-blocking)
- [ ] Has error handling (set -euo pipefail)
- [ ] Has logging (can debug failures)
- [ ] Validates inputs (doesn't trust blindly)
- [ ] Uses absolute paths
- [ ] Started with Phase 1 (observation)
- [ ] If blocking: has escape hatch

**Can't check all boxes?** Return to development and fix.
</verification_checklist>

<integration>
**This skill covers:** Hook creation and patterns

**Related skills:**
- /skill:skills-auto-activation (complete skill activation hook)
- /skill:verification-before-completion (quality hooks automate this)
- /skill:testing-anti-patterns (avoid in hooks)

**Hook patterns support:**
- Automatic skill activation
- Build verification
- Code formatting
- Error prevention
- Workflow automation
</integration>

<resources>
**Detailed guides:**
- [Complete hook examples](resources/hook-examples.md)
- [Hook pattern library](resources/hook-patterns.md)
- [Testing strategies](resources/testing-hooks.md)

**Official documentation:**
- [Anthropic Hooks Guide](https://docs.claude.com/en/docs/claude-code/hooks-guide)

**When stuck:**
- Hook failing silently → Add logging, check ~/.claude/hooks/debug.log
- Hook too slow → Profile execution, move slow parts to background
- Hook blocking incorrectly → Return to Phase 1, observe patterns
- Testing unclear → Start with manual execution, then mock data
</resources>
