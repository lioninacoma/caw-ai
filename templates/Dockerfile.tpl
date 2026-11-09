# GENERIERT von caw-ai aus dem Image des Projekts oder dem Standard-Image. Nicht von Hand aendern.
FROM {{image}}

USER root

# Den Benutzer gibt es im Image des Projekts meist schon; sonst wird er angelegt.
RUN id -u {{user}} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash {{user}}

# Firewall-Werkzeuge
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables \
    && update-alternatives --set iptables /usr/sbin/iptables-legacy \
    && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy \
    && command -v setpriv \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code

# Der Container-Teil des Tools nutzt nur Node-Bordmittel; der Browser laeuft auf dem Host.
COPY tool /opt/caw-ai
RUN printf '#!/bin/sh\nexec node /opt/caw-ai/bin/caw-ai.mjs "$@"\n' > /usr/local/bin/caw-ai \
    && chmod 0755 /usr/local/bin/caw-ai

COPY skill.md /home/{{user}}/.claude/skills/caw-ai/SKILL.md
RUN chown -R {{user}}: /home/{{user}}/.claude

COPY init-firewall.sh /usr/local/bin/caw-init-firewall
COPY entrypoint.sh /usr/local/bin/caw-entrypoint
RUN chmod 0755 /usr/local/bin/caw-init-firewall /usr/local/bin/caw-entrypoint

ENV CAW_SANDBOX=1
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Startet als root, nur fuer die Firewall. Der Einstiegspunkt wechselt danach dauerhaft den Nutzer.
USER root
ENTRYPOINT ["/usr/local/bin/caw-entrypoint"]
