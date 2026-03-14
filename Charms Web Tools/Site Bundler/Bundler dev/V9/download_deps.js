const https = require('https');
const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, 'lib');
const fontsDir = path.join(libDir, 'fonts');

if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });
if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true });

async function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
            const parsedUrl = new URL(url);
            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        return resolve(downloadFile(redirectUrl));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to get '${url}' (${res.statusCode})`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        resolve(rawData);
      });
    }).on('error', reject);
  });
}

async function downloadBinary(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let redirectUrl = res.headers.location;
            if (redirectUrl.startsWith('/')) {
                const parsedUrl = new URL(url);
                redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
            }
            return resolve(downloadBinary(redirectUrl, dest));
        }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to get '${url}' (${res.statusCode})`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', reject);
  });
}

const deps = [
    { url: 'https://esm.sh/clean-css@5.3.3?bundle', name: 'clean-css.js' },
    { url: 'https://esm.sh/html-minifier-terser@7.2.0?bundle', name: 'html-minifier-terser.js' },
    { url: 'https://esm.sh/terser@5.30.3?bundle', name: 'terser.js' },
    { url: 'https://esm.sh/acorn@8.11.3?bundle', name: 'acorn.js' },
    { url: 'https://esm.sh/acorn-walk@8.3.2?bundle', name: 'acorn-walk.js' }
];

async function main() {
  for (const dep of deps) {
    console.log(`Downloading ${dep.name}...`);
    try {
        const content = await downloadFile(dep.url);
        fs.writeFileSync(path.join(libDir, dep.name), content);
        console.log(`Saved ${dep.name}`);
    } catch (e) {
        console.error(`Failed to download ${dep.name}: ${e}`);
    }
  }

  console.log('Fetching Google Fonts CSS...');
  const fontsUrl = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;800&family=Space+Grotesk:wght@400;700&display=swap';
  let css = await downloadFile(fontsUrl);
  
  const urlRegex = /url\((https:\/\/[^)]+)\)/g;
  let match;
  let fontIndex = 0;
  
  while ((match = urlRegex.exec(css)) !== null) {
    const fontUrl = match[1];
    const fontExt = fontUrl.split('.').pop();
    const fontName = `font-${fontIndex}.${fontExt}`;
    console.log(`Downloading ${fontName} from ${fontUrl}...`);
    await downloadBinary(fontUrl, path.join(fontsDir, fontName));
    css = css.replace(fontUrl, `./fonts/${fontName}`);
    fontIndex++;
  }
  
  fs.writeFileSync(path.join(libDir, 'fonts.css'), css);
  console.log('Fonts downloaded.');
}

main().catch(console.error);
