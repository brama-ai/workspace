# Pipeline Handoff

- **Task**: <!-- priority: 2 -->
<!-- source: manual -->
# Fix tab scroll navigation and add scrollbar in Foundry monitor

## Problem

When opening tabs with text content (summary, handoff, etc.) in Foundry TUI monitor, especially when content doesn't fit on screen:
- Arrow up/down keys don't scroll the text content
- No visual scrollbar indicator to show scroll position
- User can't navigate through long files

## Requirements

### 1. Enable keyboard scroll navigation
- ✅ Arrow Up/Down should scroll text content in active tab
- ✅ PageUp/PageDown for faster navigation
- ✅ Home/End to jump to start/end
- ✅ Mouse wheel support (if possible in terminal)

### 2. Add visual scrollbar
- ✅ Render scrollbar on the right side of text content
- ✅ Show current position in document (percentage or visual bar)
- ✅ Update scrollbar as user scrolls
- ✅ Only show when content is longer than viewport

### 3. E2E test coverage
- ✅ Test opening summary tab with long content
- ✅ Test arrow key navigation scrolls content
- ✅ Test scrollbar appears when content > viewport
- ✅ Test scrollbar position updates on scroll
- ✅ Test switching between tabs preserves scroll position

## Files to modify

Based on Foundry monitor structure:
- `agentic-development/monitor/src/components/TaskDetail.tsx` - tab rendering
- `agentic-development/monitor/src/components/App.tsx` - keyboard handling
- Add E2E test: `agentic-development/tests/e2e-agents/specs/tui-scroll.spec.ts`

## Implementation hints

For blessed/react-blessed (TUI library):
```typescript
// Use blessed's scrollable box
<box
  scrollable={true}
  alwaysScroll={true}
  scrollbar={{
    ch: '█',
    track: { bg: 'grey' },
    style: { inverse: true }
  }}
  keys={true}
  vi={true}
/>
```

## Success criteria

- [ ] Open summary tab with long content (500+ lines)
- [ ] Press Arrow Down - content scrolls
- [ ] Scrollbar visible on right side
- [ ] Scrollbar position updates as you scroll
- [ ] Switching tabs and back preserves scroll position
- [ ] E2E test validates scroll behavior
- [ ] Documentation updated with keyboard shortcuts
- [ ] Changes merged to main locally (no PR)

## Merge strategy

Use **direct merge mode** - merge locally without PR:
1. u-coder fixes the scroll issue
2. u-tester adds E2E test
3. u-merger merges main → feature, then feature → main locally
4. u-summarizer creates final summary

Set task to use: `--profile merge` with instruction "merge locally without pull request"
- **Started**: 2026-03-26 10:21:47
- **Branch**: pipeline/fix-foundry-monitor-tab-scroll
- **Pipeline ID**: 20260326_102143

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: pending
- **Files modified**: —
- **Migrations created**: —
- **Deviations**: —

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

