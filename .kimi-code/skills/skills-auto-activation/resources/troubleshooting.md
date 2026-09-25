# Troubleshooting Skills Auto-Activation

Common issues and solutions for skills auto-activation system.

## Problem: Hook Not Running At All

### Symptoms
- No skill activation messages appear
- Prompts process normally without injected context

### Diagnosis

**Step 1: Check hook configuration**
```bash
cat ~/.claude/hooks.json
```

Should contain:
```json
{
  "hooks": [
    {
      "event": "UserPromptSubmit",
      "command": "~/.claude/hooks/user-prompt-submit/skill-activator.js"
    }
  ]
}
```

**Step 2: Test hook manually**
```bash
echo '{"text": "test backend endpoint"}' | \
  node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

Should output JSON with `decision` and possibly `additionalContext`.

**Step 3: Check file permissions**
```bash
ls -l ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

Should be executable (`-rwxr-xr-x`). If not:
```bash
chmod +x ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

**Step 4: Check Claude Code logs**
```bash
tail -f ~/.claude/logs/hooks.log
```

Look for errors related to skill-activator.

### Solutions

**Solution 1: Reinstall hook**
```bash
mkdir -p ~/.claude/hooks/user-prompt-submit
cp skill-activator.js ~/.claude/hooks/user-prompt-submit/
chmod +x ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

**Solution 2: Verify Node.js**
```bash
which node
node --version
```

Ensure Node.js is installed and in PATH.

**Solution 3: Check hook timeout**
```json
{
  "hooks": [
    {
      "event": "UserPromptSubmit",
      "command": "~/.claude/hooks/user-prompt-submit/skill-activator.js",
      "timeout": 2000  // Increase if needed
    }
  ]
}
```

## Problem: No Skills Activating

### Symptoms
- Hook runs successfully
- No skills appear in activation messages
- Debug shows "No skills activated"

### Diagnosis

**Enable debug mode:**
```bash
DEBUG=true echo '{"text": "your test prompt"}' | \
  node ~/.claude/hooks/user-prompt-submit/skill-activator.js 2>&1
```

**Check for:**
- "No rules loaded" → skill-rules.json not found
- "No skills activated" → Keywords/patterns don't match

### Solutions

**Solution 1: Verify skill-rules.json location**
```bash
cat ~/.claude/skill-rules.json
```

If not found:
```bash
cp skill-rules.json ~/.claude/skill-rules.json
```

**Solution 2: Test with known keyword**
```bash
echo '{"text": "create backend controller"}' | \
  SKILL_RULES=~/.claude/skill-rules.json \
  DEBUG=true \
  node ~/.claude/hooks/user-prompt-submit/skill-activator.js 2>&1
```

Should match "backend-dev-guidelines" if configured.

**Solution 3: Check JSON syntax**
```bash
cat ~/.claude/skill-rules.json | jq '.'
```

If errors, fix JSON syntax.

**Solution 4: Simplify rules for testing**
```json
{
  "test-skill": {
    "type": "test",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["test"]
    }
  }
}
```

Test with:
```bash
echo '{"text": "test"}' | node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

## Problem: Wrong Skills Activating

### Symptoms
- Skills activate on irrelevant prompts
- Too many false positives

### Diagnosis

**Enable debug to see why skills matched:**
```bash
DEBUG=true echo '{"text": "your prompt"}' | \
  node ~/.claude/hooks/user-prompt-submit/skill-activator.js 2>&1
```

Look for "Matched: keyword" or "Matched: intent pattern" to see why.

### Solutions

**Solution 1: Tighten keywords**

Before:
```json
{
  "keywords": ["api", "test", "code"]
}
```

After (more specific):
```json
{
  "keywords": ["API endpoint", "integration test", "refactor code"]
}
```

**Solution 2: Use negative patterns**
```json
{
  "intentPatterns": [
    "(?!.*test).*backend"  // Match "backend" but not if "test" in prompt
  ]
}
```

**Solution 3: Increase priority thresholds**
```json
{
  "test-skill": {
    "priority": "low"  // Will be deprioritized if others match
  }
}
```

**Solution 4: Reduce maxSkills**

In skill-activator.js:
```javascript
const CONFIG = {
    maxSkills: 2,  // Reduce from 3
};
```

## Problem: Hook Is Slow

### Symptoms
- Noticeable delay before Claude responds
- Hook takes >1 second

### Diagnosis

**Measure hook performance:**
```bash
time echo '{"text": "test"}' | node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

Should be <500ms. If slower, diagnose:

**Check number of rules:**
```bash
cat ~/.claude/skill-rules.json | jq 'keys | length'
```

More than 10 rules may slow down.

**Check pattern complexity:**
```bash
cat ~/.claude/skill-rules.json | jq '.[].promptTriggers.intentPatterns'
```

Complex regex patterns slow matching.

### Solutions

**Solution 1: Optimize regex patterns**

Before (slow):
```json
{
  "intentPatterns": [
    ".*create.*backend.*endpoint.*"
  ]
}
```

After (faster):
```json
{
  "intentPatterns": [
    "(create|build).*(backend|API).*(endpoint|route)"
  ]
}
```

**Solution 2: Cache compiled patterns**

Modify hook to compile patterns once:
```javascript
const compiledPatterns = new Map();

function getCompiledPattern(pattern) {
    if (!compiledPatterns.has(pattern)) {
        compiledPatterns.set(pattern, new RegExp(pattern, 'i'));
    }
    return compiledPatterns.get(pattern);
}
```

**Solution 3: Reduce number of rules**

Remove low-priority or rarely-used skills.

**Solution 4: Parallelize pattern matching**

For advanced users, use worker threads to match patterns in parallel.

## Problem: Skills Still Don't Activate in Claude

### Symptoms
- Hook injects activation message
- Claude still doesn't use the skills

### Diagnosis

This means the hook is working, but Claude is ignoring the suggestion.

**Check:**
1. Are skills actually installed?
2. Does Claude have access to read skills?
3. Are skill descriptions clear?

### Solutions

**Solution 1: Make activation message stronger**

In skill-activator.js, change:
```javascript
'Before responding, check if any of these skills should be used.'
```

To:
```javascript
'⚠️ IMPORTANT: You MUST check these skills before responding. Use the Skill tool to load them.'
```

**Solution 2: Block until skills loaded**

Change hook to blocking mode (use cautiously):
```json
{
  "hooks": [
    {
      "event": "UserPromptSubmit",
      "command": "~/.claude/hooks/user-prompt-submit/skill-activator.js",
      "blocking": true  // ⚠️ Experimental
    }
  ]
}
```

**Solution 3: Improve skill descriptions**

Ensure skill descriptions are specific:
```yaml
name: backend-dev-guidelines
description: Use when creating API routes, controllers, services, or repositories - enforces TypeScript patterns, Prisma repository pattern, and Sentry error handling
```

**Solution 4: Reference skills in CLAUDE.md**

Add to project's CLAUDE.md:
```markdown
## Available Skills

- backend-dev-guidelines: Use for all backend code
- frontend-dev-guidelines: Use for all frontend code
- test-driven-development: Use when writing tests
```

## Problem: Hook Crashes Claude Code

### Symptoms
- Claude Code freezes or crashes after hook execution
- Error in hooks.log

### Diagnosis

**Check error logs:**
```bash
tail -50 ~/.claude/logs/hooks.log
```

Look for errors related to skill-activator.

**Common causes:**
- Infinite loop in hook
- Memory leak
- Unhandled promise rejection
- Blocking operation

### Solutions

**Solution 1: Add error handling**
```javascript
async function main() {
    try {
        // ... hook logic
    } catch (error) {
        console.error('Hook error:', error.message);
        // Always return approve on error
        console.log(JSON.stringify({ decision: 'approve' }));
    }
}
```

**Solution 2: Add timeout protection**
```javascript
const timeout = setTimeout(() => {
    console.log(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
}, 900);  // Exit before hook timeout

// Clear timeout if completed normally
clearTimeout(timeout);
```

**Solution 3: Test hook in isolation**
```bash
# Run hook with various inputs
for prompt in "test" "backend" "frontend" "debug"; do
  echo "Testing: $prompt"
  echo "{\"text\": \"$prompt\"}" | \
    timeout 2s node ~/.claude/hooks/user-prompt-submit/skill-activator.js
done
```

**Solution 4: Simplify hook**

Remove complex logic and test minimal version:
```javascript
// Minimal hook for testing
console.log(JSON.stringify({
    decision: 'approve',
    additionalContext: '🎯 Test message'
}));
```

## Problem: Context Overload

### Symptoms
- Too many skill activation messages
- Context window fills quickly
- Claude seems overwhelmed

### Solutions

**Solution 1: Limit activated skills**
```javascript
const CONFIG = {
    maxSkills: 1,  // Only top match
};
```

**Solution 2: Use priorities strictly**
```json
{
  "critical-skill": {
    "priority": "high"  // Only high priority
  },
  "optional-skill": {
    "priority": "low"   // Remove low priority
  }
}
```

**Solution 3: Shorten activation message**
```javascript
function generateContext(skills) {
    return `🎯 Use: ${skills.map(s => s.skill).join(', ')}`;
}
```

## Problem: Inconsistent Activation

### Symptoms
- Sometimes activates, sometimes doesn't
- Same prompt gives different results

### Diagnosis

**This is expected due to:**
- Prompt variations (punctuation, wording)
- Context differences (files being edited)
- Keyword order

### Solutions

**Solution 1: Add keyword variations**
```json
{
  "keywords": [
    "backend",
    "back end",
    "back-end",
    "server side",
    "server-side"
  ]
}
```

**Solution 2: Use more patterns**
```json
{
  "intentPatterns": [
    "create.*backend",
    "backend.*create",
    "build.*API",
    "API.*build"
  ]
}
```

**Solution 3: Log all prompts for analysis**
```javascript
// Add to hook
fs.appendFileSync(
    path.join(process.env.HOME, '.claude/prompt-log.txt'),
    `${new Date().toISOString()} | ${prompt.text}\n`
);
```

Analyze monthly:
```bash
grep "backend" ~/.claude/prompt-log.txt | wc -l
```

## General Debugging Tips

**Enable full debug logging:**
```bash
# Add to hook
const logFile = path.join(process.env.HOME, '.claude/hook-debug.log');
function debug(msg) {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
}

debug(`Analyzing prompt: ${prompt.text}`);
debug(`Activated skills: ${activatedSkills.map(s => s.skill).join(', ')}`);
```

**Test with controlled inputs:**
```bash
# Create test suite
cat > test-prompts.json <<EOF
[
  {"text": "create backend endpoint", "expected": ["backend-dev-guidelines"]},
  {"text": "build react component", "expected": ["frontend-dev-guidelines"]},
  {"text": "write test for API", "expected": ["test-driven-development"]}
]
EOF

# Run tests
node test-hook.js
```

**Monitor in production:**
```bash
# Daily summary
grep "Activated skills" ~/.claude/hook-debug.log | \
  grep "$(date +%Y-%m-%d)" | \
  sort | uniq -c
```

## Getting Help

If problems persist:

1. Check GitHub issues for similar problems
2. Share debug output (sanitize sensitive info)
3. Test with minimal configuration
4. Verify with official examples

**Checklist before asking for help:**
- [ ] Hook runs manually without errors
- [ ] skill-rules.json is valid JSON
- [ ] Node.js version is current (v18+)
- [ ] Debug mode shows expected behavior
- [ ] Tested with simplified configuration
- [ ] Checked Claude Code logs
