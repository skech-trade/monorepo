# @skech/app

The trading screen.

```
/                    → /app
/app                 → /app/<the one listed market>
/app/[token]         the screen. Any other address is a 404.
```

`bun run dev` from here, or `bun run dev:app` from the repo root.

## What this is

An **interface**, and only that. Nothing is wired: no wallet, no contracts, no
feed. Every number comes from `src/lib/market.ts`, which generates a market, a
candle series, a book, a tape, positions, resting orders and fills from a seed
derived from the token address, so the same URL always draws the same chart.

`FEATURES.md` is the list of what the screen does. The rebuild was checked
against it.

## Layout

```
src/lib/           market.ts (mock data), indicators.ts, sketch.ts (the drawn
                   line as a trade), theme.ts (tokens for the canvas), mode.ts
src/components/ui  coss/ui, fetched from https://coss.com/ui/r and owned here
src/components/app the screen: app-bar, market-header, account-card, desk,
                   chart (lightweight-charts), chart-toolbar, order-book,
                   ticket, positions, controls, and draw/ for the Draw mode
```

## Draw and Desk

**Draw** is the default and the product: one chart, full width, with a bar
along its foot. Drag a line into the empty half, the bar reads it as where
you're aiming and where you're out, quotes "if it gets there" and "the most
you can lose" at the stake and leverage you pick, and one button draws it in.
Pen, Line and Points tools, Undo, Clear, and three quick Shapes sit above the
chart; the head of a drawn line is a handle. "Your lines" opens a side sheet. It plays out against a
simulated feed and settles on the same rule it was quoted on. Every line is
kept as a picture in "Your lines". **Desk** is the terminal: chart with
studies, book and tape, the full ticket, positions, every panel folding.

`src/lib/mode.ts` names the two. `src/components/app/terminal.tsx` switches.

## Design system

coss/ui, as shipped. `globals.css` is the `@coss/style` preset verbatim plus
four aliases a trading screen needs: `--up` and `--down` (the success and
destructive foregrounds, for figures), `--up-mark` and `--down-mark` (the
success and destructive fills, for candles), and `--brand` (info blue, the ink
the drawn line is in). Inter for text, Geist Mono for every figure through the
`figures` utility. Cards are coss Cards; every control is a coss component.
No custom type scale, no custom materials.

The chart draws to a canvas and cannot read a CSS variable, so
`src/lib/theme.ts` reads the tokens out of computed styles and flattens them
to sRGB on a 1x1 canvas. Alpha tokens are composited over white on the way.

## Known gaps

- The Draw feed is simulated, one candle a second. A real product has to say
  what the right edge of the chart means in minutes or hours.
- Draw caps "the most you can lose" at the stake. Desk's ticket says "wiped
  out at", a price rather than a promise, because its cross-margin model is
  not the isolated one Draw assumes. See `ui/landing/CONTENT.md`.
- Phone layouts work but are not tuned. Desk on a phone is a long scroll.
