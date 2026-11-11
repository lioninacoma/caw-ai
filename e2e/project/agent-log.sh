#!/bin/bash
mkdir -p /tmp/bin
cat > /tmp/bin/claude <<'STUB'
#!/bin/bash
say() { echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$1\"}]}}"; }
say "Schritt 1"
sleep 3
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"caw-ai snapshot"}}]}}'
sleep 3
say "Schritt 3"
sleep 3
echo '{"expectations":[{"id":"E1","status":"pass","evidence":{"type":"eval","value":"Stub"}}]}' > /tmp/e.json
caw-ai finish --file /tmp/e.json > /dev/null
sleep 25
say "DARF NICHT ANKOMMEN"
STUB
chmod +x /tmp/bin/claude
RUN_ID="$(basename "$(dirname "$CAW_AGENT_DIR")")"
PATH=/tmp/bin:$PATH exec caw-ai sandbox-run --run-id "$RUN_ID" --timeout 1
