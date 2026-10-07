#!/usr/bin/env bash
# CI 部署时按**库名**解析/创建 D1 库，并按名字幂等确保 R2 桶存在；把真实 D1 id 注入 runner 的
# wrangler.toml 工作副本（不提交）。见 .github/workflows/deploy.yml 的 Resolve Cloudflare resources 步骤。
#
# 环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、PINNED_D1_ID（仓库变量 D1_DATABASE_ID，
# 可空）、ALLOW_BOOTSTRAP（仓库变量 D1_BOOTSTRAP，可空 ⇒ 视为 true）。
# 输出：把 d1_id 写入 $GITHUB_OUTPUT（若设置了该变量），并追加一段 Markdown 到 $GITHUB_STEP_SUMMARY。
set -euo pipefail

api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
# cf <METHOD> <URL> [JSON]
cf() {
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'content-type: application/json' --data "$3" "$2"
  else
    curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$2"
  fi
}

bucket=$(grep -m1 '^bucket_name' wrangler.toml | sed -E 's/.*"(.*)".*/\1/')
db_name=$(grep -m1 '^database_name' wrangler.toml | sed -E 's/.*"(.*)".*/\1/')

# ---- R2：按名字，幂等（已存在就跳过；不解析 CLI 输出，只看状态码）
r2_code=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/r2/buckets/$bucket" || echo 000)
if [ "$r2_code" = "200" ]; then
  echo "✓ R2 桶 $bucket 已存在"
else
  cf POST "$api/r2/buckets" "{\"name\":\"$bucket\"}" > /dev/null || true
  echo "🆕 已尝试创建 R2 桶 $bucket（HTTP $r2_code；缺失时 wrangler deploy 也会自动建）"
fi

# ---- D1：按库名解析（分页遍历，不依赖某个查询参数是否被支持）
d1_id="${PINNED_D1_ID:-}"
if [ -n "$d1_id" ]; then
  echo "· D1：使用仓库变量 D1_DATABASE_ID 指定的库（跳过按名解析）"
fi
page=1
while [ -z "$d1_id" ]; do
  body=$(cf GET "$api/d1/database?page=$page&per_page=100")
  d1_id=$(printf '%s' "$body" | jq -r --arg n "$db_name" '.result[]? | select(.name == $n) | .uuid' | head -1)
  if [ -n "$d1_id" ]; then break; fi
  pages=$(printf '%s' "$body" | jq -r '.result_info.total_pages // 1')
  if [ "$page" -ge "$pages" ]; then break; fi
  page=$((page + 1))
done

created="false"
if [ -z "$d1_id" ]; then
  if [ "${ALLOW_BOOTSTRAP:-true}" = "false" ]; then
    echo "::error::D1 库 $db_name 不存在，且仓库变量 D1_BOOTSTRAP=false ⇒ 按配置拒绝创建"
    exit 1
  fi
  d1_id=$(cf POST "$api/d1/database" "{\"name\":\"$db_name\"}" | jq -r '.result.uuid // empty')
  if [ -z "$d1_id" ]; then
    echo "::error::创建 D1 库失败 —— 检查令牌是否含 D1:Edit 权限、CLOUDFLARE_ACCOUNT_ID 是否正确"
    exit 1
  fi
  created="true"
  echo "🆕 创建了 D1 库 $db_name（历史记录为**空**；库 id 不再打印，防公开仓库泄露）"
  echo "::warning title=创建了新的 D1 库::$db_name（历史记录为**空**）。若你本以为它已存在，请检查账号与库名；已删库的数据不会自动恢复。"
else
  echo "✓ D1 库 $db_name 已存在"
fi

# 注入 **runner 的工作副本**（不提交；仓库里那份是全零占位值）
sed -i "s|^database_id = .*|database_id = \"$d1_id\"|" wrangler.toml
grep -q "^database_id = \"$d1_id\"\$" wrangler.toml || { echo "::error::database_id 注入失败"; exit 1; }
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "d1_id=$d1_id" >> "$GITHUB_OUTPUT"; fi

# 资源表只保留「资源 / 说明」两列 —— 库 id、桶名不进 summary，防公开仓库泄露。
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### 本次部署用的资源"
    echo ""
    echo "| 资源 | 说明 |"
    echo "|---|---|"
    echo "| D1 | $([ "$created" = "true" ] && echo '**本次新建（历史为空）**' || echo '已存在，直接复用') |"
    echo "| R2 | 按名字寻址，不需要 id |"
    echo ""
    echo "> 想钉住到某个库（例如保护已有数据）：设仓库变量 \`D1_DATABASE_ID\` —— 它优先于按名解析，且 \`Sync fork\` 不会把它冲掉。"
  } >> "$GITHUB_STEP_SUMMARY"
fi
