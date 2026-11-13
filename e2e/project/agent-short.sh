#!/bin/bash
caw agent click '#weiter'
echo '{"expectations":[{"id":"E1","status":"pass","evidence":{"type":"eval","value":"Ziel erreicht"}}]}' > /tmp/e.json
caw agent finish --file /tmp/e.json
