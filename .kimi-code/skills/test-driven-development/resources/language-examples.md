# TDD Language-Specific Examples

This guide provides concrete TDD examples in multiple programming languages, showing the RED-GREEN-REFACTOR cycle.

## RED Phase Examples

Write one minimal test showing what should happen.

### Rust

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_failed_operations_3_times() {
        let mut attempts = 0;
        let operation = || -> Result<&str, &str> {
            attempts += 1;
            if attempts < 3 {
                Err("fail")
            } else {
                Ok("success")
            }
        };

        let result = retry_operation(operation);

        assert_eq!(result, Ok("success"));
        assert_eq!(attempts, 3);
    }
}
```

**Running the test:**
```bash
cargo test tests::retries_failed_operations_3_times
```

### Swift

```swift
func testRetriesFailedOperations3Times() async throws {
    var attempts = 0
    let operation = { () -> Result<String, Error> in
        attempts += 1
        if attempts < 3 {
            return .failure(RetryError.failed)
        }
        return .success("success")
    }

    let result = try await retryOperation(operation)

    XCTAssertEqual(result, "success")
    XCTAssertEqual(attempts, 3)
}
```

**Running the test:**
```bash
swift test --filter RetryTests.testRetriesFailedOperations3Times
```

### TypeScript

```typescript
describe('retryOperation', () => {
  it('retries failed operations 3 times', async () => {
    let attempts = 0;
    const operation = () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('fail');
      }
      return 'success';
    };

    const result = await retryOperation(operation);

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });
});
```

**Running the test (Jest):**
```bash
npm test -- --testNamePattern="retries failed operations"
```

**Running the test (Vitest):**
```bash
npm test -- -t "retries failed operations"
```

### Why These Are Good

- Clear names describing the behavior
- Test real behavior, not mocks
- One thing per test
- Shows desired API

### Bad Example

```typescript
test('retry', () => {
    let mockCalls = 0;
    const mock = () => {
        mockCalls++;
        return 'success';
    };
    retryOperation(mock);
    expect(mockCalls).toBe(1); // Tests mock, not behavior
});
```

**Why this is bad:**
- Vague name
- Tests mock behavior, not real retry logic

## GREEN Phase Examples

Write simplest code to pass the test.

### Rust

```rust
fn retry_operation<F, T, E>(mut operation: F) -> Result<T, E>
where
    F: FnMut() -> Result<T, E>,
{
    for i in 0..3 {
        match operation() {
            Ok(result) => return Ok(result),
            Err(e) => {
                if i == 2 {
                    return Err(e);
                }
            }
        }
    }
    unreachable!()
}
```

### Swift

```swift
func retryOperation<T>(_ operation: () async throws -> T) async throws -> T {
    var lastError: Error?
    for attempt in 0..<3 {
        do {
            return try await operation()
        } catch {
            lastError = error
            if attempt == 2 {
                throw error
            }
        }
    }
    throw lastError!
}
```

### TypeScript

```typescript
async function retryOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (i === 2) {
        throw error;
      }
    }
  }
  throw lastError;
}
```

### Bad Example - Over-engineered (YAGNI)

```typescript
async function retryOperation<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    backoff?: 'linear' | 'exponential';
    onRetry?: (attempt: number) => void;
    shouldRetry?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  // Don't add features the test doesn't require!
}
```

**Why this is bad:** Test only requires 3 retries. Don't add:
- Configurable retries
- Backoff strategies
- Callbacks
- Error filtering

...until a test requires them.

## Test Requirements

**Every test should:**
- Test one behavior
- Have a clear name
- Use real code (no mocks unless unavoidable)

## Verification Commands by Language

### Rust
```bash
# Single test
cargo test tests::test_name

# All tests
cargo test

# With output
cargo test -- --nocapture
```

### Swift
```bash
# Single test
swift test --filter TestClass.testName

# All tests
swift test

# With output
swift test --verbose
```

### TypeScript (Jest)
```bash
# Single test
npm test -- --testNamePattern="test name"

# All tests
npm test

# With coverage
npm test -- --coverage
```

### TypeScript (Vitest)
```bash
# Single test
npm test -- -t "test name"

# All tests
npm test

# With coverage
npm test -- --coverage
```
