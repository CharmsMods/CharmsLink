const fs = require('fs');
let html = fs.readFileSync('v9.html', 'utf8');

const regex = /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">[\s\S]*?rel="stylesheet">/;
html = html.replace(regex, '<link rel="stylesheet" href="lib/fonts.css">');

fs.writeFileSync('v9.html', html, 'utf8');
console.log('Replaced fonts in HTML.');
