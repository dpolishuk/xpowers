# Testing Hooks

Comprehensive testing strategies for Claude Code hooks.

## Testing Philosophy

**Hooks run with full system access. Test them thoroughly before deploying.**

### Testing Levels

1. **Unit testing** - Test functions in isolation
2. **Integration testing** - Test with mock Claude Code events
3. **Manual testing** - Test in real Claude Code sessions
4. **Regression testing** - Verify hooks don't break existing workflows

## Unit Testing Hook Functions

### Bash Functions

**Example: Testing file validation**

```bash
# hook-functions.sh - extractable functions
validate_file_path() {
    local path="$1"

    if [ -z "$path" ] || [ "$path" == "null" ]; then
        return 1
    fi

    if [[ ! "$path" =~ ^/ ]]; then
        return 1
    fi

    if [ ! -f "$path" ]; then
        return 1
    fi

    return 0
}

# Test script
#!/bin/bash
source ./hook-functions.sh

test_validate_file_path() {
    # Test valid path
    touch /tmp/test-file.txt
    if validate_file_path "/tmp/test-file.txt"; then
        echo "✅ Valid path test passed"
    else
        echo "❌ Valid path test failed"
        return 1
    fi

    # Test invalid path
    if ! validate_file_path ""; then
        echo "✅ Empty path test passed"
    else
        echo "❌ Empty path test failed"
        return 1
    fi

    # Test null path
    if ! validate_file_path "null"; then
        echo "✅ Null path test passed"
    else
        echo "❌ Null path test failed"
        return 1
    fi

    # Test relative path
    if ! validate_file_path "relative/path.txt"; then
        echo "✅ Relative path test passed"
    else
        echo "❌ Relative path test failed"
        return 1
    fi

    rm /tmp/test-file.txt
    return 0
}

# Run test
test_validate_file_path
```

### JavaScript Functions

**Example: Testing prompt analysis**

```javascript
// skill-activator.js
function analyzePrompt(text, rules) {
    const lowerText = text.toLowerCase();
    const activated = [];

    for (const [skillName, config] of Object.entries(rules)) {
        if (config.promptTriggers?.keywords) {
            for (const keyword of config.promptTriggers.keywords) {
                if (lowerText.includes(keyword.toLowerCase())) {
                    activated.push({ skill: skillName, priority: config.priority || 'medium' });
                    break;
                }
            }
        }
    }

    return activated;
}

// test.js
const assert = require('assert');

const testRules = {
    'backend-dev': {
        priority: 'high',
        promptTriggers: {
            keywords: ['backend', 'API', 'endpoint']
        }
    }
};

// Test keyword matching
function testKeywordMatching() {
    const result = analyzePrompt('How do I create a backend endpoint?', testRules);
    assert.equal(result.length, 1, 'Should find one skill');
    assert.equal(result[0].skill, 'backend-dev', 'Should match backend-dev');
    assert.equal(result[0].priority, 'high', 'Should have high priority');
    console.log('✅ Keyword matching test passed');
}

// Test no match
function testNoMatch() {
    const result = analyzePrompt('How do I write Python?', testRules);
    assert.equal(result.length, 0, 'Should find no skills');
    console.log('✅ No match test passed');
}

// Test case insensitivity
function testCaseInsensitive() {
    const result = analyzePrompt('BACKEND endpoint', testRules);
    assert.equal(result.length, 1, 'Should match regardless of case');
    console.log('✅ Case insensitive test passed');
}

// Run tests
testKeywordMatching();
testNoMatch();
testCaseInsensitive();
```

## Integration Testing with Mock Events

### Creating Mock Events

**PostToolUse event:**
```json
{
  "event": "PostToolUse",
  "tool": {
    "name": "Edit",
    "input": {
      "file_path": "/Users/test/project/src/file.ts",
      "old_string": "const x = 1;",
      "new_string": "const x = 2;"
    }
  },
  "result": {
    "success": true
  }
}
```

**UserPromptSubmit event:**
```json
{
  "event": "UserPromptSubmit",
  "text": "How do I create a new API endpoint?",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

**Stop event:**
```json
{
  "event": "Stop",
  "sessionId": "abc123",
  "messageCount": 10
}
```

### Testing Hook with Mock Events

```bash
#!/bin/bash
# test-hook.sh

# Create mock event
create_mock_edit_event() {
    cat <<EOF
{
  "event": "PostToolUse",
  "tool": {
    "name": "Edit",
    "input": {
      "file_path": "/tmp/test-file.ts"
    }
  }
}
EOF
}

# Test hook
test_edit_tracker() {
    # Setup
    export LOG_FILE="/tmp/test-edit-log.txt"
    rm -f "$LOG_FILE"

    # Run hook with mock event
    create_mock_edit_event | bash hooks/post-tool-use/01-track-edits.sh

    # Verify
    if [ -f "$LOG_FILE" ]; then
        if grep -q "test-file.ts" "$LOG_FILE"; then
            echo "✅ Edit tracker test passed"
            return 0
        fi
    fi

    echo "❌ Edit tracker test failed"
    return 1
}

test_edit_tracker
```

### Testing JavaScript Hooks

```javascript
// test-skill-activator.js
const { execSync } = require('child_process');

function testSkillActivator(prompt) {
    const mockEvent = JSON.stringify({
        text: prompt
    });

    const result = execSync(
        'node hooks/user-prompt-submit/skill-activator.js',
        {
            input: mockEvent,
            encoding: 'utf8',
            env: {
                ...process.env,
                SKILL_RULES: './test-skill-rules.json'
            }
        }
    );

    return JSON.parse(result);
}

// Test activation
function testBackendActivation() {
    const result = testSkillActivator('How do I create a backend endpoint?');

    if (result.additionalContext && result.additionalContext.includes('backend')) {
        console.log('✅ Backend activation test passed');
    } else {
        console.log('❌ Backend activation test failed');
        process.exit(1);
    }
}

testBackendActivation();
```

## Manual Testing in Claude Code

### Testing Checklist

**Before deployment:**
- [ ] Hook executes without errors
- [ ] Hook completes within timeout (default 10s)
- [ ] Output is helpful and not overwhelming
- [ ] Non-blocking hooks don't prevent work
- [ ] Blocking hooks have clear error messages
- [ ] Hook handles missing files gracefully
- [ ] Hook handles malformed input gracefully

### Manual Test Procedure

**1. Enable debug mode:**
```bash
# Add to top of hook
set -x
exec 2>>~/.claude/hooks/debug-$(date +%Y%m%d).log
```

**2. Test with minimal prompt:**
```
Create a simple test file
```

**3. Observe hook execution:**
```bash
# Watch debug log
tail -f ~/.claude/hooks/debug-*.log
```

**4. Verify output:**
- Check that hook completes
- Verify no errors in debug log
- Confirm expected behavior

**5. Test edge cases:**
- Empty file paths
- Non-existent files
- Files outside project
- Malformed input
- Missing dependencies

**6. Test performance:**
```bash
# Time hook execution
time bash hooks/stop/build-checker.sh
```

## Regression Testing

### Creating Test Suite

```bash
#!/bin/bash
# regression-test.sh

TEST_DIR="/tmp/hook-tests"
mkdir -p "$TEST_DIR"

# Setup test environment
setup() {
    export LOG_FILE="$TEST_DIR/edit-log.txt"
    export PROJECT_ROOT="$TEST_DIR/projects"
    mkdir -p "$PROJECT_ROOT"
}

# Cleanup after tests
teardown() {
    rm -rf "$TEST_DIR"
}

# Test 1: Edit tracker logs edits
test_edit_tracker_logs() {
    echo '{"tool": {"name": "Edit", "input": {"file_path": "/test/file.ts"}}}' | \
        bash hooks/post-tool-use/01-track-edits.sh

    if grep -q "file.ts" "$LOG_FILE"; then
        echo "✅ Test 1 passed"
        return 0
    fi

    echo "❌ Test 1 failed"
    return 1
}

# Test 2: Build checker finds errors
test_build_checker_finds_errors() {
    # Create mock project with errors
    mkdir -p "$PROJECT_ROOT/test-project"
    echo 'const x: string = 123;' > "$PROJECT_ROOT/test-project/error.ts"

    # Add to log
    echo "2025-01-15 10:00:00 | test-project | error.ts" > "$LOG_FILE"

    # Run build checker (should find errors)
    output=$(bash hooks/stop/20-build-checker.sh)

    if echo "$output" | grep -q "error"; then
        echo "✅ Test 2 passed"
        return 0
    fi

    echo "❌ Test 2 failed"
    return 1
}

# Test 3: Formatter handles missing prettier
test_formatter_missing_prettier() {
    # Create file without prettier config
    mkdir -p "$PROJECT_ROOT/no-prettier"
    echo 'const x=1' > "$PROJECT_ROOT/no-prettier/file.js"
    echo "2025-01-15 10:00:00 | no-prettier | file.js" > "$LOG_FILE"

    # Should complete without error
    if bash hooks/stop/30-format-code.sh 2>&1; then
        echo "✅ Test 3 passed"
        return 0
    fi

    echo "❌ Test 3 failed"
    return 1
}

# Run all tests
run_all_tests() {
    setup

    local failed=0

    test_edit_tracker_logs || ((failed++))
    test_build_checker_finds_errors || ((failed++))
    test_formatter_missing_prettier || ((failed++))

    teardown

    if [ $failed -eq 0 ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "✅ All tests passed!"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━"
        return 0
    else
        echo "━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "❌ $failed test(s) failed"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━"
        return 1
    fi
}

run_all_tests
```

### Running Regression Suite

```bash
# Run before deploying changes
bash test/regression-test.sh

# Run on schedule (cron)
0 0 * * * cd ~/hooks && bash test/regression-test.sh
```

## Performance Testing

### Measuring Hook Performance

```bash
#!/bin/bash
# benchmark-hook.sh

ITERATIONS=10
HOOK_PATH="hooks/stop/build-checker.sh"

total_time=0

for i in $(seq 1 $ITERATIONS); do
    start=$(date +%s%N)
    bash "$HOOK_PATH" > /dev/null 2>&1
    end=$(date +%s%N)

    elapsed=$(( (end - start) / 1000000 ))  # Convert to ms
    total_time=$(( total_time + elapsed ))

    echo "Iteration $i: ${elapsed}ms"
done

average=$(( total_time / ITERATIONS ))

echo "━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Average: ${average}ms"
echo "Total: ${total_time}ms"
echo "━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $average -gt 2000 ]; then
    echo "⚠️  Hook is slow (>2s)"
    exit 1
fi

echo "✅ Performance acceptable"
```

### Performance Targets

- **Non-blocking hooks:** <2 seconds
- **Blocking hooks:** <5 seconds
- **UserPromptSubmit:** <1 second (critical path)
- **PostToolUse:** <500ms (runs frequently)

## Continuous Testing

### Pre-commit Hook for Hook Testing

```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "Testing Claude Code hooks..."

# Run test suite
if bash test/regression-test.sh; then
    echo "✅ Hook tests passed"
    exit 0
else
    echo "❌ Hook tests failed"
    echo "Fix tests before committing"
    exit 1
fi
```

### CI/CD Integration

```yaml
# .github/workflows/test-hooks.yml
name: Test Claude Code Hooks

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Run hook tests
        run: bash test/regression-test.sh

      - name: Run performance tests
        run: bash test/benchmark-hook.sh
```

## Common Testing Mistakes

### Mistake 1: Not Testing Error Paths

❌ **Wrong:**
```bash
# Only test success path
npx tsc --noEmit
echo "✅ Build passed"
```

✅ **Right:**
```bash
# Test both success and failure
if npx tsc --noEmit 2>&1; then
    echo "✅ Build passed"
else
    echo "❌ Build failed"
    # Test that error handling works
fi
```

### Mistake 2: Hardcoding Paths

❌ **Wrong:**
```bash
# Hardcoded path
cd /Users/myname/projects/myproject
npm run build
```

✅ **Right:**
```bash
# Dynamic path
project_root=$(find_project_root "$file_path")
if [ -n "$project_root" ]; then
    cd "$project_root"
    npm run build
fi
```

### Mistake 3: Not Cleaning Up

❌ **Wrong:**
```bash
# Leaves test files behind
echo "test" > /tmp/test-file.txt
run_test
# Never cleans up
```

✅ **Right:**
```bash
# Always cleanup
trap 'rm -f /tmp/test-file.txt' EXIT
echo "test" > /tmp/test-file.txt
run_test
```

### Mistake 4: Silent Failures

❌ **Wrong:**
```bash
# Errors disappear
npx tsc --noEmit 2>/dev/null
```

✅ **Right:**
```bash
# Capture errors
output=$(npx tsc --noEmit 2>&1)
if [ $? -ne 0 ]; then
    echo "❌ TypeScript errors:"
    echo "$output"
fi
```

## Debugging Failed Tests

### Enable Verbose Output

```bash
# Add debug flags
set -x          # Print commands
set -e          # Exit on error
set -u          # Error on undefined variables
set -o pipefail # Catch pipe failures
```

### Capture Test Output

```bash
# Run test with full output
bash -x test/regression-test.sh 2>&1 | tee test-output.log

# Review output
less test-output.log
```

### Isolate Failing Test

```bash
# Run single test
source test/regression-test.sh
setup
test_build_checker_finds_errors
teardown
```

## Remember

- **Test before deploying** - Hooks have full system access
- **Test all paths** - Success, failure, edge cases
- **Test performance** - Hooks shouldn't slow workflow
- **Automate testing** - Run tests on every change
- **Clean up** - Don't leave test artifacts
- **Document tests** - Future you will thank present you

**Golden rule:** If you wouldn't run it on production, don't deploy it as a hook.
