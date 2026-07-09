# Validation

## Proof Strategy

Three things must be true before this story is done.

1. **The prompt holds.** A real provider, handed a raw multi-line Postgres error
   inside the user message, still returns JSON that `parseCheckResponse()` can
   parse. This is the one assumption the whole feature rests on, and no existing
   prompt takes an error string as input. It cannot be proven by a unit test —
   it needs a live call, recorded under `.spikes/`, before any bead is created.
2. **The safety extraction is behaviour-preserving.** The warning classifier
   moves to `src/shared/sql-statement.ts` as `isNonMutatingStatement`; the
   narrow C1 execution guard `isReadOnlyStatement` stays in `executor.ts`. Their
   accept surfaces differ **on purpose** and must keep differing.
   `duck-runner.ts`'s read-only guard must still reject exactly what it rejects
   today.
3. **Nothing runs by itself.** Applying a fix writes to the editor and stops.

### Proof Bar

```bash
npm run typecheck   # node + web
npm run test        # vitest
npm run build
```

**`npm run lint` is deliberately excluded.** It is declared in `package.json` as
`eslint src --ext .ts,.tsx`, but `eslint` is not installed — `node_modules/.bin`
has no such binary. `history/learnings/critical-patterns.md` records this exact
trap: *"Never promise a check the repo can't perform."* Re-verify with
`ls node_modules/.bin | grep eslint` before trusting any claim that lint passed.

Renderer behavior is **unprovable by unit test** here — there is no component
test harness, and vitest covers pure functions only. `QueryEditor` changes are
proven by typecheck + build + manual UAT. Any logic worth testing must therefore
be pushed into a pure module (`sql-statement.ts`, `parseCheckResponse`).

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | `isNonMutatingStatement` from `@shared/sql-statement`: `SELECT 1`, leading whitespace/lowercase, `WITH cte AS (...) SELECT`, trailing `;`, leading comments, keyword hidden in a string literal; `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`ALTER` ⇒ false. **`TABLE t` and `VALUES (1)` ⇒ true.** |
| Unit | **Divergence guard (mutation-checked).** Assert in the same run that `isReadOnlyStatement('TABLE t') === false` (guard, C1) and `isNonMutatingStatement('TABLE t') === true` (classifier). The suite must fail if the two are ever collapsed into one function. Same discipline as US-016's `MAX_KEY_VALUES === LINKED_STEP_ROW_LIMIT` assertion. |
| Unit | `parseCheckResponse` against troubleshoot-shaped responses: valid JSON with `fixedSql`; valid JSON **without** `fixedSql` (⇒ `fixedSql === undefined`, the D4 path); JSON wrapped in a ```` ```json ```` fence; `fixedSql` itself fenced; unparseable prose ⇒ `{ok:false, summary:<raw>}` rather than a throw. **Requires exporting `parseCheckResponse` — it is module-private today (`client.ts:79`), so this test cannot exist until that one-word change lands.** Importing `client.ts` under vitest is safe: `providers.test.ts` already imports the module that pulls in both provider SDKs and passes 12/12. |
| Unit | Mutation check: assert the troubleshoot handler rejects an empty `sql` **and** an empty `errorMessage` before calling the provider. The test must fail if either guard is removed. |
| Integration | `ai:troubleshoot-sql` with an unconfigured provider ⇒ `{ error: 'NO_API_KEY' }`, no provider call attempted. |
| Integration | **V1 (live, blocking).** Against a real database and a real provider: run `SELECT id, emai FROM users`, capture the actual driver error, send it. Assert the response parses, `fixedSql` is present, and it names `email`. Record the transcript under `.spikes/troubleshoot-sql-live-call.md`. Precedent: `.spikes/ai-sql-generation-claude-call.md`. |
| Integration | **V2 (live).** Disconnect the pool, run anything, troubleshoot the resulting `Not connected` error. Assert the response parses and `fixedSql` is **absent** — proving D4 falls out of the optional field rather than a renderer classifier. |
| E2E | None. No E2E harness exists in this repo. Do not claim one. |
| Platform | Electron desktop only. Confirm `debugLogPrompt` is a no-op under `app.isPackaged` so the user's SQL never reaches a packaged console. |
| Performance | Not measured. Out of scope; the call is user-initiated and one-shot. |
| Logs/Audit | No audit record is written. Confirm no API key, connection string, or password appears in any `debugLogPrompt` output. |

## Manual UAT

Against a live Postgres connection with a configured provider:

1. Run `SELECT id, emai FROM users`. Error appears. Troubleshoot icon is visible.
2. Click it. A diagnosis names the `email` column; a corrected statement appears.
3. Click `Apply suggested fix`. The editor now holds the corrected SQL and
   **nothing has run** — the result grid still shows the previous state.
4. Press Run. It succeeds.
5. Clear the editor, type `DROP TABLE users;`, run it against a table you can
   afford to lose *or* point at a role without `DROP` rights. Troubleshoot the
   resulting error. If a `fixedSql` comes back that is not a `SELECT`, applying
   it **must** raise the non-`SELECT` warning before Run is possible.
6. Disconnect the connection. Run anything. The troubleshoot icon is still shown
   (D4). Click it. A diagnosis appears with **no** Apply button.
7. Clear the API key in Settings. Troubleshoot. The app routes to Settings rather
   than showing a raw error.

## Fixtures

- A Postgres database with a `users` table having an `email` column, so
  `emai` is a deterministic typo with exactly one plausible correction.
- A configured AI provider. V1/V2 are live calls: they cost tokens and require a
  key. They cannot run in CI and must not be added to the `npm run test` gate.
- A pooled connection that can be disconnected on demand, for V2 and UAT step 6.

## Disclosure Obligation

The failing SQL is sent to the provider verbatim, so **literals the user typed**
(`WHERE email = 'a@b.com'`) leave the machine. D3 forbids sending row values from
*results*; it cannot prevent the user's own statement from containing data.
`ai:check-sql` already has this property. Decision `0012` must state it in one
sentence so the behavior is recorded rather than discovered.
