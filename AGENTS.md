# PitLore — agent notes

开始工作前先读 `docs/STATUS.md`，并用实时 Git/CI 核对其中的日期快照；需要理解
已接受边界时读 `docs/DECISIONS.md`，需要完整产品范围时读 `docs/PRD.md`。
Phase 1 的每日证据、candidate 决策和摩擦统一记录在 `docs/DOGFOOD.md`。

When working in this repository or any project that depends on PitLore:

1. Before implementing non-trivial code, call **`pitlore_retrieve`** (or CLI `pitlore retrieve`) with intent + files.
2. Before claiming done, run **`pitlore_check`** on changed sources when patterns exist.
3. After fixing a real bug, **`pitlore_remember`** a candidate lesson; an LLM may record
   an advisory **`pitlore_review`**, but only humans approve, reject, or deprecate.
4. For real dogfood, preserve `observed_catalog_hash` from retrieve/check; after a human
   judges the result, use CLI `pitlore evidence record` before the approved catalog changes.
   Agents do not grade their own usefulness, and there is no MCP evidence writer.

Do not commit secrets. Prefer abstract lessons over pasting proprietary code into lore.
