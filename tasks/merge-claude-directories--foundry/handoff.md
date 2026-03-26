# Pipeline Handoff

- **Task**: <!-- priority: 2 -->
<!-- source: manual -->
# Merge brama-core/.claude into root .claude directory

## Context

Currently we have two `.claude` directories in the repository:
- Root `.claude/` - contains skills and settings
- `brama-core/.claude/` - contains skills and **commands/skills**

The `brama-core/.claude/commands/skills/` directory appears to be a duplicate or related structure that should potentially be merged into the root `.claude/` directory.

## Analysis Required

1. **Compare directory structures:**
   - Root: `.claude/skills/`
   - Brama-core: `brama-core/.claude/skills/`
   - Brama-core commands: `brama-core/.claude/commands/skills/`

2. **Identify differences:**
   - Are the skills in `brama-core/.claude/skills/` identical to root `.claude/skills/`?
   - What is in `brama-core/.claude/commands/skills/`?
   - Are there any unique files or configurations?

3. **Check for symlinks:**
   - Some skills might be symlinks (e.g., `builder-agent -> ../../builder/skill`)
   - Need to handle these properly during merge

## Objectives

1. Analyze both `.claude` directories and document:
   - Overlapping skills
   - Unique skills in each location
   - Any conflicting content
   - Purpose of `commands/skills/` subdirectory

2. Create a merge strategy:
   - Determine which directory should be the source of truth
   - Handle symlinks appropriately
   - Preserve any unique content
   - Clean up duplicates

3. Execute the merge:
   - Move/copy unique content to root `.claude/`
   - Remove `brama-core/.claude/` after verification
   - Update any references or symlinks
   - Test that all skills/commands still work

4. Update documentation:
   - Document the final `.claude` structure
   - Explain the purpose of each subdirectory
   - Add notes about maintaining Claude Code configuration

## Success Criteria

- [ ] All unique skills and commands preserved in root `.claude/`
- [ ] No duplicate content between root and brama-core
- [ ] All symlinks working correctly
- [ ] `brama-core/.claude/` directory removed
- [ ] All slash commands still functional
- [ ] Documentation updated with final structure
- [ ] Changes committed with clear explanation

## Notes

- Be careful with symlinks - they need to be updated if paths change
- Test slash commands after merge to ensure they still work
- Consider `.gitignore` patterns that might affect `.claude` files
- Check if any CI/CD or other automation depends on these paths
- **Started**: 2026-03-26 09:40:16
- **Branch**: pipeline/merge-claude-directories
- **Pipeline ID**: 20260326_094011

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: done
- **Files modified**:
  - `UPDATED` `.claude/skills/documentation/SKILL.md` — replaced with newer version from `brama-core/.claude/skills/documentation/SKILL.md` (adds Workspace vs Project Docs section, Root Entry Docs section, ROADMAP.md ledger section, and updated INDEX.md wording)
  - `CREATED` `.claude/commands/skills/agent-auditor.md` — slash command for agent-auditor skill
  - `CREATED` `.claude/commands/skills/agent-debugger.md` — slash command for agent-debugger skill
  - `CREATED` `.claude/commands/skills/devcontainer-provisioner.md` — slash command for devcontainer-provisioner skill
  - `CREATED` `.claude/commands/skills/documentation.md` — slash command for documentation skill
  - `CREATED` `.claude/commands/skills/iframe-admin-harmonizer.md` — slash command for iframe-admin-harmonizer skill
  - `CREATED` `.claude/commands/skills/monitor-version.md` — slash command for monitor-version skill
  - `CREATED` `.claude/commands/skills/security-review.md` — slash command for security-review skill
  - `CREATED` `.claude/commands/skills/translater.md` — slash command for translater skill
  - `CREATED` `.claude/commands/skills/web-to-docs.md` — slash command for web-to-docs skill
  - `DELETED` `brama-core/.claude/` — entire directory removed after merge
- **Migrations created**: none
- **Deviations**:
  - `brama-core/.claude/skills/builder-agent` was a broken symlink (`../../builder/skill` target does not exist) — not migrated to root `.claude/` since the target is missing; noted as follow-up

## Recommended follow-up tasks

- **Restore or remove `builder-agent` skill symlink**: `brama-core/.claude/skills/builder-agent` was a symlink pointing to `../../builder/skill` which does not exist. Either create the `brama-core/builder/skill/` directory with a proper SKILL.md, or remove the reference entirely. Affects: `.claude/skills/` structure and any slash commands that might reference it.

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (u-coder)**: 2e81526
