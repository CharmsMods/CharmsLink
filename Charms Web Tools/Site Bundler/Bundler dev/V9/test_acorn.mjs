import fs from 'fs';
import * as acorn from './lib/acorn.js';

const checkDir = (dir) => {
    const files = fs.readdirSync(dir);
    for (const f of files) {
        if (!f.endsWith('.js')) continue;
        const code = fs.readFileSync(dir + '/' + f, 'utf8');
        try {
            acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
            console.log(dir + '/' + f, 'parse ok');
        } catch (e) {
            console.error(dir + '/' + f, 'PARSE ERROR:', e.message);
        }
    }
};

checkDir('.');
checkDir('./lib');
