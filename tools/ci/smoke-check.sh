#!/usr/bin/env bash
# 部署后的**只读**冒烟检查；并写「地址 + 怎么用」到 run summary。见 .github/workflows/deploy.yml 的
# Smoke check（只读）步骤。
#
# 断言全是只读的。**绝不** PUT /SyncClipboard.json —— 那会把线上当前剪贴板换掉。
# ① 未认证 /api/version → 401（500 则明确报「凭据未配置」并失败）
# ② 已认证 /api/version → 200 且 body == wrangler.toml 的 VERSION
# ③ 已认证 /api/history/statistics → 200 JSON（D1 绑定与查询路径）
# ④ 已认证 /SyncClipboard.json → 200 JSON（Meta / 当前 profile 读路径）
# ⑤ 界面可达性按 UI_ENABLED 断言：true → 四个挂载点的页面与入口 JS 各 200 且 Content-Type 对得上；
#    false → 四个挂载点都必须 404。
# 未配置 USERNAME/PASSWORD 时 ②③④ 降级为 ::notice 跳过（本仓库按 README「方式 A」把凭据只放 Cloudflare）。
#
# 环境变量：DEPLOY_URL（仓库变量，可空）、DEPLOYED_URL（部署步骤输出，可空）、
# SYNC_USER/SYNC_PASS（可空）、UI_ENABLED。
set -uo pipefail

base="${DEPLOY_URL:-${DEPLOYED_URL:-}}"
base="${base%/}"
if [ -z "$base" ]; then
  echo "::error::既没有 DEPLOY_URL 变量、也没有部署步骤输出的地址，冒烟无法执行。"
  echo "　部署本身已成功；把仓库变量 DEPLOY_URL 设为 Worker 地址即可让本步骤恢复。"
  exit 1
fi
echo "冒烟目标已就绪（地址不打印，防公开仓库泄露）"
# 从 wrangler.toml 的 [vars] 里取 VERSION（用 awk 而不是 grep -m1：某些 shell 的 grep 实现差异会让 -m1 取空）
expected=$(awk -F'"' '/^VERSION[ \t]*=/ { print $2; exit }' wrangler.toml)
echo "wrangler.toml 的 VERSION = $expected"
fail=0

sleep 3
code=$(curl -s -o /tmp/unauth.txt -w '%{http_code}' "$base/api/version" || echo 000)
case "$code" in
  401) echo "✓ 未认证 /api/version → 401（鉴权生效）" ;;
  500) echo "::error::未认证 /api/version → 500：$(head -c 200 /tmp/unauth.txt)"
       echo "　按设计，凭据未配置时本服务端 fail-closed 返回 500；请确认 USERNAME/PASSWORD secret 已设置。"
       fail=1 ;;
  *)   echo "::error::未认证 /api/version → 期望 401，实际 $code：$(head -c 200 /tmp/unauth.txt)"
       fail=1 ;;
esac

if [ -n "${SYNC_USER:-}" ] && [ -n "${SYNC_PASS:-}" ]; then
  AUTH=(-u "$SYNC_USER:$SYNC_PASS")
  body=$(curl -s "${AUTH[@]}" "$base/api/version" || true)
  if [ "$body" = "$expected" ]; then
    echo "✓ 已认证 /api/version → $body（凭据可用，且这次部署的版本已生效）"
  else
    echo "::error::已认证 /api/version 返回 '$body'，期望 '$expected'（凭据错，或本次部署未生效）"
    fail=1
  fi

  code=$(curl -s -o /tmp/stats.json -w '%{http_code}' "${AUTH[@]}" "$base/api/history/statistics" || echo 000)
  if [ "$code" = "200" ] && head -c 1 /tmp/stats.json | grep -q '{'; then
    echo "✓ 已认证 /api/history/statistics → 200 JSON（D1 绑定与查询路径可用）"
  else
    echo "::error::/api/history/statistics → $code $(head -c 200 /tmp/stats.json)"
    fail=1
  fi

  code=$(curl -s -o /tmp/profile.json -w '%{http_code}' "${AUTH[@]}" "$base/SyncClipboard.json" || echo 000)
  if [ "$code" = "200" ] && head -c 1 /tmp/profile.json | grep -q '{'; then
    echo "✓ 已认证 /SyncClipboard.json → 200 JSON（Meta /「当前 profile」读路径可用）"
  else
    echo "::error::/SyncClipboard.json → $code $(head -c 200 /tmp/profile.json)"
    fail=1
  fi
else
  echo "::warning::未配置 USERNAME/PASSWORD secrets，跳过三条已认证断言（版本比对 / statistics / SyncClipboard.json）。坏部署（如 D1 缺列）在方式 A 下冒烟仍会全绿 —— 按 README「方式 A」凭据只存在于 Cloudflare，这是预期状态；要启用完整验证面，把两个值配成仓库 secrets 即可。"
fi

# ⑤ 界面可达性：按 UI_ENABLED 的实际生效值断言（无副作用，只是 GET）。
# 断言的单位是「页面 + 入口 JS」成对，且**校验 Content-Type**：模块脚本拿到 HTML 错误页时状态码可能
# 仍是 200，但浏览器解析会失败、整张模块图挂掉（页面停在骨架屏）—— 只看状态码抓不到这一种。
# ⚠️ 入口名必须跟着界面走（V2 是 js/boot.js、V1 是 js/main.js）；挂载点改名时这些路径要同步。
# $1=路径 $2=说明 $3=期望的 Content-Type 前缀
check_asset() {
  local p="$1" what="$2" want="$3" code ctype
  read -r code ctype <<<"$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$base$p" || echo '000 -')"
  if [ "$code" != "200" ]; then
    echo "::error::$p → $code，期望 200（$what）"
    return 1
  fi
  case "$ctype" in
    "$want"*)
      echo "✓ $p → 200（$what，Content-Type: $ctype）"
      ;;
    *)
      echo "::error::$p 的 Content-Type 是 '$ctype'，期望以 '$want' 开头（$what）"
      return 1
      ;;
  esac
}

if [ "${UI_ENABLED:-true}" = "false" ]; then
  # 关掉界面时四个挂载点都必须 404（与 test/ui-guard.test.ts 的同名断言对应）。
  for p in /ui/ /ui_v1/ /ui_v2/ /ui_shared/; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$base$p" || echo 000)
    if [ "$code" = "404" ]; then
      echo "✓ UI_ENABLED=false：$p → 404（界面已关闭）"
    else
      echo "::error::UI_ENABLED=false 时 $p 期望 404，实际 $code"
      fail=1
    fi
  done
else
  check_asset '/ui/' '跳转壳（老书签入口，指向默认界面 /ui_v1/）' 'text/html' || fail=1
  check_asset '/ui/js/redirect-hash.js' '跳转壳脚本（经 Worker → ASSETS 转发）' 'text/javascript' || fail=1
  check_asset '/ui_v1/' '默认界面入口（V1）' 'text/html' || fail=1
  check_asset '/ui_v1/js/main.js' 'V1 模块（经 Worker → ASSETS 转发）' 'text/javascript' || fail=1
  check_asset '/ui_v2/app/' 'V2 开发测试版本体' 'text/html' || fail=1
  check_asset '/ui_v2/js/boot.js' 'V2 模块（经 Worker → ASSETS 转发）' 'text/javascript' || fail=1
  check_asset '/ui_shared/brand/favicon.svg' '共用品牌图标（V1/V2 同一份）' 'image/svg+xml' || fail=1
  check_asset '/ui_shared/js/icons.js' '共用层模块（两版同一份图标表）' 'text/javascript' || fail=1
fi

# 无论冒烟是否通过，都把「地址 + 怎么用」写进 run summary：fork 之后要的就是这个地址；没配凭据时
# 冒烟会红（服务端 fail-closed 返回 500），那时地址仍旧有效 ⇒ 摘要先写，再决定退出码。
if [ "$fail" = "0" ]; then
  smoke_line='✅ 通过'
else
  smoke_line='❌ 失败 —— 见本步骤日志；**部署本身已完成**，上面的地址通常仍然可用（常见原因：没配 `USERNAME`/`PASSWORD` secret）'
fi
if [ "${UI_ENABLED:-true}" = "false" ]; then
  ui_line='**当前 `UI_ENABLED=false`，界面已关闭**（只有协议面）'
else
  ui_line='Web 历史界面：\`/ui_v1/\`（默认界面 V1；地址 = 上面在 Cloudflare 控制台拿到的服务器地址 + \`/ui_v1/\`）'
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo ""
    echo "## 🚀 部署结果"
    echo ""
    echo "**服务器地址（客户端「服务器地址」就填它）**：[在 Cloudflare 控制台查看](https://dash.cloudflare.com/) —— Workers & Pages → 本 Worker → 顶部「域名与路由 / 预览」里复制 \`*.workers.dev\` 地址。"
    echo "> 为防公开仓库泄露，这里**不直接打印地址**。"
    echo ""
    echo "| 项 | 值 |"
    echo "|---|---|"
    echo "| 冒烟检查 | $smoke_line |"
    echo "| 客户端「类型」 | 必须选 **SyncClipboard**（选 WebDAV 会退化成轮询，且没有历史面板）|"
    echo "| 用户名 / 密码 | Secrets 里的 \`USERNAME\` / \`PASSWORD\`（没配它们就用你在 Cloudflare 上手动设的）|"
    echo "| 界面 | $ui_line |"
    echo "| 协议端点 | \`/api/version\`、\`/SyncClipboard.json\`、\`/file/*\`、\`/SyncClipboardHub\` |"
    echo ""
    echo "> 国内网络连不上 \`*.workers.dev\` 时，在 Cloudflare 控制台给这个 Worker 绑一个自定义域名（Settings → Domains & Routes）。"
  } >> "$GITHUB_STEP_SUMMARY"
fi
echo "::notice title=部署结果::部署完成。服务器地址请在 Cloudflare 控制台查看（Workers & Pages → 本 Worker）。"

if [ "$fail" != "0" ]; then exit 1; fi
echo "冒烟通过（全部只读，未修改线上任何数据）"
