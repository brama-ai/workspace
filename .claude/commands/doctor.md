Run Foundry diagnostics using the u-doctor agent.

**Usage:**
- `/doctor` - Diagnose current Foundry state, create root cause reports
- `/doctor analyze` - Analyze patterns from previous root cause reports
- `/doctor fix` - Apply state fixes for identified issues

**What it does:**
1. Check Foundry health (failed tasks, zombies, missing files)
2. Create root-cause-{timestamp}.md reports in agentic-development/doctor/
3. Identify patterns across multiple failures
4. Fix task state issues (remove stale locks, kill zombies, update state.json)

**Output:**
- Root cause reports: `agentic-development/doctor/root-cause-*.md`
- Pattern summary: `agentic-development/doctor/patterns.md`

Run the u-doctor agent with appropriate context based on the command.
