# MET visual system

This file is the design contract for every MET page. It exists to prevent individual pages or later contributors from drifting into unrelated styles.

## Identity
- MET uses a warm stone-and-paper light theme and a deep slate/navy dark theme.
- The single brand accent is muted copper. Navy is reserved for the primary navigation and primary actions.
- Green, amber, red and blue are semantic states only. They are not decorative accents.
- Division pages share the MET palette. A division name or logo may identify the section, but it must not recolour the application.

## Typography
- IBM Plex Sans is the interface face.
- IBM Plex Serif is reserved for page titles, section titles and key numeric figures.
- IBM Plex Mono is reserved for identifiers and genuinely tabular data.
- Do not add another font family or load a second font set on individual pages.
- Avoid all-caps micro-labels as a default. Use sentence case and readable sizes.

## Surfaces and layout
- Use the shared full-height navigation rail, separate utility bar and aligned page content.
- Prefer clear page hierarchy and intentional asymmetry over equal-weight card grids.
- Use a small, fixed radius scale: 3, 5, 8 and 11px.
- Panels are flat surfaces with one quiet border. Do not use glassmorphism, blur, neon, gradients, glow, noise, scanlines or decorative background grids.
- Tables, forms, modal headers, empty states and loading states must use the same tokens as the surrounding page.
- Use the semantic CSS variables in met.css; do not hardcode page-specific hex colours.

## Motion
- Motion should explain a state change or make navigation feel responsive.
- Use short transitions and small movement. No perpetual motion, pulsing status marks or large hover lifts.
- Respect prefers-reduced-motion.

## Explicit prohibitions
- No green dots, status dots, decorative bullets beside panel titles, live indicators or glowing dots.
- No purple/blue gradient heroes, gradient text, glass cards, excessive rounded pills or default three-card feature grids.
- No decorative icons that do not communicate an action or category.
- No repeated eyebrow labels, filler subtitles, marketing slogans or copy that explains obvious controls.
- No per-division colour themes that fragment the product.

## Review checklist
- Check dashboard, profile, sign-in, every division view, forms, modals, empty/loading/error states and mobile navigation.
- Check both light and dark themes.
- Check that every status remains understandable without a coloured dot.
- Check keyboard focus and reduced-motion behaviour.
