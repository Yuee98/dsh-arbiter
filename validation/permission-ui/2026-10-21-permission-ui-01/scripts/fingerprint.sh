#!/bin/sh
set -eu
APP="/Applications/DeepSeek Harness.app"
echo "date=$(date -Iseconds)"
echo "os=$(sw_vers -productVersion) $(uname -m)"
echo "node=$(ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" -e 'process.stdout.write(process.version)')"
echo "dsh_runtime=$(ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json","utf8")).version)')"
echo "app_build=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)"
for f in dsh/package.json dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js dsh/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js dsh/node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js; do
  ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" -e '
    const crypto=require("node:crypto"),fs=require("node:fs");
    const p="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/"+process.argv[1];
    try { process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+process.argv[1]+"\n"); } catch(e) { process.stdout.write("MISSING  "+process.argv[1]+"\n"); }
  ' "$f"
done
