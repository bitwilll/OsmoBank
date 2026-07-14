# OsmoBank logo

The mark is a four-pointed star inside a tilted Saturn ring. Star and ring are a
single ink colour; where the ring crosses the star the overlap is **knocked out
to transparent**, so it picks up whatever is behind it (white on light, dark on
dark) — the black/white "contrast at the intersection".

## Files

| File | Size | Use |
|------|------|-----|
| `osmobank-logo.svg` | scalable | **Primary.** Black mark, transparent knockout. For light backgrounds. |
| `osmobank-logo-white.svg` | scalable | White mark, transparent knockout. For dark backgrounds. |
| `osmobank-logo.png` | 512×480 | Raster of the black mark (transparent background). |
| `osmobank-logo-white.png` | 512×480 | Raster of the white mark (transparent background). |
| `favicon.svg` | scalable | Square favicon — ink mark with an opaque white knockout. |
| `favicon.png` | 64×64 | Raster favicon. |
| `favicon-32.png` | 32×32 | Classic small favicon. |
| `apple-touch-icon.png` | 180×180 | iOS home-screen / Apple touch icon. |

All PNGs are transparent (RGBA). Prefer the SVGs wherever scaling matters.

## Colours

- Ink: `#0a0a0a` (light-bg mark) / `#ffffff` (dark-bg mark)
- The live site tints the mark with its theme variables; these exported files use
  fixed colours so they work standalone (email, decks, print, README badges…).

## Favicon wiring (already live on the site)

The site embeds the favicon inline in `public/index.html`. To use these files
instead, drop them in `public/` and reference:

```html
<link rel="icon" href="/favicon.svg" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```
