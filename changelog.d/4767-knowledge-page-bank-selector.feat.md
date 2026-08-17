- **memory: M7/W-2 — knowledge-page reads accept an operator-granted `bank_id` selector**

  The three shim-synthesized knowledge-page reads
  (`search_knowledge_pages` / `get_knowledge_page` / `get_knowledge_tree`)
  now carry an optional `bank_id` argument, so a dev agent can read a shared
  repo knowledge bank's curated pages instead of only its own. Omitted, every
  read still targets the agent's own bank (unchanged default). A named bank is
  honoured only when the operator has granted it — the grant set is rendered
  at apply from the same `memory.recall.additional_banks` that already fans the
  recall hook out to those banks, threaded to the shim as
  `HINDSIGHT_KNOWLEDGE_EXTRA_BANKS`; there is no tool-call path that widens it.
  An ungranted bank is rejected loudly at the shim layer before any network
  I/O, never silently coerced to the agent's own bank. Writes are unaffected:
  the directive tools carry no selector and stay own-pinned, and the
  knowledge surface remains GET-only.
