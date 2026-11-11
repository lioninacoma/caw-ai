#!/usr/bin/env bash
# Sets up the firewall as root, then drops all privileges for good. If the firewall fails, nothing runs.
set -euo pipefail
/usr/local/bin/caw-init-firewall
exec setpriv --reuid={{user}} --regid={{user}} --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
    env HOME=/home/{{user}} USER={{user}} "$@"
