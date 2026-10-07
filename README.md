# Betting League
A site where anyone can start an NFL betting league (play units) and run it their way: invite people with a link, set the rules, and let the site handle lines, grading, standings and the weekly minimum.

It grew out of a single-league site built for one league; this copy runs many leagues side by side, on its own repository and Supabase project. See `docs/MULTI_LEAGUE.md` for how leagues are kept apart.

Planning documents (from the single-league site, still the reference for betting, rules and grading):
- `HANDOFF.md`: context from the owner's local session
- `DECISIONS.md`: settled choices, newest first
- `docs/DESIGN.md`: the design proposal (architecture, rules engine, data model, pages)
- `SETUP.md`: one-time setup and deploy steps for the owner
- `docs/MULTI_LEAGUE.md`: what's shared between leagues and what each league keeps to itself

Development:
- `npm test`: rules, payout, job and placement tests
- `npm run db:start` then `npm run test:db`: database tests on a local Postgres
- `npm run dev:demo`: the site on sample data, no backend needed
- `npm run build:example`: the example league visitors can look around before starting one (`VITE_DEMO=public`), built into `web/dist/demo` after the site; the deploy publishes it at the site's `demo/`
