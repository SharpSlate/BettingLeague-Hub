# BettingLeague
NFL betting league site (play units): a commissioner-configurable replacement for the Splash Shares pool

Planning documents:
- `HANDOFF.md`: context from the owner's local session
- `DECISIONS.md`: settled choices, newest first
- `docs/DESIGN.md`: the design proposal (architecture, rules engine, data model, pages)
- `SETUP.md`: one-time setup and deploy steps for the owner

Development:
- `npm test`: rules, payout, job and placement tests
- `npm run db:start` then `npm run test:db`: database tests on a local Postgres
- `npm run dev:demo`: the site on sample data, no backend needed
