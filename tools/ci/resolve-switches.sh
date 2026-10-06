#!/usr/bin/env bash
# 把「仓库变量（Settings → Secrets and variables → Actions → Variables）」解析成**有效的部署开关**，
# 供后续 Deploy Worker 步骤使用。见 .github/workflows/deploy.yml 的 Resolve deploy switches 步骤。
#
# 三个要点：
#   ① 默认值兜底：变量没配时用 wrangler.toml 里的默认语义——绝不能把空串绑给 Worker（那会覆盖掉
#      配置里的默认值，wrangler-action 的 vars 输入按名取值）。
#   ② 取值校验：布尔只接受 true/false、整数只接受非负且不超量级，写错了当场红；否则会"静默按默认值跑"。
#   ③ 变量值经 env 传入（IN_*）、结果写入 GITHUB_ENV 与 GITHUB_OUTPUT，都不拼进脚本文本。
set -euo pipefail

# 名称 值
emit() {
  echo "$1=$2" >> "$GITHUB_ENV"
  echo "$1=$2" >> "$GITHUB_OUTPUT"
}
# 名称 原始值
note() {
  if [ -z "${2:-}" ]; then echo "（未配置，用默认值）"; else echo "（来自仓库变量）"; fi
}

# 名称 原始值 默认值
resolve_bool() {
  local name="$1" raw="${2:-}" default="$3"
  if [ -z "$raw" ]; then raw="$default"; fi
  case "$raw" in
    true|false) ;;
    *) echo "::error::仓库变量 $name 只能是 true 或 false（当前 '$raw'）"; exit 1 ;;
  esac
  emit "$name" "$raw"
  echo "开关 $name = $raw $(note "$name" "${2:-}")"
}

# 名称 原始值 默认值 下限 上限
resolve_int() {
  local name="$1" raw="${2:-}" default="$3" min="$4" max="$5"
  if [ -z "$raw" ]; then raw="$default"; fi
  case "$raw" in
    ''|*[!0-9]*) echo "::error::仓库变量 $name 必须是非负整数（当前 '$raw'）"; exit 1 ;;
  esac
  if [ "$raw" -lt "$min" ] || [ "$raw" -gt "$max" ]; then
    echo "::error::仓库变量 $name = $raw 超出允许范围 $min..$max"
    exit 1
  fi
  emit "$name" "$raw"
  echo "开关 $name = $raw $(note "$name" "${2:-}")"
}

# 界面开关默认**开**（与 wrangler.toml 的默认值一致）
resolve_bool UI_ENABLED "${IN_UI_ENABLED:-}" true
# 弱凭据硬失败默认**关**：线上当前用的就是文档化默认口令，置 true 会 fail-closed 直接切断同步
resolve_bool ENFORCE_STRONG_CREDENTIALS "${IN_ENFORCE_STRONG_CREDENTIALS:-}" false
# 历史保留策略：与 wrangler.toml 的默认一致（1000 条 / 0 = 不限制保留时长，对齐上游 3.3.0）。
# 下限**必须是 0**：两项的上游语义都是「0 = 不限制」，而 resolve_int 对越界值是硬失败（exit 1），
# 下界写 1 会让「把保留期设成 0（关闭按时间清理）」这个合法配置直接把部署打红。
resolve_int MAX_SAVED_HISTORY_COUNT "${IN_MAX_SAVED_HISTORY_COUNT:-}" 1000 0 1000000
resolve_int HISTORY_RETENTION_MINUTES "${IN_HISTORY_RETENTION_MINUTES:-}" 0 0 5256000
# 请求体上限：默认 48MiB，允许 256KiB..64MiB（isolate 128MiB 被并发共享，默认贴着"实际会发生的大小"取）。
resolve_int MAX_REQUEST_BODY_BYTES "${IN_MAX_REQUEST_BODY_BYTES:-}" 50331648 262144 67108864
# 限速四参数：默认 15min / 10 次 / 15min / 50。**不建议改**，这里的范围校验只为拦住手滑写错的量级；
# 运行期对越界值另有"回落默认"的兜底。
resolve_int AUTH_RATE_LIMIT_WINDOW_MS "${IN_AUTH_RATE_LIMIT_WINDOW_MS:-}" 900000 60000 86400000
resolve_int AUTH_RATE_LIMIT_MAX_FAILURES "${IN_AUTH_RATE_LIMIT_MAX_FAILURES:-}" 10 3 100
resolve_int AUTH_RATE_LIMIT_BLOCK_MS "${IN_AUTH_RATE_LIMIT_BLOCK_MS:-}" 900000 60000 86400000
resolve_int AUTH_RATE_LIMIT_BURST_WARN "${IN_AUTH_RATE_LIMIT_BURST_WARN:-}" 50 10 10000
