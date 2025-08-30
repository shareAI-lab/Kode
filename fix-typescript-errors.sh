#!/bin/bash

# TypeScript Error Fix Execution Script
# This script helps track progress through the fix phases

set -e

echo "TypeScript Error Fix Script - 100% Confidence Plan"
echo "=================================================="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to run TypeScript check
check_typescript() {
    echo -e "${YELLOW}Running TypeScript compilation check...${NC}"
    if npx tsc --noEmit 2>&1 | tee typescript-errors.log; then
        echo -e "${GREEN}✓ No TypeScript errors found!${NC}"
        return 0
    else
        ERROR_COUNT=$(npx tsc --noEmit 2>&1 | wc -l)
        echo -e "${RED}✗ Found $ERROR_COUNT lines of errors${NC}"
        return 1
    fi
}

# Function to show current phase
show_phase() {
    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  PHASE $1: $2${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
}

# Initial check
echo "Initial TypeScript Error Count:"
check_typescript || true
INITIAL_ERRORS=$(wc -l < typescript-errors.log)
echo ""

# Phase tracking
CURRENT_PHASE=1
PHASES_COMPLETED=0

while true; do
    echo -e "${YELLOW}Current Phase: $CURRENT_PHASE${NC}"
    echo "Select an action:"
    echo "1) Check current TypeScript errors"
    echo "2) Mark current phase as complete"
    echo "3) View specific error category"
    echo "4) Generate error summary"
    echo "5) Exit"
    
    read -p "Choice: " choice
    
    case $choice in
        1)
            check_typescript || true
            CURRENT_ERRORS=$(wc -l < typescript-errors.log)
            FIXED=$((INITIAL_ERRORS - CURRENT_ERRORS))
            echo ""
            echo -e "${GREEN}Progress: Fixed $FIXED errors (from $INITIAL_ERRORS to $CURRENT_ERRORS)${NC}"
            ;;
        2)
            PHASES_COMPLETED=$((PHASES_COMPLETED + 1))
            echo -e "${GREEN}✓ Phase $CURRENT_PHASE completed!${NC}"
            CURRENT_PHASE=$((CURRENT_PHASE + 1))
            
            case $CURRENT_PHASE in
                2) show_phase 2 "Tool System Implementation" ;;
                3) show_phase 3 "React 19 / Ink 6 Components" ;;
                4) show_phase 4 "Service Layer Fixes" ;;
                5) show_phase 5 "Hook System Updates" ;;
                6) show_phase 6 "Utility Functions" ;;
                7) show_phase 7 "Dependency Management" ;;
                8) show_phase 8 "Validation & Testing" ;;
                *)
                    echo -e "${GREEN}🎉 All phases completed!${NC}"
                    check_typescript && echo -e "${GREEN}✨ TypeScript compilation successful!${NC}"
                    exit 0
                    ;;
            esac
            ;;
        3)
            echo "Error categories:"
            echo "1) Tool errors"
            echo "2) Component errors"
            echo "3) Hook errors"
            echo "4) Service errors"
            read -p "Select category: " cat
            case $cat in
                1) grep -E "src/tools/" typescript-errors.log | head -20 ;;
                2) grep -E "src/components/|src/screens/" typescript-errors.log | head -20 ;;
                3) grep -E "src/hooks/" typescript-errors.log | head -20 ;;
                4) grep -E "src/services/" typescript-errors.log | head -20 ;;
            esac
            ;;
        4)
            echo "Error Summary by Directory:"
            echo "----------------------------"
            npx tsc --noEmit 2>&1 | grep -oE "src/[^(]*" | cut -d: -f1 | xargs -I {} dirname {} | sort | uniq -c | sort -rn
            ;;
        5)
            echo "Exiting..."
            exit 0
            ;;
    esac
    echo ""
done