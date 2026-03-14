const isExternalRef = (val) => val.startsWith('http://') || val.startsWith('https://') || val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('//');
const looksLikeAssetPath = (val) => {
if (!val) return false;
if (val.length > 300) return false;
if (val.trim() !== val) return false;
if (val.includes('\n') || val.includes('\r')) return false;
const commonExts = /\.(js|css|html|htm|json|png|jpg|jpeg|gif|svg|webp|avif|ico|mp4|webm|mp3|wav|ogg|ttf|woff|woff2|eot)$/i;
if (commonExts.test(val)) return true;
if (val.startsWith('./') || val.startsWith('../') || val.startsWith('/')) return true;
if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/.test(val)) return true;
return false;
};
const resolveReferenceReplacement = (val) => val;

const rewriteJsReferences = (js = "", sourceAssetId, outputPathMap, assetIndex) => {
    if (!js) return "";
    let result = '';
    for (let i = 0; i < js.length; i++) {
        const char = js[i];
        if (char === "'" || char === '"' || char === '`') {
            const quote = char;
            let stringContent = '';
            let isEscaped = false;
            let j = i + 1;
            for (; j < js.length; j++) {
                const nextChar = js[j];
                if (isEscaped) {
                    stringContent += '\\' + nextChar;
                    isEscaped = false;
                } else if (nextChar === '\\') {
                    isEscaped = true;
                } else if (nextChar === quote) {
                    break;
                } else {
                    stringContent += nextChar;
                }
            }
            if (j < js.length) {
                let processedContent = stringContent;
                if (stringContent && !stringContent.includes('${') && looksLikeAssetPath(stringContent) && !isExternalRef(stringContent)) {
                    const newValue = resolveReferenceReplacement(stringContent, sourceAssetId, outputPathMap, assetIndex);
                    if (newValue !== stringContent) {
                        processedContent = newValue;
                    }
                }
                result += quote + processedContent + quote;
                i = j;
                continue;
            }
        }
        result += char;
    }
    return result;
};

const testCode = `
var a = "hello";
let b = 'don\\'t break me';
// don't
let c = 'hello';
function f() { return "escaped\\\\\\\"quote"; }
`;
console.log(rewriteJsReferences(testCode));
