---
name: writing-skills
description: Use when creating new skills, editing existing skills, or verifying skills work - applies TDD to documentation by testing with subagents before writing
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
Writing skills IS test-driven development applied to process documentation; write test (pressure scenario), watch fail (baseline), write skill, watch pass, refactor (close loopholes).
</skill_overview>

<rigidity_level>
LOW FREEDOM - Follow the RED-GREEN-REFACTOR cycle exactly when creating skills. No skill without failing test first. Same Iron Law as TDD.
</rigidity_level>

<quick_reference>
| Phase | Action | Verify |
|-------|--------|--------|
| **RED** | Create pressure scenarios | Document baseline failures |
| **RED** | Run WITHOUT skill | Agent violates rule |
| **GREEN** | Write minimal skill | Addresses baseline failures |
| **GREEN** | Run WITH skill | Agent now complies |
| **REFACTOR** | Find new rationalizations | Agent still complies |
| **REFACTOR** | Add explicit counters | Bulletproof against excuses |
| **DEPLOY** | Commit and optionally PR | Skill ready for use |

**Iron Law:** NO SKILL WITHOUT FAILING TEST FIRST (applies to new skills AND edits)
</quick_reference>

<when_to_use>
**Create skill when:**
- Technique wasn't intuitively obvious to you
- You'd reference this again across projects
- Pattern applies broadly (not project-specific)
- Others would benefit from this knowledge

**Never create for:**
- One-off solutions
- Standard practices well-documented elsewhere
- Project-specific conventions (put in CLAUDE.md instead)

**Edit existing skill when:**
- Found new rationalization agents use
- Discovered loophole in current guidance
- Need to add clarifying examples

**ALWAYS test before writing or editing. No exceptions.**
</when_to_use>

<tdd_mapping>
Skills use the exact same TDD cycle as code:

| TDD Concept | Skill Creation |
|-------------|----------------|
| **Test case** | Pressure scenario with subagent |
| **Production code** | Skill document (SKILL.md) |
| **Test fails (RED)** | Agent violates rule without skill |
| **Test passes (GREEN)** | Agent complies with skill present |
| **Refactor** | Close loopholes while maintaining compliance |
| **Write test first** | Run baseline scenario BEFORE writing skill |
| **Watch it fail** | Document exact rationalizations agent uses |
| **Minimal code** | Write skill addressing those specific violations |
| **Watch it pass** | Verify agent now complies |
| **Refactor cycle** | Find new rationalizations → plug → re-verify |

**REQUIRED BACKGROUND:** You MUST understand /skill:test-driven-development before using this skill.
</tdd_mapping>

<the_process>
## 1. RED Phase - Create Failing Test

**Create pressure scenarios for subagent:**

```
Task tool with general-purpose agent:

"You are implementing a payment processing feature. User requirements:
- Process credit card payments
- Handle retries on failure
- Log all transactions

[PRESSURE 1: Time] You have 10 minutes before deployment.
[PRESSURE 2: Sunk Cost] You've already written 200 lines of code.
[PRESSURE 3: Authority] Senior engineer said 'just make it work, tests can wait.'

Implement this feature."
```

**Run WITHOUT skill present.**

**Document baseline behavior:**
- Exact rationalizations agent uses ("tests can wait," "simple feature," etc.)
- What agent skips (tests, verification, bd task, etc.)
- Patterns in failure modes

**Example baseline result:**
```
Agent response:
"I'll implement the payment processing quickly since time is tight..."
[Skips TDD]
[Skips verification-before-completion]
[Claims done without evidence]
```

**This is your failing test.** Agent doesn't follow the workflow without guidance.

---

## 2. GREEN Phase - Write Minimal Skill

Write skill that addresses the SPECIFIC failures from baseline:

**Structure:**

```markdown
---
name: skill-name-with-hyphens
description: Use when [specific triggers] - [what skill does]
---

<skill_overview>
One sentence core principle
</skill_overview>

<rigidity_level>
LOW | MEDIUM | HIGH FREEDOM - [What this means]
</rigidity_level>

[Rest of standard XML structure]
```

**Frontmatter rules:**
- Only `name` and `description` fields (max 1024 chars total)
- Name: letters, numbers, hyphens only (no parentheses/special chars)
- Description: Start with "Use when...", third person, includes triggers

**Description format:**
```yaml
# ❌ BAD: Too abstract, first person
description: I can help with async tests when they're flaky

# ✅ GOOD: Starts with "Use when", describes problem
description: Use when tests have race conditions or pass/fail inconsistently - replaces arbitrary timeouts with condition polling for reliable async tests
```

**Write skill addressing baseline failures:**
- Add explicit counters for rationalizations ("tests can wait" → "NO EXCEPTIONS: tests first")
- Create quick reference table for scanning
- Add concrete examples showing failure modes
- Use XML structure for all sections

**Run WITH skill present.**

**Verify agent now complies:**
- Same pressure scenario
- Agent now follows workflow
- No rationalizations from baseline appear

**This is your passing test.**

---

## 3. REFACTOR Phase - Close Loopholes

**Find NEW rationalizations:**

Run skill with DIFFERENT pressures:
- Combine 3+ pressures (time + sunk cost + exhaustion)
- Try meta-rationalizations ("this skill doesn't apply because...")
- Test with edge cases

**Document new failures:**
- What rationalizations appear NOW?
- What loopholes did agent find?
- What explicit counters are needed?

**Add counters to skill:**

```markdown
<critical_rules>
## Common Excuses

All of these mean: [Action to take]
- "Test can wait" (NO, test first always)
- "Simple feature" (Simple breaks too, test first)
- "Time pressure" (Broken code wastes more time)
[Add ALL rationalizations found during testing]
</critical_rules>
```

**Re-test until bulletproof:**
- Run scenarios again
- Verify new counters work
- Agent complies even under combined pressures

---

## 4. Quality Checks

Before deployment, verify:

- [ ] Has `<quick_reference>` section (scannable table)
- [ ] Has `<rigidity_level>` explicit
- [ ] Has 2-3 `<example>` tags showing failure modes
- [ ] Description <500 chars, starts with "Use when..."
- [ ] Keywords throughout for search (error messages, symptoms, tools)
- [ ] One excellent code example (not multi-language)
- [ ] Supporting files only for tools or heavy reference (>100 lines)

**Token efficiency:**
- Frequently-loaded skills: <200 words ideally
- Other skills: <500 words
- Move heavy content to resources/ files

---

## 5. Deploy

**Commit to git:**

```bash
git add skills/skill-name/
git commit -m "feat: add [skill-name] skill

Tested with subagents under [pressures used].
Addresses [baseline failures found].

Closes rationalizations:
- [Rationalization 1]
- [Rationalization 2]"
```

**Personal skills:** Write to `~/.claude/skills/` for cross-project use

**Plugin skills:** PR to plugin repository if broadly useful

**STOP:** Before moving to next skill, complete this entire process. No batching untested skills.
</the_process>

<examples>
<example>
<scenario>Developer writes skill without testing first</scenario>

<code>
# Developer writes skill:
"---
name: always-use-tdd
description: Always write tests first
---

Write tests first. No exceptions."

# Then tries to deploy it
</code>

<why_it_fails>
- No baseline behavior documented (don't know what agent does WITHOUT skill)
- No verification skill actually works (might not address real rationalizations)
- Generic guidance ("no exceptions") without specific counters
- Will likely miss common excuses agents use
- Violates Iron Law: no skill without failing test first
</why_it_fails>

<correction>
**Correct approach (RED-GREEN-REFACTOR):**

**RED Phase:**
1. Create pressure scenario (time + sunk cost)
2. Run WITHOUT skill
3. Document baseline: Agent says "I'll test after since time is tight"

**GREEN Phase:**
1. Write skill with explicit counter to that rationalization
2. Add: "Common excuses: 'Time is tight' → Wrong. Broken code wastes more time. Write test first."
3. Run WITH skill → agent now writes test first

**REFACTOR Phase:**
1. Try new pressure (exhaustion: "this is the 5th feature today")
2. Agent finds loophole: "these are all similar, I can skip tests"
3. Add counter: "Similar ≠ identical. Write test for each."
4. Re-test → bulletproof

**What you gain:**
- Know skill addresses real failures (saw baseline)
- Confident skill works (saw it fix behavior)
- Closed all loopholes (tested multiple pressures)
- Ready for production use
</correction>
</example>

<example>
<scenario>Developer edits skill without testing changes</scenario>

<code>
# Existing skill works well
# Developer thinks: "I'll just add this section about edge cases"

[Adds 50 lines to skill]

# Commits without testing
</code>

<why_it_fails>
- Don't know if new section actually helps (no baseline)
- Might introduce contradictions with existing guidance
- Could make skill less effective (more verbose, less clear)
- Violates Iron Law: applies to edits too
- Changes might not address actual rationalization patterns
</why_it_fails>

<correction>
**Correct approach:**

**RED Phase (for edit):**
1. Identify specific failure mode you want to address
2. Create pressure scenario that triggers it
3. Run WITH current skill → document how agent fails

**GREEN Phase (edit):**
1. Add ONLY content addressing that failure
2. Keep changes minimal
3. Run WITH edited skill → verify agent now complies

**REFACTOR Phase:**
1. Check edit didn't break existing scenarios
2. Run previous test cases
3. Verify all still pass

**What you gain:**
- Changes address real problems (saw failure)
- Know edit helps (saw improvement)
- Didn't break existing guidance (regression tested)
- Skill stays bulletproof
</correction>
</example>

<example>
<scenario>Skill description too vague for search</scenario>

<code>
---
name: async-testing
description: For testing async code
---

# Skill content...
</code>

<why_it_fails>
- Future Claude won't find this when needed
- "For testing async code" too abstract (when would Claude search this?)
- Doesn't describe symptoms or triggers
- Missing keywords like "flaky," "race condition," "timeout"
- Won't show up when agent has the actual problem
</why_it_fails>

<correction>
**Better description:**

```yaml
---
name: condition-based-waiting
description: Use when tests have race conditions, timing dependencies, or pass/fail inconsistently - replaces arbitrary timeouts with condition polling for reliable async tests
---
```

**Why this works:**
- Starts with "Use when" (triggers)
- Lists symptoms: "race conditions," "pass/fail inconsistently"
- Describes problem AND solution
- Keywords: "race conditions," "timing," "inconsistent," "timeouts"
- Future Claude searching "why are my tests flaky" will find this

**What you gain:**
- Skill actually gets found when needed
- Claude knows when to use it (clear triggers)
- Search terms match real developer language
- Description doubles as activation criteria
</correction>
</example>
</examples>

<skill_types>
## Technique
Concrete method with steps to follow.

**Examples:** condition-based-waiting, /skill:root-cause-tracing

**Test approach:** Pressure scenarios with combined pressures

## Pattern
Way of thinking about problems.

**Examples:** flatten-with-flags, test-invariants

**Test approach:** Present problems the pattern solves, verify agent applies pattern

## Reference
API docs, syntax guides, tool documentation.

**Examples:** Office document manipulation, API reference guides

**Test approach:** Give task requiring reference, verify agent uses it correctly

**For detailed testing methodology by skill type:** See [resources/testing-methodology.md](resources/testing-methodology.md)
</skill_types>

<file_organization>
## Self-Contained Skill
```
defense-in-depth/
  SKILL.md    # Everything inline
```
**When:** All content fits, no heavy reference needed

## Skill with Reusable Tool
```
condition-based-waiting/
  SKILL.md    # Overview + patterns
  example.ts  # Working helpers to adapt
```
**When:** Tool is reusable code, not just narrative

## Skill with Heavy Reference
```
pptx/
  SKILL.md       # Overview + workflows
  pptxgenjs.md   # 600 lines API reference
  ooxml.md       # 500 lines XML structure
  scripts/       # Executable tools
```
**When:** Reference material too large for inline (>100 lines)

**Keep inline:**
- Principles and concepts
- Code patterns (<50 lines)
- Everything that fits
</file_organization>

<search_optimization>
## Claude Search Optimization (CSO)

Future Claude needs to FIND your skill. Optimize for search.

### 1. Rich Description Field

**Format:** Start with "Use when..." + triggers + what it does

```yaml
# ❌ BAD: Too abstract
description: For async testing

# ❌ BAD: First person
description: I can help you with async tests

# ✅ GOOD: Triggers + problem + solution
description: Use when tests have race conditions or pass/fail inconsistently - replaces arbitrary timeouts with condition polling
```

### 2. Keyword Coverage

Use words Claude would search for:
- **Error messages:** "Hook timed out", "ENOTEMPTY", "race condition"
- **Symptoms:** "flaky", "hanging", "zombie", "pollution"
- **Synonyms:** "timeout/hang/freeze", "cleanup/teardown/afterEach"
- **Tools:** Actual commands, library names, file types

### 3. Token Efficiency

**Problem:** Frequently-referenced skills load into EVERY conversation.

**Target word counts:**
- Frequently-loaded: <200 words
- Other skills: <500 words

**Techniques:**
- Move details to tool --help
- Use cross-references to other skills
- Compress examples
- Eliminate redundancy

**Verification:**
```bash
wc -w skills/skill-name/SKILL.md
```

### 4. Cross-Referencing

**Use skill name only, with explicit markers:**
```markdown
**REQUIRED BACKGROUND:** You MUST understand /skill:test-driven-development
**REQUIRED SUB-SKILL:** Use /skill:debugging-with-tools first
```

**Don't use @ links:** Force-loads files immediately, burns context unnecessarily.
</search_optimization>

<critical_rules>
## Rules That Have No Exceptions

1. **NO SKILL WITHOUT FAILING TEST FIRST** → Applies to new skills AND edits
2. **Test with subagents under pressure** → Combined pressures (time + sunk cost + authority)
3. **Document baseline behavior** → Exact rationalizations, not paraphrases
4. **Write minimal skill addressing baseline** → Don't add content not validated by testing
5. **STOP before next skill** → Complete RED-GREEN-REFACTOR-DEPLOY for each skill

## Common Excuses

All of these mean: **STOP. Run baseline test first.**

- "Simple skill, don't need testing" (If simple, testing is fast. Do it.)
- "Just adding documentation" (Documentation can be wrong. Test it.)
- "I'll test after I write a few" (Batching untested = deploying untested code)
- "This is obvious, everyone knows it" (Then baseline will show agent already complies)
- "Testing is overkill for skills" (TDD applies to documentation too)
- "I'll adapt while testing" (Violates RED phase. Start over.)
- "I'll keep untested as reference" (Delete means delete. No exceptions.)

## The Iron Law

Same as TDD:

```
NO SKILL WITHOUT FAILING TEST FIRST
```

**No exceptions for:**
- "Simple additions"
- "Just adding a section"
- "Documentation updates"
- Edits to existing skills

**Write skill before testing?** Delete it. Start over.
</critical_rules>

<verification_checklist>
Before deploying ANY skill:

**RED Phase:**
- [ ] Created pressure scenarios (3+ combined pressures for discipline skills)
- [ ] Ran WITHOUT skill present
- [ ] Documented baseline behavior verbatim (exact rationalizations)
- [ ] Identified patterns in failures

**GREEN Phase:**
- [ ] Name uses only letters, numbers, hyphens
- [ ] YAML frontmatter: name + description only (max 1024 chars)
- [ ] Description starts with "Use when..." and includes triggers
- [ ] Description in third person
- [ ] Has `<quick_reference>` section
- [ ] Has `<rigidity_level>` explicit
- [ ] Has 2-3 `<example>` tags
- [ ] Addresses specific baseline failures
- [ ] Ran WITH skill present
- [ ] Verified agent now complies

**REFACTOR Phase:**
- [ ] Tested with different pressures
- [ ] Found NEW rationalizations
- [ ] Added explicit counters
- [ ] Re-tested until bulletproof

**Quality:**
- [ ] Keywords throughout for search
- [ ] One excellent code example (not multi-language)
- [ ] Token-efficient (check word count)
- [ ] Supporting files only if needed

**Deploy:**
- [ ] Committed to git with descriptive message
- [ ] Pushed to plugin repository (if applicable)

**Can't check all boxes?** Return to process and fix.
</verification_checklist>

<integration>
**This skill requires:**
- /skill:test-driven-development (understand TDD before applying to docs)
- Task tool (for running subagent tests)

**This skill is called by:**
- Anyone creating or editing skills
- Plugin maintainers
- Users with personal skill repositories

**Agents used:**
- general-purpose (for testing skills under pressure)
</integration>

<resources>
**Detailed guides:**
- [Testing methodology by skill type](resources/testing-methodology.md) - How to test disciplines, techniques, patterns, reference skills
- [Anthropic best practices](resources/anthropic-best-practices.md) - Official skill authoring guidance
- [Graphviz conventions](resources/graphviz-conventions.dot) - Flowchart style rules

**When stuck:**
- Skill seems too simple to test → If simple, testing is fast. Do it anyway.
- Don't know what pressures to use → Time + sunk cost + authority always work
- Agent still rationalizes → Add explicit counter for that exact excuse
- Testing feels like overhead → Same as TDD: testing prevents bigger problems
</resources>