#!/usr/bin/env bash
# Egress allowlist of the sandbox, based on the reference script from anthropics/claude-code.
# Default deny for IPv4 and IPv6; allowed are loopback and HTTPS to the hosts in CAW_ALLOWED_HOSTS.
# The IPs are resolved at start (snapshot) and written to /etc/hosts. After that DNS is closed too:
# otherwise resolver queries could smuggle data out in host names.
set -euo pipefail

REQUIRED_HOST=api.anthropic.com

# Resolve first, while DNS is still open; only report hosts that cannot be resolved.
declare -A ips=()
hosts_lines=""
for host in ${CAW_ALLOWED_HOSTS:?}; do
    resolved="$(getent ahostsv4 "$host" | awk '{print $1}' | grep -E '^[0-9.]+$' | sort -u || true)"
    if [ -z "$resolved" ]; then
        echo "[caw-firewall] cannot resolve: $host" >&2
        if [ "$host" = "$REQUIRED_HOST" ]; then exit 1; fi
        continue
    fi
    for ip in $resolved; do
        ips["$ip"]=1
        hosts_lines+="$ip $host"$'\n'
    done
done
printf '%s' "$hosts_lines" >> /etc/hosts

# Only touch the filter table: Docker redirects its DNS resolver through the NAT table.
iptables -F OUTPUT
iptables -F INPUT
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A INPUT -i lo -j ACCEPT
# Docker's embedded resolver (127.0.0.11) sits on loopback and forwards outside: block it before allowing loopback.
iptables -A OUTPUT -d 127.0.0.11 -j REJECT --reject-with icmp-admin-prohibited
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for ip in "${!ips[@]}"; do
    iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
done
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

ip6tables -F OUTPUT 2>/dev/null || true
ip6tables -F INPUT 2>/dev/null || true
ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
ip6tables -A INPUT -i lo -j ACCEPT 2>/dev/null || true
if ! ip6tables -P OUTPUT DROP 2>/dev/null || ! ip6tables -P INPUT DROP 2>/dev/null; then
    # Without a working IPv6 filter the sandbox only holds if IPv6 is off.
    if ip -6 route show default 2>/dev/null | grep -q .; then
        echo '[caw-firewall] IPv6 active but cannot be filtered. Aborting.' >&2
        exit 1
    fi
fi

echo "[caw-firewall] active: ${#ips[@]} IPs allowed."
