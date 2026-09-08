# CouchSet brand assets

- `couchset-logo.svg`: approved dark monochrome mark.
- `couchset-logo-light.svg`: approved light monochrome mark.
- `couchset-hero.webp`: approved red hero, also referenced by the repository README.
- `couchset-mascot.webp`: red mascot with real transparency.

The logo geometry is shared by the navigation mark and the icons in `app/`.
`app/icon.svg` follows the browser's color scheme; `app/favicon.ico` provides
16/32/48 px fallbacks on a white background. `app/apple-icon.png` is 180 px.
Next.js discovers these files and supplies their metadata links automatically.

Artwork was generated with the built-in image-generation tool, then compressed
to WebP. The mascot's original checkerboard was replaced using this edit prompt:

> Background extraction edit. Preserve this exact red couch mascot, every contour, fabric texture, pose, face, gray pillows and feet. Remove the entire baked-in gray-and-white checkerboard background. Output a real transparent PNG with alpha zero outside the mascot, not a picture of a checkerboard. No shadow, no white backdrop, no glow. The character itself must remain unchanged. Full character, same framing.

The monochrome logos were not recolored. Documentation content and existing
social-preview images are unchanged by this branding pass.
