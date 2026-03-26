#!/usr/bin/env bash
# Quick script to verify e2e test isolation

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔍 Verifying E2E Test Isolation${NC}"
echo ""

# Check 1: Verify tasks-e2e-isolated is empty or doesn't exist
echo -n "1. Checking tasks-e2e-isolated/ is empty... "
if [[ -d "tasks-e2e-isolated" ]]; then
  COUNT=$(find tasks-e2e-isolated -mindepth 1 -maxdepth 1 | wc -l)
  if [[ $COUNT -eq 0 ]]; then
    echo -e "${GREEN}✓${NC}"
  else
    echo -e "${RED}✗ ($COUNT items found)${NC}"
    ls -la tasks-e2e-isolated/
  fi
else
  echo -e "${GREEN}✓ (doesn't exist yet)${NC}"
fi

# Check 2: Verify main tasks/ directory is isolated
echo -n "2. Checking no test tasks in main tasks/... "
if [[ -d "../../../tasks" ]]; then
  TEST_TASKS=$(find ../../../tasks -name "*-e2e-test*" -o -name "*-test-*" 2>/dev/null | wc -l)
  if [[ $TEST_TASKS -eq 0 ]]; then
    echo -e "${GREEN}✓${NC}"
  else
    echo -e "${RED}✗ ($TEST_TASKS test tasks found)${NC}"
    find ../../../tasks -name "*-e2e-test*" -o -name "*-test-*"
  fi
else
  echo -e "${GREEN}✓ (tasks/ doesn't exist)${NC}"
fi

# Check 3: Verify FOUNDRY_TASK_ROOT env var support
echo -n "3. Checking test helpers use FOUNDRY_TASK_ROOT... "
if grep -q "process.env.FOUNDRY_TASK_ROOT" utils/test-helpers.ts; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗ (not found in test-helpers.ts)${NC}"
fi

# Check 4: Verify docker-compose.e2e.yml exists
echo -n "4. Checking docker-compose.e2e.yml exists... "
if [[ -f "docker-compose.e2e.yml" ]]; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗ (file not found)${NC}"
fi

# Check 5: Verify run script is executable
echo -n "5. Checking run-e2e-tests.sh is executable... "
if [[ -x "run-e2e-tests.sh" ]]; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗ (not executable)${NC}"
  echo "   Run: chmod +x run-e2e-tests.sh"
fi

# Check 6: Verify .gitignore includes test directories
echo -n "6. Checking .gitignore excludes test directories... "
if grep -q "tasks-e2e-test" ../../../.gitignore && grep -q "tasks-e2e-isolated" ../../../.gitignore; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗ (not in .gitignore)${NC}"
fi

echo ""
echo -e "${GREEN}✅ Isolation verification complete!${NC}"
echo ""
echo "To run isolated tests:"
echo "  ./run-e2e-tests.sh"
echo ""
echo "To run local tests (faster, less isolation):"
echo "  npm test"
