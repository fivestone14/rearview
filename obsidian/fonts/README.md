# Fonts

Rearview's views are set in Inter, JetBrains Mono and Newsreader, which most computers do not have. Obsidian loads a
plugin's `styles.css` and nothing else, so the fonts are embedded in it: `node obsidian/build-styles.js` writes
`obsidian/styles.css` from `obsidian/styles.src.css`, inlining these files as data URIs. Edit `styles.src.css`,
never `styles.css`.

All four are the Latin subsets of the variable fonts served by Google Fonts, under the SIL Open Font License 1.1:

- `Inter.woff2` — Inter, weights 100–900. © The Inter Project Authors.
- `JetBrainsMono.woff2` — JetBrains Mono, weights 100–800. © The JetBrains Mono Project Authors.
- `Newsreader.woff2`, `Newsreader-Italic.woff2` — Newsreader, weights 200–800, optical sizes 6–72. © Production Type.
