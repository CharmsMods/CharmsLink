const https = require('https');
const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, 'lib');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to get '${url}' (${res.statusCode})`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

(async () => {
    try {
        await download('https://unpkg.com/acorn@8.11.3/dist/acorn.mjs', path.join(libDir, 'acorn.js'));
        console.log('Downloaded acorn.mjs to acorn.js');
        await download('https://unpkg.com/acorn-walk@8.3.2/dist/walk.mjs', path.join(libDir, 'acorn-walk.js'));
        console.log('Downloaded walk.mjs to acorn-walk.js');
    } catch(e) {
        console.error(e);
    }
})();
