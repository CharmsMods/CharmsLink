export const APP_ASSET_VERSION = '2026-04-02-wasm-finalization-2';

export function createVersionedAssetUrl(relativePath, baseUrl) {
    const url = new URL(relativePath, baseUrl);
    url.searchParams.set('v', APP_ASSET_VERSION);
    return url;
}

export function withAssetVersion(urlLike) {
    const url = urlLike instanceof URL
        ? new URL(urlLike.href)
        : new URL(String(urlLike));
    url.searchParams.set('v', APP_ASSET_VERSION);
    return url;
}
