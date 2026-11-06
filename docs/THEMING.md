# Theming

The app's structure (type scale, spacing, radii, shadows, table and board patterns) follows one design system; its **colors** all come from CSS variables in one file. Rebranding is editing that file.

## Change the colors

Edit [`src/styles/theme.css`](../src/styles/theme.css). Components never use raw hex values, so nothing else needs to change.

| Variable | Used for |
| --- | --- |
| `--accent`, `--accent-hover`, `--accent-foreground` | Primary buttons, selected tabs, focus rings, the "mine" marker in tables, filled board stages |
| `--accent-soft`, `--accent-soft-foreground` | Active navigation, selected rows, soft chips |
| `--background`, `--canvas`, `--surface`, `--surface-sunken` | Page, app background, cards, inputs and columns |
| `--text-primary` … `--text-faint` | Titles, body, supporting copy, icons and placeholders |
| `--border`, `--border-strong`, `--ring` | Lines and focus |
| `--success`, `--warning`, `--error`, `--info`, `--neutral` (+ `-surface`, `-border`) | Status badges. Keep their meaning; adjust shades if needed |
| `--note-surface`, `--note-border` | The soft yellow behind a note's icon on a timeline |
| `--toast-success-icon` | The check in a success toast (it sits on a dark background) |

Example: a blue brand.

```css
:root {
  --accent: #2f629f;
  --accent-hover: #28548a;
  --accent-foreground: #ffffff;
  --accent-soft: #eef3fa;
  --accent-soft-foreground: #1f4677;
  --ring: #2f629f;
}
```

Check contrast: text on `--accent` should be at least 4.5:1, and don't fade the accent on hover (use a darker `--accent-hover`).

## Change the fonts

Fonts load in [`src/app/layout.tsx`](../src/app/layout.tsx) with `next/font` and are wired up as `--font-geist` / `--font-geist-mono`. Swap the import (any Google font, or `next/font/local` for your own files) and keep the variable names, or update `--font-sans` in `src/app/globals.css`.

## Change shapes and the type scale

`src/app/globals.css` holds the radii (`--radius-*`), shadows and the type scale utilities (`text-page-title`, `text-section`, `text-label`, `text-fine`, `text-table-header`).

## Emails

Emails don't use the app theme: email clients need inline styles. Their look comes from the **brand kit** in Settings → Email and brand (logo, button color, sender name, address, signature), so it can be changed without a deploy. The layout itself is in [`src/emails/layout.tsx`](../src/emails/layout.tsx).

## Keeping a private brand out of a public fork

If you deploy a public fork for your own company and don't want your colors in the public repo, keep `theme.css` neutral upstream and change it only in a private deployment branch (or a private fork that merges upstream). Everything else about your brand (logo, address, signature) already lives in the database.
