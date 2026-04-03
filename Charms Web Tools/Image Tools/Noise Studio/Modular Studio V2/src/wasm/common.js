function now() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function normalizeError(error) {
    return error?.message || String(error) || 'Unknown WASM runtime error.';
}

function ensureFactory(imported, label, selection) {
    const factory = imported?.default || imported;
    if (typeof factory !== 'function') {
        throw new Error(`${label} ${selection} module did not export a default factory function.`);
    }
    return factory;
}

function applyModuleSearchParams(sourceUrl, targetUrl) {
    if (!(sourceUrl instanceof URL) || !(targetUrl instanceof URL)) return targetUrl;
    sourceUrl.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
    });
    return targetUrl;
}

export function validateEmscriptenExports(module, required = [], label = 'WASM module') {
    const missing = required.filter((name) => typeof module?.[name] !== 'function');
    if (missing.length) {
        throw new Error(`${label} is missing required exports: ${missing.join(', ')}.`);
    }
    return module;
}

export function createOptionalEmscriptenRuntimeManager({ label, variants = [], createApi, validateApi = null }) {
    const cache = new Map();

    return async function loadRuntime(options = {}) {
        const preferSimd = !!options.preferSimd;
        const cacheKey = preferSimd ? 'prefer-simd' : 'prefer-baseline';
        if (cache.has(cacheKey)) {
            return cache.get(cacheKey);
        }

        const runtimePromise = (async () => {
            const orderedVariants = preferSimd
                ? [
                    ...variants.filter((entry) => entry.selection === 'simd'),
                    ...variants.filter((entry) => entry.selection !== 'simd')
                ]
                : [...variants.filter((entry) => entry.selection !== 'simd'), ...variants.filter((entry) => entry.selection === 'simd')];
            const reasons = [];

            for (const variant of orderedVariants) {
                const moduleUrl = variant?.moduleUrl;
                if (!(moduleUrl instanceof URL)) continue;
                const startedAt = now();
                try {
                    const imported = await import(moduleUrl.href);
                    const factory = ensureFactory(imported, label, variant.selection);
                    const baseUrl = new URL('.', moduleUrl.href);
                    const module = await factory({
                        locateFile(path) {
                            const nextUrl = new URL(path, baseUrl);
                            applyModuleSearchParams(moduleUrl, nextUrl);
                            return nextUrl.href;
                        }
                    });
                    const api = createApi(module, variant.selection);
                    if (typeof validateApi === 'function') {
                        await validateApi(api, {
                            label,
                            selection: variant.selection
                        });
                    }
                    return {
                        ok: true,
                        selection: variant.selection,
                        initMs: Math.max(0, now() - startedAt),
                        api
                    };
                } catch (error) {
                    reasons.push(`${variant.selection}: ${normalizeError(error)}`);
                }
            }

            return {
                ok: false,
                selection: 'js-fallback',
                initMs: 0,
                reason: reasons.join(' | ') || `${label} artifacts could not be loaded.`
            };
        })();

        cache.set(cacheKey, runtimePromise);
        return runtimePromise;
    };
}
