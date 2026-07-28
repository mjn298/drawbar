# Historical (pre-F14-fix) `cr_ready()` bash predicate, verbatim.
#
# Provenance (re-verify against git history any time):
#   git show 2e60ee9d72d46b5d8eda473cd6298213f0cd7827:agents/drawbar-story-lead.md
# That is the commit that ported drawbar-story-lead.md into this plugin (PCO-347), BEFORE
# the PCO-349 fix replaced this `.state`-only predicate with a call into
# scripts/lib/coderabbit.ts. The block below is copied byte-for-byte out of that commit's
# `## 7. Drive it green` section — never retyped or reconstructed from memory (MUST-CHECK
# regression-guard-must-be-tested-against-the-real-historical-input).
#
# Pinned here as a fixture, rather than resolved live via `git show HEAD:...`, because HEAD
# moves: once the PCO-349 fix itself is committed, HEAD holds the FIXED agent file, and a
# `git show HEAD:...` lookup would silently start resolving to post-fix text instead of the
# text this regression test exists to reproduce.
cr_ready() {
  local head st
  head=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha' 2>/dev/null); [ -n "$head" ] || return 1
  st=$(gh api "repos/$REPO/commits/$head/statuses" \
       --jq 'map(select(.context=="CodeRabbit")) | first | .state // "none"' 2>/dev/null)
  case "$st" in success|failure|error) return 0 ;; *) return 1 ;; esac
}
