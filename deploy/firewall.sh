#!/bin/sh
# Crewbase firewall rules (safe to run many times).
#  - lets visitors reach the website (ports 80 and 443)
#  - stops agent computers from reaching this server, private networks or the cloud metadata service
set -e
BR=cb-agents

for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done

# Agents may not talk to this server at all (the app, SSH, anything).
iptables -C INPUT -i "$BR" -j DROP 2>/dev/null || iptables -I INPUT 1 -i "$BR" -j DROP

# Agents may only reach the public internet.
if iptables -L DOCKER-USER -n >/dev/null 2>&1; then
  for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
    iptables -C DOCKER-USER -i "$BR" -d "$net" -j DROP 2>/dev/null || iptables -I DOCKER-USER -i "$BR" -d "$net" -j DROP
  done
fi
