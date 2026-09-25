## Common Refactoring Patterns

### Extract Method

**When:** Duplicated code or long function

```rust
// Before: Long function
fn process(data: Vec<i32>) -> i32 {
    let mut sum = 0;
    for x in data {
        sum += x * x;
    }
    sum
}

// After: Extracted method
fn process(data: Vec<i32>) -> i32 {
    data.iter().map(|x| square(x)).sum()
}

fn square(x: &i32) -> i32 {
    x * x
}
```

**Steps:**
1. Extract square() function
2. Run tests
3. Commit
4. Replace loop with iterator
5. Run tests
6. Commit

### Rename Variable/Function

**When:** Name is unclear or misleading

```rust
// Before
fn calc(d: Vec<i32>) -> f64 {
    let s: i32 = d.iter().sum();
    s as f64 / d.len() as f64
}

// After - Step by step
// Step 1: Rename function
fn calculate_average(d: Vec<i32>) -> f64 { ... }  // Test, commit

// Step 2: Rename parameter
fn calculate_average(data: Vec<i32>) -> f64 { ... }  // Test, commit

// Step 3: Rename variable
fn calculate_average(data: Vec<i32>) -> f64 {
    let sum: i32 = data.iter().sum();  // Test, commit
    sum as f64 / data.len() as f64
}
```

### Extract Class/Struct

**When:** Class has multiple responsibilities

```rust
// Before: God object
struct UserService {
    db: Database,
    email_validator: Regex,
    name_validator: Regex,
}

// After: Single responsibility
struct UserService {
    db: Database,
    validator: UserValidator,  // EXTRACTED
}

struct UserValidator {
    email_pattern: Regex,
    name_pattern: Regex,
}
```

**Steps:**
1. Create empty UserValidator struct
2. Test, commit
3. Move email_validator field
4. Test, commit
5. Move name_validator field
6. Test, commit
7. Update UserService to use UserValidator
8. Test, commit

### Inline Unnecessary Abstraction

**When:** Abstraction adds no value

```rust
// Before: Pointless wrapper
fn get_user_email(user: &User) -> &str {
    &user.email
}

fn process() {
    let email = get_user_email(&user);  // Just use user.email!
}

// After: Inline
fn process() {
    let email = &user.email;
}
```

**Steps:**
1. Replace one call site with direct access
2. Test, commit
3. Replace next call site
4. Test, commit
5. Remove wrapper function
6. Test, commit

