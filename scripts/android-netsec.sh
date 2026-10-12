#!/usr/bin/env bash
# 本机图片代理走 127.0.0.1 明文 HTTP：release usesCleartextTraffic=false 会拦，
# 注入 network security config 放行 loopback（research #31 换代理）。
# 用法：在 `tauri android init` 之后、`tauri android build` 之前执行
#（本地 release 构建或 CI 均可直接调用；对 cwd 不敏感，基于脚本自身位置定位）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../apps/mojuan"

MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
RES_DIR="src-tauri/gen/android/app/src/main/res/xml"
NSC="$RES_DIR/network_security_config.xml"

test -f "$MANIFEST" || {
    echo "manifest not found: $MANIFEST（先跑 tauri android init）" >&2
    exit 1
}

mkdir -p "$RES_DIR"
cat > "$NSC" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
</network-security-config>
EOF

# manifest 引用该配置（幂等）
if ! grep -q "networkSecurityConfig" "$MANIFEST"; then
    python3 - "$MANIFEST" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace(
    'android:usesCleartextTraffic="${usesCleartextTraffic}">',
    'android:usesCleartextTraffic="${usesCleartextTraffic}" android:networkSecurityConfig="@xml/network_security_config">',
)
open(p, "w").write(s)
PY
fi

echo "android network security config applied: $NSC"
