#!/usr/bin/env bash
# 让 Bitori 基于一个 benchmark Issue 尝试修复。只产出 draft PR，永不自动合并。
set -euo pipefail

issue_number="${1:?用法：auto-improve.sh <issue-number>}"
branch="auto/bench-${issue_number}-$(date +%s)"
git config user.name "bitori-bot"
git config user.email "163719835+kikoiio@users.noreply.github.com"
git checkout -b "$branch"

# 基线必须先绿，否则修复无从比较。
npm run typecheck

prompt="$(gh issue view "$issue_number" --json title,body --jq '.title + "\n\n" + .body')"

# 安全边界：让 agent 只改 src/，并在事后用 git diff 复核。
instructions="$prompt

你是 Bitori 的维护 agent。请修复上述 benchmark 暴露的问题。
约束：
1. 只允许修改 src/ 目录下的源码。
2. 禁止修改 benchmarks/、tests/、.github/、docs/。
3. 优先考虑系统提示词（src/prompt/sections.ts）或对应工具实现的最小修复。
4. 修改后运行 npm run typecheck 验证。
"

set +e
node dist/bin/bitori.js exec \
  --profile bench \
  --workspace "$PWD" \
  --max-iterations 12 \
  --json <<< "$instructions"
exec_status=$?
set -e

# 复核 agent 没碰禁区；碰了就放弃本轮（不撤销，留 PR 里供检视）。
violations=$(git status --porcelain -- benchmarks tests .github docs || true)
if [ -n "$violations" ]; then
  echo "::error::auto-improve 触碰了禁止目录，放弃本轮"
  exit 1
fi

if git diff --quiet; then
  echo "::notice::agent 未产生改动，跳过 PR"
  exit 0
fi

npm run typecheck
git add src
git commit -m "Attempt fix for benchmark issue #${issue_number}"
git push -u origin "$branch"
gh pr create \
  --draft \
  --title "[auto-improve] Fix benchmark #${issue_number}" \
  --body "由 benchmark Issue #$issue_number 自动生成。

- 修复 agent：Bitori（本仓库 exec 模式）
- 上游 Issue：#$issue_number
- 状态：draft，等待人工审查；CI 会自动跑定向验证

**审查要点**：确认修复真实解决 Issue 中的失败模式，而不是绕过任务约束。" \
  --base master \
  --head "$branch"
