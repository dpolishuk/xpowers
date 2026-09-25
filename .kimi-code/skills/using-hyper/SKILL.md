---
name: using-hyper
description: Use when starting any conversation - establishes mandatory workflows for finding and using skills
---

<kimi_compat>
This skill was ported to Kimi Code CLI. In Kimi:
- Load skills with `/skill:name` or let the model invoke them automatically.
- "SetTodoList" means use the `SetTodoList` tool.
- "Agent()" / "Agent" means use the built-in `Agent` tool.
- "parallel Agent calls with run_in_background=true" means dispatch multiple `Agent` calls with `run_in_background=true`.
- Claude-specific hooks and slash commands are not available; skip those steps.
</kimi_compat>
<EXTREMELY_IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST read the skill.

**IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.**

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY_IMPORTANT>

<skill_overview>
Skills are proven workflows; if one exists for your task, using it is mandatory, not optional.
</skill_overview>

<rigidity_level>
HIGH FREEDOM - The meta-process (check for skills, read the skill file, announce usage) is rigid, but each individual skill defines its own rigidity level.
</rigidity_level>

<quick_reference>
**Before responding to ANY user message:**

1. List available skills mentally
2. Ask: "Does ANY skill match this request?"
3. If yes → Read the skill's `SKILL.md` file from disk
4. Announce which skill you're using
5. Follow the skill exactly as written

**Skill has checklist?** Create a checklist section in your response and track each item.

**Finding a relevant skill = mandatory to use it.**
</quick_reference>

<when_to_use>
This skill applies at the start of EVERY conversation and BEFORE every task:

- User asks you to implement a feature
- User asks you to fix a bug
- User asks you to refactor code
- User asks you to debug an issue
- User asks you to write tests
- User asks you to review code
- User describes a problem to solve
- User provides requirements to implement

**Applies to:** Literally any task that might have a corresponding skill.
</when_to_use>

<the_process>
## 1. MANDATORY FIRST RESPONSE PROTOCOL

Before responding to ANY user message, complete this checklist:

1. ☐ List available skills in your mind
2. ☐ Ask yourself: "Does ANY skill match this request?"
3. ☐ If yes → Read the skill's `SKILL.md` file from disk
4. ☐ Announce which skill you're using
5. ☐ Follow the skill exactly

**Responding WITHOUT completing this checklist = automatic failure.**

---

## 2. Execute Skills by Reading SKILL.md

**Always read the skill file from disk.** Never rely on memory.

Example path:
```
.kimi-code/skills/test-driven-development/SKILL.md
```

If the repo doesn't have `.kimi-code/skills`, check user-level skills:
```
~/.kimi-code/skills/test-driven-development/SKILL.md
```

**Why:**
- Skills evolve - you need the current version
- Reading the file ensures you get the full skill content
- Confirms to user you're following the skill

---

## 3. Announce Skill Usage

Before using a skill, announce it:

**Format:** "I'm using [Skill Name] to [what you're doing]."

**Examples:**
- "I'm using /skill:brainstorming to refine your idea into a design."
- "I'm using /skill:test-driven-development to implement this feature."
- "I'm using /skill:debugging-with-tools to investigate this error."

**Why:** Transparency helps user understand your process and catch errors early. Confirms you actually read the skill.

---

## 4. Follow Mandatory Workflows

**Before writing ANY code:**
- Use /skill:brainstorming to refine requirements
- Use /skill:writing-plans to create detailed plan
- Use /skill:executing-plans to implement iteratively

**When implementing:**
- Use /skill:test-driven-development (RED-GREEN-REFACTOR cycle)
- Use /skill:verification-before-completion before claiming done

**When debugging:**
- Use /skill:debugging-with-tools (tools first, fixes second)
- Use /skill:fixing-bugs (complete workflow from discovery to closure)

**User instructions describe WHAT to do, not HOW.** "Add X" means use brainstorming, TDD, verification. Not permission to skip workflows.

---

## 5. Create a Checklist for Skill Checklists

If a skill has a checklist, YOU MUST create a checklist section in your response for EACH item.

**Don't:**
- Work through checklist mentally
- Skip creating todos "to save time"
- Batch multiple items into one todo
- Mark complete without doing them

**Why:** Checklists without explicit tracking = steps get skipped. Every time. The overhead is tiny compared to missing steps.

**Example:**

```
Skill has verification checklist:
- [ ] All tests pass
- [ ] No linter warnings
- [ ] bd task updated

Checklist items:
1. Run all tests and verify they pass
2. Run linter and verify no warnings
3. Update bd task with completion status
```
</the_process>

<examples>
<example>
<scenario>User asks to implement a new feature</scenario>

<code>
User: "Add a user profile page with avatar upload"

Claude (without using-hyper):
"Sure! Let me start implementing the user profile page..."
[Starts writing code immediately without brainstorming or planning]
</code>

<why_it_fails>
- Skipped mandatory brainstorming (requirements unclear)
- Skipped writing-plans (no detailed implementation plan)
- Skipped test-driven-development (no tests first)
- Will likely miss edge cases, make wrong assumptions
- User has no visibility into approach before code is written
</why_it_fails>

<correction>
**Correct approach:**

Claude: "I'm using /skill:brainstorming to refine your requirements into a complete design."

[Read `.kimi-code/skills/brainstorming/SKILL.md`]
[Asks Socratic questions about avatar size limits, formats, storage, etc.]
[Creates refined requirements]

Claude: "Now I'm using /skill:writing-plans to create a detailed implementation plan."

[Read `.kimi-code/skills/writing-plans/SKILL.md`]
[Creates bd epic with tasks]

Claude: "Now I'm using /skill:executing-plans to implement the tasks iteratively."

[Read `.kimi-code/skills/executing-plans/SKILL.md`]
[Implements with TDD, commits incrementally]

**What you gain:**
- Clear requirements before coding
- Detailed plan user can review
- Implementation follows proven workflow
- Tests written first (TDD)
- Progress tracked in bd
</correction>
</example>

<example>
<scenario>User reports a bug</scenario>

<code>
User: "Users can't log in after password reset"

Claude (without using-hyper):
"Let me check the password reset code... I found the issue, it's not updating the password hash. Let me fix that..."
[Makes immediate fix without investigation]
</code>

<why_it_fails>
- Skipped debugging-with-tools (no systematic investigation)
- Skipped fixing-bugs workflow (no bd issue, no regression test)
- "Obvious" fix might be wrong or incomplete
- No verification that fix actually works
- Will likely miss root cause and fix symptom
</why_it_fails>

<correction>
**Correct approach:**

Claude: "I'm using /skill:debugging-with-tools to investigate this systematically."

[Read `.kimi-code/skills/debugging-with-tools/SKILL.md`]
[Uses debugger, checks logs, searches internet for known issues]
[Identifies root cause: token invalidation timing issue]

Claude: "Now I'm using /skill:fixing-bugs to implement a complete fix."

[Read `.kimi-code/skills/fixing-bugs/SKILL.md`]
[Creates bd bug issue]
[Writes failing test reproducing bug (RED)]
[Implements minimal fix (GREEN)]
[Runs full test suite via test-runner agent]
[Verifies fix and closes bd issue]

**What you gain:**
- Root cause identified (not symptom)
- Regression test prevents recurrence
- Fix verified with evidence
- Bug tracked in bd
- Complete workflow documented
</correction>
</example>

<example>
<scenario>User asks to refactor code</scenario>

<code>
User: "This validation logic is duplicated, can you extract it?"

Claude (without using-hyper):
"Sure, let me extract that into a shared function..."
[Changes 5 files at once, then runs tests]
[Tests fail]
"Hmm, let me fix these test failures..."
</code>

<why_it_fails>
- Skipped refactoring-safely workflow (change→test→commit cycle)
- Big-bang refactoring (changed multiple files before testing)
- Tests failing means behavior changed (not safe refactoring)
- Can't identify which change broke what
- Wastes time debugging entire refactoring
</why_it_fails>

<correction>
**Correct approach:**

Claude: "I'm using /skill:refactoring-safely to extract this validation logic incrementally."

[Read `.kimi-code/skills/refactoring-safely/SKILL.md`]

Step 1: Verify tests pass BEFORE refactoring
Step 2: Create bd refactoring task
Step 3: Extract validation from first file → test → commit
Step 4: Extract validation from second file → test → commit
Step 5: Create shared validator → test → commit
Step 6: Final verification → close bd task

**What you gain:**
- Tests stay green throughout (safe refactoring)
- Each commit is reviewable independently
- Know exactly which change broke if test fails
- Can stop halfway with useful progress
- Clear history of transformations
</correction>
</example>
</examples>

<critical_rules>
## Rules That Have No Exceptions

1. **Check for relevant skills BEFORE any task** → If skill exists, use it (not optional)
2. **Read skill files from disk** → Never rely on memory (skills evolve)
3. **Announce skill usage** → Transparency helps catch errors early
4. **Follow mandatory workflows** → brainstorming before coding, TDD for implementation, verification before claiming done
5. **Create a checklist for checklists** → Mental tracking = skipped steps

## Common Rationalizations

All of these mean: **STOP. Check for and use the relevant skill.**

- "This is just a simple question" (Questions are tasks. Check for skills.)
- "I can check git/files quickly" (Files lack context. Check for skills.)
- "Let me gather information first" (Skills tell you HOW to gather. Check for skills.)
- "This doesn't need a formal skill" (If skill exists, use it. Not optional.)
- "I remember this skill" (Skills evolve. Read the skill file to load the current version.)
- "This doesn't count as a task" (Taking action = task. Check for skills.)
- "The skill is overkill for this" (Skills exist because "simple" becomes complex.)
- "I'll just do this one thing first" (Check for skills BEFORE doing anything.)
- "Instruction was specific so I can skip brainstorming" (Specific instructions = WHAT, not HOW. Use workflows.)
</critical_rules>

<understanding_rigidity>
## Rigid Skills (Follow Exactly)

These have LOW FREEDOM - follow the exact process:

- /skill:test-driven-development (RED-GREEN-REFACTOR cycle)
- /skill:verification-before-completion (evidence before claims)
- /skill:executing-plans (continuous execution, substep tracking)

## Flexible Skills (Adapt Principles)

These have HIGH FREEDOM - adapt core principles to context:

- /skill:brainstorming (Socratic method, but questions vary)
- /skill:managing-bd-tasks (operations adapt to project)
- /skill:sre-task-refinement (corner case analysis, but depth varies)

**The skill itself tells you its rigidity level.** Check `<rigidity_level>` section.
</understanding_rigidity>

<instructions_vs_workflows>
## User Instructions Describe WHAT, Not HOW

**User says:** "Add user authentication"
**This means:** Use brainstorming → writing-plans → executing-plans → TDD → verification

**User says:** "Fix this bug"
**This means:** Use debugging-with-tools → fixing-bugs → TDD → verification

**User says:** "Refactor this code"
**This means:** Use refactoring-safely (change→test→commit cycle)

**User instructions are the GOAL, not permission to skip workflows.**

**Red flags that you're rationalizing:**
- "Instruction was specific, don't need brainstorming"
- "Seems simple, don't need TDD"
- "Workflow is overkill for this"

**Why workflows matter MORE when instructions are specific:**
- Clear requirements = perfect time for structured implementation
- "Simple" tasks often have hidden complexity
- Skipping process on "easy" tasks is how they become hard problems
</instructions_vs_workflows>

<verification_checklist>
Before completing ANY task:

- [ ] Did I check for relevant skills before starting?
- [ ] Did I read skill files from disk (not rely on memory)?
- [ ] Did I announce which skill I'm using?
- [ ] Did I follow the skill's process exactly?
- [ ] Did I create a checklist section for any skill checklists?
- [ ] Did I follow mandatory workflows (brainstorming, TDD, verification)?

**Can't check all boxes?** You skipped critical steps. Review and fix.
</verification_checklist>

<integration>
**This skill calls:**
- ALL other skills (meta-skill that triggers appropriate skill usage)

**This skill is called by:**
- Session start (always loaded)
- User requests (check before every task)

**Critical workflows this establishes:**
- /skill:brainstorming (before writing code)
- /skill:test-driven-development (during implementation)
- /skill:verification-before-completion (before claiming done)
</integration>

<resources>
**Available skills:**
- See skill descriptions in each SKILL.md frontmatter or list the `.kimi-code/skills` directory
- Each skill's description shows when to use it

**When unsure if skill applies:**
- If there's even 1% chance it applies → use it
- Better to load and decide "not needed" than to skip and fail
- Skills are optimized, loading them is cheap
</resources>
