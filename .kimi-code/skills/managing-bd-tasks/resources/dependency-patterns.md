# bd Dependency Patterns

This guide covers common dependency patterns when managing tasks in bd.

## Dependency Types

- **Blocked-by**: Task cannot start until another task is completed.
- **Discovered-from**: New task found while working on another task.
- **Part-of**: Subtask relationship to a parent epic or task.
- **Relates-to**: Loose coupling that should be tracked but does not block flow.

## Best Practices

- Keep dependency chains shallow (preferably three levels or fewer).
- Link discovered work with `discovered-from` so context is preserved.
- Update blocked tasks promptly when blockers close.
- Avoid circular dependencies; use `tm show <id>` to trace the chain.

## Anti-Patterns

- **Hidden dependencies**: Work blocked by unlinked issues.
- **Over-linking**: Every task linked to every other task dilutes meaning.
- **Orphan blockers**: Blocker closed but dependent task left idle.
