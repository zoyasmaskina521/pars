# Project agent rules

- Do not make risky assumptions about site UI or payloads; inspect first and document uncertainties.
- Clarify critical unknowns before implementing brittle logic.
- Run lint, typecheck, and tests after significant changes.
- Never hardcode credentials, tokens, or secrets in source code.
- Keep payload compatibility with n8n Workflow A.
- Document unstable selectors/endpoints and fallbacks in README.
- Do not implement anti-bot bypasses; handle challenge states with safe fallback and auto-recovery.
