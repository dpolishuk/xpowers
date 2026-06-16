---
name: skills-auto-activation
description: Use when skills aren't activating reliably - covers official solutions (better descriptions) and custom hook system for deterministic skill activation
---

<skill_overview>
Skills often don't activate despite keywords; make activation reliable through better descriptions, explicit triggers, or custom hooks.
</skill_overview>

<rigidity_level>
HIGH FREEDOM - Choose solution level based on project needs (Level 1 for simple, Level 3 for complex). Hook implementation is flexible pattern, not rigid process.
</rigidity_level>

<quick_reference>
| Level | Solution | Effort | Reliability | When to Use |
|-------|----------|--------|-------------|-------------|
| 1 | Better descriptions + explicit requests | Low | Moderate | Small projects, starting out |
| 2 | CLAUDE.md references | Low | Moderate | Document patterns |
| 3 | Custom hook system | High | Very High | Large projects, established patterns |

**XPowers includes:** Auto-activation hook at `hooks/user-prompt-submit/10-skill-activator.js`
</quick_reference>

<when_to_use>
Use this skill when:
- Skills you created aren't being used automatically
- Need consistent skill activation across sessions
- Large codebases with established patterns
- Manual "/use skill-name" gets tedious

**Prerequisites:**
- Skills properly configured (name, description, SKILL.md)
- Code execution enabled (Settings > Capabilities)
- Skills toggled on (Settings > Capabilities)
</when_to_use>

<the_problem>
## What Users Experience

**Symptoms:**
- Keywords from skill descriptions present → skill not used
- Working on files that should trigger skills → nothing
- Skills exist but sit unused

**Community reports:**
- GitHub Issue #9954: "Skills not available even if explicitly enabled"
- "Claude knows it should use skills, but it's not reliable"
- Skills activation is "not reliable yet"

**Root cause:** Skills rely on Claude recognizing relevance (not deterministic)
</the_problem>

<solution_levels>
## Level 1: Official Solutions (Start Here)

### 1. Improve Skill Descriptions

❌ **Bad:**
```yaml
name: backend-dev
description: Helps with backend development
```

✅ **Good:**
```yaml
name: backend-dev-guidelines
description: Use when creating API routes, controllers, services, or repositories in backend - enforces TypeScript patterns, error handling with Sentry, and Prisma repository pattern
```

**Key elements:**
- Specific keywords: "API routes", "controllers", "services"
- When to use: "Use when creating..."
- What it enforces: Patterns, error handling

### 2. Be Explicit in Requests

Instead of: "How do I create an endpoint?"

Try: "Use my backend-dev-guidelines skill to create an endpoint"

**Result:** Works, but tedious

### 3. Check Settings

- Settings > Capabilities > Enable code execution
- Settings > Capabilities > Toggle Skills on
- Team/Enterprise: Check org-level settings

---

## Level 2: Skill References (Moderate)

Reference skills in CLAUDE.md:

```markdown
## When Working on Backend

Before making changes:
1. Check `/skills/backend-dev-guidelines` for patterns
2. Follow repository pattern for database access

The backend-dev-guidelines skill contains complete examples.
```

**Pros:** No custom code
**Cons:** Claude still might not check

---

## Level 3: Custom Hook System (Advanced)

**How it works:**
1. UserPromptSubmit hook analyzes prompt before Claude sees it
2. Matches keywords, intent patterns, file paths
3. Injects skill activation reminder into context
4. Claude sees "🎯 USE these skills" before processing

**Result:** "Night and day difference" - skills consistently used

### Architecture

```
User submits prompt
    ↓
UserPromptSubmit hook intercepts
    ↓
Analyze prompt (keywords, intent, files)
    ↓
Check skill-rules.json for matches
    ↓
Inject activation reminder
    ↓
Claude sees: "🎯 USE these skills: ..."
    ↓
Claude loads and uses relevant skills
```

### Configuration: skill-rules.json

```json
{
  "backend-dev-guidelines": {
    "type": "domain",
    "enforcement": "suggest",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["backend", "controller", "service", "API", "endpoint"],
      "intentPatterns": [
        "(create|add|build).*?(route|endpoint|controller|service)",
        "(how to|pattern).*?(backend|API)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": ["backend/src/**/*.ts", "server/**/*.ts"],
      "contentPatterns": ["express\\.Router", "export.*Controller"]
    }
  },
  "test-driven-development": {
    "type": "process",
    "enforcement": "suggest",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["test", "TDD", "testing"],
      "intentPatterns": [
        "(write|add|create).*?(test|spec)",
        "test.*(first|before|TDD)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": ["**/*.test.ts", "**/*.spec.ts"],
      "contentPatterns": ["describe\\(", "it\\(", "test\\("]
    }
  }
}
```

### Trigger Types

1. **Keyword Triggers** - Simple string matching (case insensitive)
2. **Intent Pattern Triggers** - Regex for actions + objects
3. **File Path Triggers** - Glob patterns for file paths
4. **Content Pattern Triggers** - Regex in file content

### Hook Implementation (High-Level)

```javascript
#!/usr/bin/env node
// ~/.claude/hooks/user-prompt-submit/skill-activator.js

const fs = require('fs');
const path = require('path');

// Load skill rules
const rules = JSON.parse(fs.readFileSync(
  path.join(process.env.HOME, '.claude/skill-rules.json'), 'utf8'
));

// Read prompt from stdin
let promptData = '';
process.stdin.on('data', chunk => promptData += chunk);

process.stdin.on('end', () => {
    const prompt = JSON.parse(promptData);

    // Analyze prompt for skill matches
    const activatedSkills = analyzePrompt(prompt.text);

    if (activatedSkills.length > 0) {
        // Inject skill activation reminder
        const context = `
🎯 SKILL ACTIVATION CHECK

Relevant skills for this prompt:
${activatedSkills.map(s => `- **${s.skill}** (${s.priority} priority)`).join('\n')}

Check if these skills should be used before responding.
`;

        console.log(JSON.stringify({
            decision: 'approve',
            additionalContext: context
        }));
    } else {
        console.log(JSON.stringify({ decision: 'approve' }));
    }
});

function analyzePrompt(text) {
    // Match against all skill rules
    // Return list of activated skills with priorities
}
```

**For complete working implementation:** See [resources/hook-implementation.md](resources/hook-implementation.md)

### Progressive Enhancement

**Phase 1 (Week 1):** Basic keyword matching
```json
{"keywords": ["backend", "API", "controller"]}
```

**Phase 2 (Week 2):** Add intent patterns
```json
{"intentPatterns": ["(create|add).*?(route|endpoint)"]}
```

**Phase 3 (Week 3):** Add file triggers
```json
{"fileTriggers": {"pathPatterns": ["backend/**/*.ts"]}}
```

**Phase 4 (Ongoing):** Refine based on observation
</solution_levels>

<results>
### Before Hook System

- Skills sit unused despite perfect keywords
- Manual "/use skill-name" every time
- Inconsistent patterns across codebase
- Time spent fixing "creative interpretations"

### After Hook System

- Skills activate automatically and reliably
- Consistent patterns enforced
- Claude self-checks before showing code
- "Night and day difference"

**Real user:** "Skills went from 'expensive decorations' to actually useful"
</results>

<limitations>
## Hook System Limitations

1. **Requires hook system** - Not built into Claude Code
2. **Maintenance overhead** - skill-rules.json needs updates
3. **May over-activate** - Too many skills overwhelm context
4. **Not perfect** - Still relies on Claude using activated skills

## Considerations

**Token usage:**
- Activation reminder adds ~50-100 tokens per prompt
- Multiple skills add more tokens
- Use priorities to limit activation

**Performance:**
- Hook adds ~100-300ms to prompt processing
- Acceptable for quality improvement
- Optimize regex patterns if slow

**Maintenance:**
- Update rules when adding new skills
- Review activation logs monthly
- Refine patterns based on misses
</limitations>

<alternatives>
## Approach 1: MCP Integration

Use Model Context Protocol to provide skills as context.

**Pros:** Built into Claude system
**Cons:** Still not deterministic, same activation issues

## Approach 2: Custom System Prompt

Modify Claude's system prompt to always check certain skills.

**Pros:** Works without hooks
**Cons:** Limited to Pro plan, can't customize per-project

## Approach 3: Manual Discipline

Always explicitly request skill usage.

**Pros:** No setup required
**Cons:** Tedious, easy to forget, doesn't scale

## Approach 4: Skill Consolidation

Combine all guidelines into CLAUDE.md.

**Pros:** Always loaded
**Cons:** Violates progressive disclosure, wastes tokens

**Recommendation:** Level 3 (hooks) for large projects, Level 1 for smaller projects
</alternatives>

<critical_rules>
## Rules That Have No Exceptions

1. **Try Level 1 first** → Better descriptions and explicit requests before building hooks
2. **Observe before building** → Watch which prompts should activate skills
3. **Start with keywords** → Add complexity incrementally (keywords → intent → files)
4. **Keep hook fast (<1 second)** → Don't block prompt processing
5. **Maintain skill-rules.json** → Update when skills change

## Common Excuses

All of these mean: **Try Level 1 first, then decide.**

- "Skills should just work automatically" (They should, but don't reliably - workaround needed)
- "Hook system too complex" (Setup takes 2 hours, saves hundreds of hours)
- "I'll manually specify skills" (You'll forget, it gets tedious)
- "Improving descriptions will fix it" (Helps, but not deterministic)
- "This is overkill" (Maybe - start Level 1, upgrade if needed)
</critical_rules>

<verification_checklist>
Before building hook system:

- [ ] Tried improving skill descriptions (Level 1)
- [ ] Tried explicit skill requests (Level 1)
- [ ] Checked all settings are enabled
- [ ] Observed which prompts should activate skills
- [ ] Identified patterns in failures
- [ ] Project large enough to justify hook overhead
- [ ] Have time for 2-hour setup + ongoing maintenance

**If Level 1 works:** Don't build hook system

**If Level 1 insufficient:** Build hook system (Level 3)
</verification_checklist>

<integration>
**This skill covers:** Skill activation strategies

**Related skills:**
- /skill:building-hooks (how to build hook system)
- /skill:using-hyper (when to use skills generally)
- /skill:writing-skills (creating skills that activate well)

**This skill enables:**
- Consistent enforcement of patterns
- Automatic guideline checking
- Reliable skill usage across sessions

**XPowers includes:** Auto-activation hook at `hooks/user-prompt-submit/10-skill-activator.js`
</integration>

<resources>
**Detailed implementation:**
- [Complete working hook code](resources/hook-implementation.md)
- [skill-rules.json examples](resources/skill-rules-examples.md)
- [Troubleshooting guide](resources/troubleshooting.md)

**Official documentation:**
- [Anthropic Skills Best Practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
- [Claude Code Hooks Guide](https://docs.claude.com/en/docs/claude-code/hooks-guide)

**When stuck:**
- Skills still not activating → Check Settings > Capabilities
- Hook not working → Check ~/.claude/logs/hooks.log
- Over-activation → Reduce keywords, increase priority thresholds
- Under-activation → Add more keywords, broaden intent patterns
</resources>
