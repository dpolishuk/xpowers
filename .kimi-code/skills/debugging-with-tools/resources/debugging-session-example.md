## Example: Complete Debugging Session

**Problem:** Test fails with "Symbol not found: _OBJC_CLASS_$_WKWebView"

**Phase 1: Investigation**

1. **Read error**: Symbol not found, linking issue
2. **Internet research**:
   ```
   Dispatch internet-researcher:
   "Search for 'dyld Symbol not found _OBJC_CLASS_$_WKWebView'
   Focus on: Xcode linking, framework configuration, iOS deployment"

   Results: Need to link WebKit framework in Xcode project
   ```

3. **Debugger**: Not needed, linking happens before runtime

4. **Codebase investigation**:
   ```
   Dispatch codebase-investigator:
   "Find other code using WKWebView - how is WebKit linked?"

   Results: Main app target has WebKit in frameworks, test target doesn't
   ```

**Phase 2: Analysis**

Root cause: Test target doesn't link WebKit framework
Evidence: Main target works, test target fails, Stack Overflow confirms

**Phase 3: Testing**

Hypothesis: Adding WebKit to test target will fix it

Minimal test:
1. Add WebKit.framework to test target
2. Clean build
3. Run tests

```
Dispatch test-runner: "Run: swift test"
Result: ✓ All tests pass
```

**Phase 4: Implementation**

1. Test already exists (the failing test)
2. Fix: Framework linked
3. Verification: Tests pass
4. Update bd:
   ```bash
   tm close bd-123
   ```

**Time:** 15 minutes systematic vs. 2+ hours guessing

## Remember

- **Tools make debugging faster**, not slower
- **internet-researcher** can find solutions in seconds
- **Automated debugging works** - lldb batch mode, strace, instrumentation
- **codebase-investigator** finds patterns you'd miss
- **test-runner agent** keeps context clean
- **Evidence before fixes**, always

**Prefer automated tools:**
1. lldb batch mode - non-interactive variable inspection
2. strace/dtrace - system call tracing
3. Instrumentation - logging Claude can add
4. Interactive debugger - only when automated tools insufficient

95% faster to investigate systematically than to guess-and-check.
