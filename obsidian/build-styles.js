// Writes obsidian/styles.css from obsidian/styles.src.css with the fonts in obsidian/fonts/ embedded, since Obsidian
// loads only a plugin's styles.css. Run with `node obsidian/build-styles.js` after editing styles.src.css.
const fs = require('fs')
const path = require('path')

const dir = __dirname
const FONTS = [
  { family: 'Inter', file: 'Inter.woff2', weight: '100 900', style: 'normal' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono.woff2', weight: '100 800', style: 'normal' },
  { family: 'Newsreader', file: 'Newsreader.woff2', weight: '200 800', style: 'normal' },
  { family: 'Newsreader', file: 'Newsreader-Italic.woff2', weight: '200 800', style: 'italic' },
]
const faces = FONTS.map(f => {
  const data = fs.readFileSync(path.join(dir, 'fonts', f.file)).toString('base64')
  return `@font-face { font-family: '${f.family}'; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; src: url(data:font/woff2;base64,${data}) format('woff2'); }`
}).join('\n')
const src = fs.readFileSync(path.join(dir, 'styles.src.css'), 'utf8')
const out = `/* Built by build-styles.js from styles.src.css: edit that file, not this one. The fonts are embedded (see fonts/README.md). */\n${faces}\n\n${src}`
fs.writeFileSync(path.join(dir, 'styles.css'), out)
console.log(`styles.css written: ${(out.length / 1024).toFixed(0)} KB, ${FONTS.length} fonts embedded`)
