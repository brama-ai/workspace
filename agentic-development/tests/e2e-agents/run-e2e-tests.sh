#!/usr/bin/env bash
set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ISOLATED_TASKS_DIR="${SCRIPT_DIR}/tasks-e2e-isolated"

echo -e "${BLUE}🧪 Foundry E2E Test Runner${NC}"
echo -e "${BLUE}================================${NC}"

# Step 1: Clean isolated task directory
echo -e "${YELLOW}📁 Cleaning isolated task directory...${NC}"
if [[ -d "$ISOLATED_TASKS_DIR" ]]; then
  rm -rf "$ISOLATED_TASKS_DIR"
fi
mkdir -p "$ISOLATED_TASKS_DIR"
echo -e "${GREEN}✓ Task directory is empty and ready${NC}"

# Step 2: Start e2e test containers
echo -e "${YELLOW}🐳 Starting E2E test containers...${NC}"
docker compose -f docker-compose.e2e.yml up -d --wait

# Wait for services to be ready
echo -e "${YELLOW}⏳ Waiting for services to be ready...${NC}"
sleep 5

# Step 3: Run tests inside container
echo -e "${YELLOW}🧪 Running E2E tests...${NC}"
docker compose -f docker-compose.e2e.yml exec -T e2e-foundry npm test -- "$@"

TEST_EXIT_CODE=$?

# Step 4: Show isolated task directory contents
echo -e "${YELLOW}📂 Isolated task directory contents:${NC}"
ls -la "$ISOLATED_TASKS_DIR" || echo "(empty)"

# Step 5: Cleanup (optional - keep containers running for debugging)
if [[ "${E2E_CLEANUP:-1}" == "1" ]]; then
  echo -e "${YELLOW}🧹 Cleaning up containers...${NC}"
  docker compose -f docker-compose.e2e.yml down
else
  echo -e "${BLUE}ℹ️  Containers are still running. Use 'docker compose -f docker-compose.e2e.yml down' to stop them${NC}"
fi

# Exit with test result
if [[ $TEST_EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}✅ All E2E tests passed!${NC}"
else
  echo -e "${RED}❌ E2E tests failed!${NC}"
fi

exit $TEST_EXIT_CODE
