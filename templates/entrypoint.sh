#!/usr/bin/env bash
# Setzt die Firewall als root und gibt danach alle Rechte endgueltig ab. Scheitert die Firewall, laeuft nichts.
set -euo pipefail
/usr/local/bin/caw-init-firewall
exec setpriv --reuid={{user}} --regid={{user}} --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
    env HOME=/home/{{user}} USER={{user}} "$@"
