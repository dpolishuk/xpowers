# Complete Hook Implementation for Skills Auto-Activation

This guide provides complete, production-ready code for implementing skills auto-activation using Claude Code hooks.

## Complete File Structure

```
~/.claude/
├── hooks/
│   └── user-prompt-submit/
│       └── skill-activator.js       # Main hook script
├── skill-rules.json                  # Skill activation rules
└── hooks.json                        # Hook configuration
```

## Step 1: Create skill-rules.json

**Location:** `~/.claude/skill-rules.json`

```json
{
  "backend-dev-guidelines": {
    "type": "domain",
    "enforcement": "suggest",
    "priority": "high",
    "promptTriggers": {
      "keywords": [
        "backend",
        "controller",
        "service",
        "repository",
        "API",
        "endpoint",
        "route",
        "middleware",
        "database",
        "prisma",
        "sequelize"
      ],
      "intentPatterns": [
        "(create|add|build|implement).*?(route|endpoint|controller|service|repository)",
        "(how to|best practice|pattern|guide).*?(backend|API|database|server)",
        "(setup|configure|initialize).*?(database|ORM|API)",
        "implement.*(authentication|authorization|auth|security)",
        "(error|exception).*(handling|catching|logging)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "backend/**/*.ts",
        "backend/**/*.js",
        "server/**/*.ts",
        "api/**/*.ts",
        "src/controllers/**",
        "src/services/**",
        "src/repositories/**"
      ],
      "contentPatterns": [
        "express\\.Router",
        "export.*Controller",
        "export.*Service",
        "export.*Repository",
        "prisma\\.",
        "@Controller",
        "@Injectable"
      ]
    }
  },
  "frontend-dev-guidelines": {
    "type": "domain",
    "enforcement": "suggest",
    "priority": "high",
    "promptTriggers": {
      "keywords": [
        "frontend",
        "component",
        "react",
        "UI",
        "layout",
        "page",
        "view",
        "hooks",
        "state",
        "props",
        "routing",
        "navigation"
      ],
      "intentPatterns": [
        "(create|build|add|implement).*?(component|page|layout|view|screen)",
        "(how to|pattern|best practice).*?(react|hooks|state|context|props)",
        "(style|CSS|design).*?(component|layout|UI)",
        "implement.*?(routing|navigation|route)",
        "(state|data).*(management|flow|handling)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "src/components/**/*.tsx",
        "src/components/**/*.jsx",
        "src/pages/**/*.tsx",
        "src/views/**/*.tsx",
        "frontend/**/*.tsx"
      ],
      "contentPatterns": [
        "import.*from ['\"]react",
        "export.*function.*Component",
        "export.*default.*function",
        "useState",
        "useEffect",
        "React\\.FC"
      ]
    }
  },
  "test-driven-development": {
    "type": "process",
    "enforcement": "suggest",
    "priority": "high",
    "promptTriggers": {
      "keywords": [
        "test",
        "testing",
        "TDD",
        "spec",
        "unit test",
        "integration test",
        "e2e",
        "jest",
        "vitest",
        "mocha"
      ],
      "intentPatterns": [
        "(write|add|create|implement).*?(test|spec|unit test)",
        "test.*(first|before|TDD|driven)",
        "(bug|fix|issue).*?(reproduce|test)",
        "(coverage|untested).*?(code|function)",
        "(mock|stub|spy).*?(function|API|service)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "**/*.test.ts",
        "**/*.test.js",
        "**/*.spec.ts",
        "**/*.spec.js",
        "**/__tests__/**",
        "**/test/**"
      ],
      "contentPatterns": [
        "describe\\(",
        "it\\(",
        "test\\(",
        "expect\\(",
        "jest\\.fn",
        "beforeEach\\(",
        "afterEach\\("
      ]
    }
  },
  "debugging-with-tools": {
    "type": "process",
    "enforcement": "suggest",
    "priority": "medium",
    "promptTriggers": {
      "keywords": [
        "debug",
        "debugging",
        "error",
        "bug",
        "crash",
        "fails",
        "broken",
        "not working",
        "issue",
        "problem"
      ],
      "intentPatterns": [
        "(debug|fix|solve|investigate|troubleshoot).*?(error|bug|issue|problem)",
        "(why|what).*?(failing|broken|not working|crashing)",
        "(find|locate|identify).*?(bug|issue|problem|root cause)",
        "reproduce.*(bug|issue|error)"
      ]
    }
  },
  "refactoring-safely": {
    "type": "process",
    "enforcement": "suggest",
    "priority": "medium",
    "promptTriggers": {
      "keywords": [
        "refactor",
        "refactoring",
        "cleanup",
        "improve",
        "restructure",
        "reorganize",
        "simplify"
      ],
      "intentPatterns": [
        "(refactor|clean up|improve|restructure).*?(code|function|class|component)",
        "(extract|split|separate).*?(function|method|component|logic)",
        "(rename|move|relocate).*?(file|function|class)",
        "remove.*(duplication|duplicate|repeated code)"
      ]
    }
  }
}
```

## Step 2: Create Hook Script

**Location:** `~/.claude/hooks/user-prompt-submit/skill-activator.js`

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
    rulesPath: process.env.SKILL_RULES || path.join(process.env.HOME, '.claude/skill-rules.json'),
    maxSkills: 3,  // Limit to avoid context overload
    debugMode: process.env.DEBUG === 'true'
};

// Load skill rules
function loadRules() {
    try {
        const content = fs.readFileSync(CONFIG.rulesPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        if (CONFIG.debugMode) {
            console.error('Failed to load skill rules:', error.message);
        }
        return {};
    }
}

// Read prompt from stdin
function readPrompt() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                if (CONFIG.debugMode) {
                    console.error('Failed to parse prompt:', error.message);
                }
                resolve({ text: '' });
            }
        });
    });
}

// Analyze prompt for skill matches
function analyzePrompt(promptText, rules) {
    const lowerText = promptText.toLowerCase();
    const activated = [];

    for (const [skillName, config] of Object.entries(rules)) {
        let matched = false;
        let matchReason = '';

        // Check keyword triggers
        if (config.promptTriggers?.keywords) {
            for (const keyword of config.promptTriggers.keywords) {
                if (lowerText.includes(keyword.toLowerCase())) {
                    matched = true;
                    matchReason = `keyword: "${keyword}"`;
                    break;
                }
            }
        }

        // Check intent pattern triggers
        if (!matched && config.promptTriggers?.intentPatterns) {
            for (const pattern of config.promptTriggers.intentPatterns) {
                try {
                    if (new RegExp(pattern, 'i').test(promptText)) {
                        matched = true;
                        matchReason = `intent pattern: "${pattern}"`;
                        break;
                    }
                } catch (error) {
                    if (CONFIG.debugMode) {
                        console.error(`Invalid pattern "${pattern}":`, error.message);
                    }
                }
            }
        }

        if (matched) {
            activated.push({
                skill: skillName,
                priority: config.priority || 'medium',
                reason: matchReason,
                type: config.type || 'general'
            });
        }
    }

    // Sort by priority (high > medium > low)
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    activated.sort((a, b) => {
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        // Secondary sort: process types before domain types
        const typeOrder = { process: 0, domain: 1, general: 2 };
        return (typeOrder[a.type] || 2) - (typeOrder[b.type] || 2);
    });

    // Limit to max skills
    return activated.slice(0, CONFIG.maxSkills);
}

// Generate activation context
function generateContext(skills) {
    if (skills.length === 0) {
        return null;
    }

    const lines = [
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '🎯 SKILL ACTIVATION CHECK',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        'Relevant skills for this prompt:',
        ''
    ];

    for (const skill of skills) {
        const emoji = skill.priority === 'high' ? '⭐' : skill.priority === 'medium' ? '📌' : '💡';
        lines.push(`${emoji} **${skill.skill}** (${skill.priority} priority)`);

        if (CONFIG.debugMode) {
            lines.push(`   Matched: ${skill.reason}`);
        }
    }

    lines.push('');
    lines.push('Before responding, check if any of these skills should be used.');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    return lines.join('\n');
}

// Main execution
async function main() {
    try {
        // Load rules
        const rules = loadRules();

        if (Object.keys(rules).length === 0) {
            if (CONFIG.debugMode) {
                console.error('No rules loaded');
            }
            console.log(JSON.stringify({ decision: 'approve' }));
            return;
        }

        // Read prompt
        const prompt = await readPrompt();

        if (!prompt.text || prompt.text.trim() === '') {
            console.log(JSON.stringify({ decision: 'approve' }));
            return;
        }

        // Analyze prompt
        const activatedSkills = analyzePrompt(prompt.text, rules);

        // Generate response
        if (activatedSkills.length > 0) {
            const context = generateContext(activatedSkills);

            if (CONFIG.debugMode) {
                console.error('Activated skills:', activatedSkills.map(s => s.skill).join(', '));
            }

            console.log(JSON.stringify({
                decision: 'approve',
                additionalContext: context
            }));
        } else {
            if (CONFIG.debugMode) {
                console.error('No skills activated');
            }
            console.log(JSON.stringify({ decision: 'approve' }));
        }
    } catch (error) {
        if (CONFIG.debugMode) {
            console.error('Hook error:', error.message, error.stack);
        }
        // Always approve on error
        console.log(JSON.stringify({ decision: 'approve' }));
    }
}

main();
```

## Step 3: Make Hook Executable

```bash
chmod +x ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

## Step 4: Configure Hook

**Location:** `~/.claude/hooks.json`

```json
{
  "hooks": [
    {
      "event": "UserPromptSubmit",
      "command": "~/.claude/hooks/user-prompt-submit/skill-activator.js",
      "description": "Analyze prompt and inject skill activation reminders",
      "blocking": false,
      "timeout": 1000
    }
  ]
}
```

## Step 5: Test the Hook

### Test 1: Keyword Matching

```bash
# Create test prompt
echo '{"text": "How do I create a new API endpoint?"}' | \
    node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

**Expected output:**
```json
{
  "additionalContext": "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 SKILL ACTIVATION CHECK\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nRelevant skills for this prompt:\n\n⭐ **backend-dev-guidelines** (high priority)\n\nBefore responding, check if any of these skills should be used.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
}
```

### Test 2: Intent Pattern Matching

```bash
echo '{"text": "I want to build a new React component"}' | \
    node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

**Expected:** Should activate frontend-dev-guidelines

### Test 3: Multiple Skills

```bash
echo '{"text": "Write a test for the API endpoint"}' | \
    node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

**Expected:** Should activate test-driven-development and backend-dev-guidelines

### Test 4: Debug Mode

```bash
DEBUG=true echo '{"text": "How do I create a component?"}' | \
    node ~/.claude/hooks/user-prompt-submit/skill-activator.js 2>&1
```

**Expected:** Debug output showing which skills matched and why

## Advanced: File-Based Triggers

To add file-based triggers, extend the hook to check which files are being edited:

```javascript
// Add to skill-activator.js

// Get recently edited files from Claude Code context
function getRecentFiles(prompt) {
    // Claude Code provides context about files being edited
    // This would come from the prompt context or a separate tracking mechanism
    return prompt.files || [];
}

// Check file triggers
function checkFileTriggers(files, config) {
    if (!files || files.length === 0) return false;
    if (!config.fileTriggers) return false;

    // Check path patterns
    if (config.fileTriggers.pathPatterns) {
        for (const file of files) {
            for (const pattern of config.fileTriggers.pathPatterns) {
                // Convert glob pattern to regex
                const regex = globToRegex(pattern);
                if (regex.test(file)) {
                    return true;
                }
            }
        }
    }

    // Check content patterns (would require reading files)
    // Omitted for performance - better to check in PostToolUse hook

    return false;
}

// Convert glob pattern to regex
function globToRegex(glob) {
    const regex = glob
        .replace(/\*\*/g, '___DOUBLE_STAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/___DOUBLE_STAR___/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`);
}
```

## Troubleshooting

### Hook Not Running

**Check:**
```bash
# Verify hook is configured
cat ~/.claude/hooks.json

# Test hook manually
echo '{"text": "test"}' | node ~/.claude/hooks/user-prompt-submit/skill-activator.js

# Check Claude Code logs
tail -f ~/.claude/logs/hooks.log
```

### No Skills Activating

**Enable debug mode:**
```bash
DEBUG=true node ~/.claude/hooks/user-prompt-submit/skill-activator.js < test-prompt.json
```

**Common causes:**
- skill-rules.json not found or invalid
- Keywords don't match (check casing, spelling)
- Patterns have regex errors
- Hook timing out (increase timeout)

### Too Many Skills Activating

**Adjust maxSkills:**
```javascript
const CONFIG = {
    maxSkills: 2,  // Reduce from 3
    // ...
};
```

**Or tighten triggers:**
```json
{
  "backend-dev-guidelines": {
    "priority": "high",  // Only high priority skills
    "promptTriggers": {
      "keywords": ["controller", "service"],  // More specific keywords
      // ...
    }
  }
}
```

### Performance Issues

**If hook is slow (>500ms):**

1. Reduce regex complexity
2. Limit number of patterns
3. Cache compiled regex patterns
4. Profile with:

```bash
time echo '{"text": "test"}' | node ~/.claude/hooks/user-prompt-submit/skill-activator.js
```

## Maintenance

### Monthly Review

```bash
# Check activation frequency
grep "Activated skills" ~/.claude/hooks/debug.log | sort | uniq -c

# Find prompts that didn't activate any skills
grep "No skills activated" ~/.claude/hooks/debug.log
```

### Updating Rules

When adding new skills:

1. Add to skill-rules.json
2. Test activation with sample prompts
3. Observe for false positives/negatives
4. Refine patterns based on usage

### Version Control

```bash
# Track rules in git
cd ~/.claude
git init
git add skill-rules.json hooks/
git commit -m "Initial skill activation rules"
```

## Integration with Other Hooks

The skill activator can work alongside other hooks:

```json
{
  "hooks": [
    {
      "event": "UserPromptSubmit",
      "command": "~/.claude/hooks/user-prompt-submit/00-log-prompt.sh",
      "description": "Log prompts for analysis",
      "blocking": false
    },
    {
      "event": "UserPromptSubmit",
      "command": "~/.claude/hooks/user-prompt-submit/10-skill-activator.js",
      "description": "Activate relevant skills",
      "blocking": false
    }
  ]
}
```

**Naming convention:** Use numeric prefixes (00-, 10-, 20-) to control execution order.

## Performance Benchmarks

**Target performance:**
- Keyword matching: <50ms
- Intent pattern matching: <200ms
- Total hook execution: <500ms

**Actual performance (typical):**
- 2-3 skills: ~100-300ms
- 5+ skills: ~300-500ms

If performance degrades, profile and optimize patterns.
