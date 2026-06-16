# Skill Rules Examples

Example configurations for common skill types and scenarios.

## Domain-Specific Skills

### Backend Development

```json
{
  "backend-dev-guidelines": {
    "type": "domain",
    "priority": "high",
    "promptTriggers": {
      "keywords": [
        "backend", "server", "API", "endpoint", "route",
        "controller", "service", "repository",
        "middleware", "authentication", "authorization"
      ],
      "intentPatterns": [
        "(create|build|implement|add).*?(API|endpoint|route|controller)",
        "how.*(backend|server|API)",
        "(setup|configure).*(server|backend|API)",
        "implement.*(auth|security)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "backend/**/*.ts",
        "server/**/*.ts",
        "src/api/**"
      ]
    }
  }
}
```

### Frontend Development

```json
{
  "frontend-dev-guidelines": {
    "type": "domain",
    "priority": "high",
    "promptTriggers": {
      "keywords": [
        "frontend", "UI", "component", "react", "vue", "angular",
        "page", "layout", "view", "hooks", "state"
      ],
      "intentPatterns": [
        "(create|build).*?(component|page|layout)",
        "how.*(react|hooks|state)",
        "(style|design).*?(component|UI)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "src/components/**/*.tsx",
        "src/pages/**/*.tsx"
      ]
    }
  }
}
```

## Process Skills

### Test-Driven Development

```json
{
  "test-driven-development": {
    "type": "process",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["test", "TDD", "testing", "spec", "jest", "vitest"],
      "intentPatterns": [
        "(write|create|add).*?test",
        "test.*first",
        "reproduce.*(bug|error)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/__tests__/**"
      ]
    }
  }
}
```

### Code Review

```json
{
  "code-review": {
    "type": "process",
    "priority": "medium",
    "promptTriggers": {
      "keywords": ["review", "check", "verify", "audit", "quality"],
      "intentPatterns": [
        "review.*(code|changes|implementation)",
        "(check|verify).*(quality|standards|best practices)"
      ]
    }
  }
}
```

## Technology-Specific Skills

### Database/Prisma

```json
{
  "database-prisma": {
    "type": "technology",
    "priority": "high",
    "promptTriggers": {
      "keywords": [
        "database", "prisma", "schema", "migration",
        "query", "orm", "model"
      ],
      "intentPatterns": [
        "(create|update|modify).*?(schema|model|migration)",
        "(query|fetch|get).*?database"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "**/prisma/**",
        "**/*.prisma"
      ]
    }
  }
}
```

### Docker/DevOps

```json
{
  "devops-docker": {
    "type": "technology",
    "priority": "medium",
    "promptTriggers": {
      "keywords": [
        "docker", "dockerfile", "container",
        "deployment", "CI/CD", "kubernetes"
      ],
      "intentPatterns": [
        "(create|build|configure).*?(docker|container)",
        "(deploy|release|publish)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "**/Dockerfile",
        "**/.github/workflows/**",
        "**/docker-compose.yml"
      ]
    }
  }
}
```

## Project-Specific Skills

### Feature-Specific (E-commerce Cart)

```json
{
  "cart-feature": {
    "type": "feature",
    "priority": "medium",
    "promptTriggers": {
      "keywords": [
        "cart", "shopping cart", "basket",
        "add to cart", "checkout"
      ],
      "intentPatterns": [
        "(implement|create|modify).*?cart",
        "cart.*(functionality|feature|logic)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": [
        "src/features/cart/**",
        "backend/cart-service/**"
      ]
    }
  }
}
```

## Priority-Based Configuration

### High Priority (Always Check)

```json
{
  "critical-security": {
    "type": "security",
    "priority": "high",
    "enforcement": "suggest",
    "promptTriggers": {
      "keywords": [
        "security", "vulnerability", "authentication", "authorization",
        "SQL injection", "XSS", "CSRF", "password", "token"
      ],
      "intentPatterns": [
        "secur(e|ity)",
        "vulnerab(le|ility)",
        "(auth|password|token).*(implement|handle|store)"
      ]
    }
  }
}
```

### Medium Priority (Contextual)

```json
{
  "performance-optimization": {
    "type": "optimization",
    "priority": "medium",
    "promptTriggers": {
      "keywords": [
        "performance", "optimize", "slow", "cache",
        "memory", "speed", "latency"
      ],
      "intentPatterns": [
        "(improve|optimize).*(performance|speed)",
        "(reduce|minimize).*(latency|memory|time)"
      ]
    }
  }
}
```

### Low Priority (Optional)

```json
{
  "documentation-guide": {
    "type": "documentation",
    "priority": "low",
    "promptTriggers": {
      "keywords": [
        "documentation", "docs", "comments", "readme",
        "docstring", "jsdoc"
      ],
      "intentPatterns": [
        "(write|update|create).*?(documentation|docs)",
        "document.*(API|function|component)"
      ]
    }
  }
}
```

## Multi-Repo Configuration

For projects with multiple repositories:

```json
{
  "frontend-mobile": {
    "type": "domain",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["mobile", "ios", "android", "react native"],
      "intentPatterns": ["(create|build).*?(screen|component)"]
    },
    "fileTriggers": {
      "pathPatterns": ["/mobile/**", "/apps/mobile/**"]
    }
  },
  "frontend-web": {
    "type": "domain",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["web", "website", "react", "nextjs"],
      "intentPatterns": ["(create|build).*?(page|component)"]
    },
    "fileTriggers": {
      "pathPatterns": ["/web/**", "/apps/web/**"]
    }
  }
}
```

## Advanced Pattern Matching

### Negative Patterns (Exclude)

```json
{
  "backend-dev-guidelines": {
    "promptTriggers": {
      "keywords": ["backend"],
      "intentPatterns": [
        "backend",
        "(?!.*test).*backend"  // Match "backend" but not if "test" appears
      ]
    }
  }
}
```

### Compound Patterns

```json
{
  "database-migration": {
    "promptTriggers": {
      "intentPatterns": [
        "(create|generate|run).*(migration|schema change)",
        "(add|remove|modify).*(column|table|index)"
      ]
    }
  }
}
```

### Context-Aware Patterns

```json
{
  "error-handling": {
    "promptTriggers": {
      "keywords": ["error", "exception", "try", "catch"],
      "intentPatterns": [
        "(handle|catch|throw).*(error|exception)",
        "error.*handling"
      ]
    }
  }
}
```

## Enforcement Levels

```json
{
  "critical-skill": {
    "enforcement": "block",    // Block if not used (future feature)
    "priority": "high"
  },
  "recommended-skill": {
    "enforcement": "suggest",  // Suggest usage
    "priority": "medium"
  },
  "optional-skill": {
    "enforcement": "optional", // Mention availability
    "priority": "low"
  }
}
```

## Full Example Configuration

Complete configuration for a full-stack TypeScript project:

```json
{
  "backend-dev-guidelines": {
    "type": "domain",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["backend", "API", "endpoint", "controller", "service"],
      "intentPatterns": [
        "(create|add|implement).*?(API|endpoint|route|controller|service)",
        "how.*(backend|server|API)"
      ]
    },
    "fileTriggers": {
      "pathPatterns": ["backend/**/*.ts", "server/**/*.ts"]
    }
  },
  "frontend-dev-guidelines": {
    "type": "domain",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["frontend", "component", "react", "UI"],
      "intentPatterns": ["(create|build).*?(component|page)"]
    },
    "fileTriggers": {
      "pathPatterns": ["src/components/**/*.tsx", "src/pages/**/*.tsx"]
    }
  },
  "test-driven-development": {
    "type": "process",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["test", "TDD", "testing"],
      "intentPatterns": ["(write|create).*?test", "test.*first"]
    },
    "fileTriggers": {
      "pathPatterns": ["**/*.test.ts", "**/*.spec.ts"]
    }
  },
  "database-prisma": {
    "type": "technology",
    "priority": "high",
    "promptTriggers": {
      "keywords": ["database", "prisma", "schema", "migration"],
      "intentPatterns": ["(create|modify).*?(schema|migration)"]
    },
    "fileTriggers": {
      "pathPatterns": ["**/prisma/**"]
    }
  },
  "debugging-with-tools": {
    "type": "process",
    "priority": "medium",
    "promptTriggers": {
      "keywords": ["debug", "bug", "error", "broken", "not working"],
      "intentPatterns": ["(debug|fix|solve).*?(error|bug|issue)"]
    }
  },
  "refactoring-safely": {
    "type": "process",
    "priority": "medium",
    "promptTriggers": {
      "keywords": ["refactor", "cleanup", "improve", "restructure"],
      "intentPatterns": ["(refactor|clean up|improve).*?code"]
    }
  }
}
```

## Tips for Creating Rules

1. **Start broad, refine narrow** - Begin with general keywords, narrow based on false positives
2. **Use priority wisely** - High priority for critical skills only
3. **Test patterns** - Validate regex patterns before deploying
4. **Monitor activation** - Track which skills activate and adjust
5. **Keep it maintainable** - Comment complex patterns
6. **Version control** - Track changes to rules over time
