#!/usr/bin/env bash
set +e

echo "=========================================="
echo "  Frontend Page Smoke Check"
echo "=========================================="
echo ""

BASE_URL="${BASE_URL:-http://localhost:2026}"
DOC_PATH="${DOC_PATH:-/en/docs}"

# Single-user build: there is no authentication, session, or CSRF handshake.
# The smoke check only needs to confirm the service is reachable before hitting
# the routes.
authenticate() {
    local health
    health=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/" 2>/dev/null)
    if [ "$health" = "000" ]; then
        echo "✗ Cannot reach ${BASE_URL} — is the service running?"
        return 1
    fi
    return 0
}

all_passed=true

check_status() {
    local name="$1"
    local url="$2"
    local expected_re="$3"

    local status
    status="$(curl -s -o /dev/null -w "%{http_code}" -L "$url")"
    if echo "$status" | grep -Eq "$expected_re"; then
        echo "✓ $name ($url) -> $status"
    else
        echo "✗ $name ($url) -> $status (expected: $expected_re)"
        all_passed=false
    fi
}

check_final_url() {
    local name="$1"
    local url="$2"
    local expected_path_re="$3"

    local effective
    effective="$(curl -s -o /dev/null -w "%{url_effective}" -L "$url")"
    if echo "$effective" | grep -Eq "$expected_path_re"; then
        echo "✓ $name redirect target -> $effective"
    else
        echo "✗ $name redirect target -> $effective (expected path: $expected_path_re)"
        all_passed=false
    fi
}

# Authenticate before checking protected routes
authenticate || exit 1

echo ""
echo "1. Checking entry pages..."
check_status "Landing page" "${BASE_URL}/" "200"
check_status "Workspace redirect" "${BASE_URL}/workspace" "200|301|302|307|308"
check_final_url "Workspace redirect" "${BASE_URL}/workspace" "/workspace/chats/"
echo ""

echo "2. Checking key workspace routes..."
check_status "New chat page" "${BASE_URL}/workspace/chats/new" "200"
check_final_url "New chat page" "${BASE_URL}/workspace/chats/new" "/workspace/"
check_status "Chats list page" "${BASE_URL}/workspace/chats" "200"
check_final_url "Chats list page" "${BASE_URL}/workspace/chats" "/workspace/"
check_status "Agents gallery page" "${BASE_URL}/workspace/agents" "200"
check_final_url "Agents gallery page" "${BASE_URL}/workspace/agents" "/workspace/agents"
echo ""

echo "3. Checking docs route (optional)..."
check_status "Docs page" "${BASE_URL}${DOC_PATH}" "200|404"
echo ""

echo "=========================================="
echo "  Frontend Smoke Check Summary"
echo "=========================================="
echo ""
if [ "$all_passed" = true ]; then
    echo "✅ Frontend smoke checks passed!"
    exit 0
else
    echo "❌ Frontend smoke checks failed"
    exit 1
fi
