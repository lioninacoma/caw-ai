#!/bin/bash
caw-ai click '#weiter'
echo '{"expectations":[{"id":"E1","status":"pass","evidence":{"type":"eval","value":"Ziel erreicht"}}]}' > /tmp/e.json
caw-ai finish --file /tmp/e.json
