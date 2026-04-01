const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();

const entries = files.map(f => {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  return `${JSON.stringify(f)}: ${JSON.stringify(content)}`;
});

const js = `var MARKDOWN_CONTENT = {\n  ${entries.join(',\n  ')}\n};\n`;
fs.writeFileSync(path.join(dir, 'content.js'), js);
console.log(`Built content.js: ${files.length} files, ${Buffer.byteLength(js)} bytes`);
