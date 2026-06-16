# Hook Patterns Library

Reusable patterns for common hook use cases.

## Pattern: File Path Validation

Safely validate and sanitize file paths in hooks.

```bash
validate_file_path() {
    local path="$1"

    # Remove null/empty
    if [ -z "$path" ] || [ "$path" == "null" ]; then
        return 1
    fi

    # Must be absolute path
    if [[ ! "$path" =~ ^/ ]]; then
        return 1
    fi

    # Must exist
    if [ ! -f "$path" ]; then
        return 1
    fi

    # Check file extension whitelist
    if [[ ! "$path" =~ \.(ts|tsx|js|jsx|py|rs|go|java)$ ]]; then
        return 1
    fi

    return 0
}

# Usage
if validate_file_path "$file_path"; then
    # Safe to operate on file
    process_file "$file_path"
fi
```

## Pattern: Finding Project Root

Locate the project root directory from any file path.

```bash
find_project_root() {
    local dir="$1"

    # Start from file's directory
    if [ -f "$dir" ]; then
        dir=$(dirname "$dir")
    fi

    # Walk up until finding markers
    while [ "$dir" != "/" ]; do
        # Check for project markers
        if [ -f "$dir/package.json" ] || \
           [ -f "$dir/Cargo.toml" ] || \
           [ -f "$dir/go.mod" ] || \
           [ -d "$dir/.git" ]; then
            echo "$dir"
            return 0
        fi
        dir=$(dirname "$dir")
    done

    return 1
}

# Usage
project_root=$(find_project_root "$file_path")
if [ -n "$project_root" ]; then
    cd "$project_root"
    npm run build
fi
```

## Pattern: Conditional Hook Execution

Run hook only when certain conditions are met.

```bash
#!/bin/bash

# Configuration
MIN_CHANGES=3
TARGET_REPO="backend"

# Check if should run
should_run() {
    # Count recent edits
    local edit_count=$(tail -20 ~/.claude/edit-log.txt | wc -l)

    if [ "$edit_count" -lt "$MIN_CHANGES" ]; then
        return 1
    fi

    # Check if target repo was modified
    if ! tail -20 ~/.claude/edit-log.txt | grep -q "$TARGET_REPO"; then
        return 1
    fi

    return 0
}

# Main execution
if ! should_run; then
    echo '{}'
    exit 0
fi

# Run actual hook logic
perform_build_check
```

## Pattern: Rate Limiting

Prevent hooks from running too frequently.

```bash
#!/bin/bash

RATE_LIMIT_FILE="/tmp/hook-last-run"
MIN_INTERVAL=30  # seconds

# Check if enough time has passed
should_run() {
    if [ ! -f "$RATE_LIMIT_FILE" ]; then
        return 0
    fi

    local last_run=$(cat "$RATE_LIMIT_FILE")
    local now=$(date +%s)
    local elapsed=$((now - last_run))

    if [ "$elapsed" -lt "$MIN_INTERVAL" ]; then
        echo "Skipping (ran ${elapsed}s ago, min interval ${MIN_INTERVAL}s)"
        return 1
    fi

    return 0
}

# Update last run time
mark_run() {
    date +%s > "$RATE_LIMIT_FILE"
}

# Usage
if should_run; then
    perform_expensive_operation
    mark_run
fi

echo '{}'
```

## Pattern: Multi-Project Detection

Detect which project/repo a file belongs to.

```bash
detect_project() {
    local file="$1"
    local project_root="/Users/myuser/projects"

    # Extract project name from path
    if [[ "$file" =~ $project_root/([^/]+) ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi

    echo "unknown"
    return 1
}

# Usage
project=$(detect_project "$file_path")

case "$project" in
    "frontend")
        npm --prefix ~/projects/frontend run build
        ;;
    "backend")
        cargo build --manifest-path ~/projects/backend/Cargo.toml
        ;;
    *)
        echo "Unknown project: $project"
        ;;
esac
```

## Pattern: Graceful Degradation

Handle failures gracefully without blocking workflow.

```bash
#!/bin/bash

# Try operation with fallback
try_with_fallback() {
    local primary_cmd="$1"
    local fallback_cmd="$2"
    local description="$3"

    echo "Attempting: $description"

    # Try primary command
    if eval "$primary_cmd" 2>/dev/null; then
        echo "✅ Success"
        return 0
    fi

    echo "⚠️  Primary failed, trying fallback..."

    # Try fallback
    if eval "$fallback_cmd" 2>/dev/null; then
        echo "✅ Fallback succeeded"
        return 0
    fi

    echo "❌ Both failed, continuing anyway"
    return 1
}

# Usage
try_with_fallback \
    "npm run build" \
    "npm run build:dev" \
    "Building project"

# Always return empty response (non-blocking)
echo '{}'
```

## Pattern: Parallel Execution

Run multiple checks in parallel for speed.

```bash
#!/bin/bash

# Run checks in parallel
run_parallel_checks() {
    local pids=()

    # Start each check in background
    check_typescript &
    pids+=($!)

    check_eslint &
    pids+=($!)

    check_tests &
    pids+=($!)

    # Wait for all to complete
    local exit_code=0
    for pid in "${pids[@]}"; do
        wait "$pid" || exit_code=1
    done

    return $exit_code
}

check_typescript() {
    npx tsc --noEmit > /tmp/tsc-output.txt 2>&1
    if [ $? -ne 0 ]; then
        echo "TypeScript errors found"
        return 1
    fi
}

check_eslint() {
    npx eslint . > /tmp/eslint-output.txt 2>&1
}

check_tests() {
    npm test > /tmp/test-output.txt 2>&1
}

# Usage
if run_parallel_checks; then
    echo "✅ All checks passed"
else
    echo "⚠️  Some checks failed"
    cat /tmp/tsc-output.txt
    cat /tmp/eslint-output.txt
fi

echo '{}'
```

## Pattern: Smart Caching

Cache results to avoid redundant work.

```bash
#!/bin/bash

CACHE_DIR="$HOME/.claude/hook-cache"
mkdir -p "$CACHE_DIR"

# Generate cache key
cache_key() {
    local file="$1"
    echo -n "$file:$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file")" | md5sum | cut -d' ' -f1
}

# Check cache
check_cache() {
    local file="$1"
    local key=$(cache_key "$file")
    local cache_file="$CACHE_DIR/$key"

    if [ -f "$cache_file" ]; then
        # Cache hit
        cat "$cache_file"
        return 0
    fi

    return 1
}

# Update cache
update_cache() {
    local file="$1"
    local result="$2"
    local key=$(cache_key "$file")
    local cache_file="$CACHE_DIR/$key"

    echo "$result" > "$cache_file"

    # Clean old cache entries (older than 1 day)
    find "$CACHE_DIR" -type f -mtime +1 -delete 2>/dev/null
}

# Usage
if cached=$(check_cache "$file_path"); then
    echo "Cache hit: $cached"
else
    result=$(expensive_operation "$file_path")
    update_cache "$file_path" "$result"
    echo "Computed: $result"
fi
```

## Pattern: Progressive Output

Show progress for long-running hooks.

```bash
#!/bin/bash

# Progress indicator
show_progress() {
    local message="$1"
    echo -n "$message..."
}

complete_progress() {
    local status="$1"
    if [ "$status" == "success" ]; then
        echo " ✅"
    else
        echo " ❌"
    fi
}

# Usage
show_progress "Running TypeScript compiler"
if npx tsc --noEmit 2>/dev/null; then
    complete_progress "success"
else
    complete_progress "failure"
fi

show_progress "Running linter"
if npx eslint . 2>/dev/null; then
    complete_progress "success"
else
    complete_progress "failure"
fi

echo '{}'
```

## Pattern: Context Injection

Inject helpful context into Claude's prompt.

```javascript
// UserPromptSubmit hook
function injectContext(prompt) {
    const context = [];

    // Add relevant documentation
    if (prompt.includes('API')) {
        context.push('📖 API Documentation: https://docs.example.com/api');
    }

    // Add recent changes
    const recentFiles = getRecentlyEditedFiles();
    if (recentFiles.length > 0) {
        context.push(`📝 Recently edited: ${recentFiles.join(', ')}`);
    }

    // Add project status
    const buildStatus = getLastBuildStatus();
    if (!buildStatus.passed) {
        context.push(`⚠️  Current build has ${buildStatus.errorCount} errors`);
    }

    if (context.length === 0) {
        return { decision: 'approve' };
    }

    return {
        decision: 'approve',
        additionalContext: `\n\n---\n${context.join('\n')}\n---\n`
    };
}
```

## Pattern: Error Accumulation

Collect multiple errors before reporting.

```bash
#!/bin/bash

ERRORS=()

# Add error to collection
add_error() {
    ERRORS+=("$1")
}

# Report all errors
report_errors() {
    if [ ${#ERRORS[@]} -eq 0 ]; then
        echo "✅ No errors found"
        return 0
    fi

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  Found ${#ERRORS[@]} issue(s):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local i=1
    for error in "${ERRORS[@]}"; do
        echo "$i. $error"
        ((i++))
    done

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    return 1
}

# Usage
if ! run_typescript_check; then
    add_error "TypeScript compilation failed"
fi

if ! run_lint_check; then
    add_error "Linting issues found"
fi

if ! run_test_check; then
    add_error "Tests failing"
fi

report_errors

echo '{}'
```

## Pattern: Conditional Blocking

Block only on critical errors, warn on others.

```bash
#!/bin/bash

ERROR_LEVEL="none"  # none, warning, critical

# Check for issues
check_critical_issues() {
    if grep -q "FIXME\|XXX\|TODO: CRITICAL" "$file_path"; then
        ERROR_LEVEL="critical"
        return 1
    fi
    return 0
}

check_warnings() {
    if grep -q "console.log\|debugger" "$file_path"; then
        ERROR_LEVEL="warning"
        return 1
    fi
    return 0
}

# Run checks
check_critical_issues
check_warnings

# Return appropriate decision
case "$ERROR_LEVEL" in
    "critical")
        echo '{
            "decision": "block",
            "reason": "🚫 CRITICAL: Found critical TODOs or FIXMEs that must be addressed"
        }' | jq -c '.'
        ;;
    "warning")
        echo "⚠️  Warning: Found debug statements (console.log, debugger)"
        echo '{}'
        ;;
    *)
        echo '{}'
        ;;
esac
```

## Pattern: Hook Coordination

Coordinate between multiple hooks using shared state.

```bash
# Hook 1: Track state
#!/bin/bash
STATE_FILE="/tmp/hook-state.json"

# Update state
jq -n \
    --arg timestamp "$(date +%s)" \
    --arg files "$files_edited" \
    '{lastRun: $timestamp, filesEdited: ($files | split(","))}' \
    > "$STATE_FILE"

echo '{}'
```

```bash
# Hook 2: Read state
#!/bin/bash
STATE_FILE="/tmp/hook-state.json"

if [ -f "$STATE_FILE" ]; then
    last_run=$(jq -r '.lastRun' "$STATE_FILE")
    files=$(jq -r '.filesEdited[]' "$STATE_FILE")

    # Use state from previous hook
    for file in $files; do
        process_file "$file"
    done
fi

echo '{}'
```

## Pattern: User Notification

Notify user of important events without blocking.

```bash
#!/bin/bash

# Send desktop notification (macOS)
notify_macos() {
    osascript -e "display notification \"$1\" with title \"Claude Code Hook\""
}

# Send desktop notification (Linux)
notify_linux() {
    notify-send "Claude Code Hook" "$1"
}

# Notify based on OS
notify() {
    local message="$1"

    case "$OSTYPE" in
        darwin*)
            notify_macos "$message"
            ;;
        linux*)
            notify_linux "$message"
            ;;
    esac
}

# Usage
if [ "$error_count" -gt 10 ]; then
    notify "⚠️  Build has $error_count errors"
fi

echo '{}'
```

## Remember

- **Keep it simple** - Start with basic patterns, add complexity only when needed
- **Test thoroughly** - Test each pattern in isolation before combining
- **Fail gracefully** - Non-blocking hooks should never crash workflow
- **Log everything** - You'll need it for debugging
- **Document patterns** - Future you will thank present you
