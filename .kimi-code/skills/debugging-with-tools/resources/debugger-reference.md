## Debugger Quick Reference

### Automated Debugging (Claude CAN run these)

#### lldb Batch Mode

```bash
# One-shot command to inspect variable at breakpoint
lldb -o "breakpoint set --file main.rs --line 42" \
     -o "run" \
     -o "frame variable my_var" \
     -o "quit" \
     -- target/debug/myapp 2>&1

# With script file for complex debugging
cat > debug.lldb <<'EOF'
breakpoint set --file main.rs --line 42
run
frame variable
bt
up
frame variable
quit
EOF

lldb -s debug.lldb target/debug/myapp 2>&1
```

#### strace (Linux - system call tracing)

```bash
# See which files program opens
strace -e trace=open,openat cargo run 2>&1 | grep -v "ENOENT"

# Find network activity
strace -e trace=network cargo run 2>&1

# All syscalls with time
strace -tt cargo test some_test 2>&1
```

#### dtrace (macOS - dynamic tracing)

```bash
# Trace function calls
sudo dtrace -n 'pid$target:myapp::entry { printf("%s", probefunc); }' -p <PID>
```

### Interactive Debugging (USER runs these, Claude guides)

**These require interactive terminal - Claude provides commands, user runs them**

### lldb (Rust, Swift, C++)

```bash
# Start debugging
lldb target/debug/myapp

# Set breakpoints
(lldb) breakpoint set --file main.rs --line 42
(lldb) breakpoint set --name my_function

# Run
(lldb) run
(lldb) run arg1 arg2

# When paused:
(lldb) frame variable              # Show all locals
(lldb) print my_var                # Print specific variable
(lldb) bt                          # Backtrace (stack)
(lldb) up / down                   # Navigate stack
(lldb) continue                    # Resume
(lldb) step / next                 # Step into / over
(lldb) finish                      # Run until return
```

### Browser DevTools (JavaScript)

```javascript
// In code:
debugger; // Execution pauses here

// In DevTools:
// - Sources tab → Add breakpoint by clicking line number
// - When paused:
//   - Scope panel: See all variables
//   - Watch: Add expressions to watch
//   - Call stack: Navigate callers
//   - Step over (F10), Step into (F11)
```

### gdb (C, C++, Go)

```bash
# Start debugging
gdb ./myapp

# Set breakpoints
(gdb) break main.c:42
(gdb) break myfunction

# Run
(gdb) run

# When paused:
(gdb) print myvar
(gdb) info locals
(gdb) backtrace
(gdb) up / down
(gdb) continue
(gdb) step / next
```

