# 0011 Renderer UI conventions for feature tabs

Date: 2026-07-09

## Status

Accepted

## Context

Three features shipped in quick succession — Linked Query (US-016), the Federated
tab and its Format button (US-017), and pluggable AI providers (US-018). Each was
correct in isolation, and each drifted from the app's existing look in a
different direction. Read side by side, the tabs did not appear to belong to the
same application:

- **Layout.** `QueryEditor` and `TableViewer` are full-height panes: a flush
  toolbar, then content that fills the remaining height. `FederatedQueryTab` and
  `LinkedQueryTab` were `overflow-y: auto` pages with `padding: 16`, so their
  results scrolled with the page instead of owning a pane. Switching tabs
  switched the app between an IDE and a web page.
- **Density.** The app is a desktop tool at `fontSize: 13` and uses
  `size="small"` controls throughout. The new tabs used default-size buttons and
  selects, which are ~8px taller per control.
- **Accent.** `theme.tsx` deliberately picks a teal accent that "stays clear of
  antd's default blue", then every tag in the app was written as
  `<Tag color="blue">`. antd's `blue` is a *preset palette* color and ignores
  `colorPrimary` entirely, so the accent the theme was built to avoid was on
  screen next to the accent it chose. `green` and `red` had the same problem.
- **Copy.** US-018 made the provider pluggable, but six user-facing strings still
  named Claude — including the error shown to a user who had configured OpenAI.

Nothing here was a bug in any one story. The drift came from each story styling
its own surface with inline values, with no written convention to conform to.

## Decision

Four conventions, enforced by shared code rather than review memory:

1. **A feature tab is a pane, not a page.** Root is
   `display: flex; flex-direction: column; height: 100%`. Actions live in a
   flush `.pg-toolbar` strip; results fill the remainder with `flex: 1;
   min-height: 0`. Only genuinely list-shaped content (the linked-query step
   chain) scrolls internally, below its toolbar.

2. **Toolbars are shared CSS, not inline style.** `.pg-toolbar`,
   `.pg-toolbar-meta`, `.pg-subbar`, `.pg-hint`, `.pg-mono` and `.pg-placeholder`
   live in `styles.css` beside the existing `.pg-*` primitives. Three copies of
   the same inline `padding: '6px 12px', borderBottom, display: 'flex'` object
   is how the toolbars diverged in the first place.

3. **Tags use antd status colors, never preset palette colors.** `processing`,
   `success`, `error` and `warning` resolve to `colorInfo` / `colorSuccess` /
   `colorError` / `colorWarning` (see `antd/es/tag/style/statusCmp.js`), so they
   track the theme in both light and dark mode. `blue`, `green`, `red` and
   `orange` are fixed palettes and must not be used.

4. **Provider-neutral AI copy.** No user-facing string names a specific model or
   vendor. The configured provider's label comes from `AI_PROVIDER_SPECS`.

Every SQL surface also binds `Mod-Enter` to run and `Shift-Alt-F` to format. A
tab that hosts a `SqlEditor` and cannot be run from the keyboard is a defect.

## Alternatives Considered

1. **Leave the tabs as scrolling pages and restyle only colors and sizes.**
   Cheaper, and it would have fixed the most obvious mismatch. Rejected because
   the layout model — whether results own a pane or scroll with the page — is
   the difference a user actually feels when switching tabs.

2. **Override antd's `blue` preset to the teal accent in `ConfigProvider`.**
   Would have fixed the color with one line and no call-site edits. Rejected: a
   `Tag` labelled `blue` that renders teal is a trap for the next reader, and the
   preset would still not track dark mode the way status colors do.

3. **Extract a `<FeatureTabShell>` component.** The cleanest expression of
   convention 1. Deferred — the three tabs' toolbars differ enough in content
   that the component would be mostly `children` slots today. Revisit if a
   fourth SQL surface appears.

## Consequences

Positive:

- The query, federated and linked tabs share one toolbar, one density, one
  accent, and one set of keyboard bindings.
- Federated results now fill the pane and scroll under a sticky header, instead
  of being capped at `maxBodyHeight: 360` inside a scrolling page.
- Tag colors follow the theme into dark mode, which the preset palettes did not.
- A user on OpenAI or a local model no longer reads an error naming Claude.

Tradeoffs:

- `FederatedQueryTab` and `LinkedQueryTab` no longer render `tab.title` in the
  pane; both take `_props`. The title is the tab bar's job. If either tab ever
  needs its model, the prop is still declared.
- `.pg-toolbar` sets `flex-wrap: wrap`. A narrow window now wraps the query
  editor's six buttons onto a second line, growing the toolbar, where previously
  they compressed. Wrapping was judged better than clipping.

## Follow-Up

- Manual UAT of all three tabs against a live Postgres pair is still pending; no
  DOM test environment is installed, so the change is covered by typecheck,
  build, and the existing 114 unit tests only.
- Reconsider `<FeatureTabShell>` if a fourth SQL surface lands.
