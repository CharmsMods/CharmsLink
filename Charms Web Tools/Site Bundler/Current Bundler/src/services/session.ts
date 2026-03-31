import type { AssetRecord, BuildConfig, SessionSnapshot } from "../types";

export const SESSION_VERSION = 1;

export const createSessionSnapshot = (
  assets: AssetRecord[],
  config: BuildConfig,
  activeAssetId?: string,
  entryHtmlId?: string
): SessionSnapshot => ({
  version: SESSION_VERSION,
  assets,
  config,
  activeAssetId,
  entryHtmlId
});

export const parseSessionSnapshot = (raw: string): SessionSnapshot => {
  const parsed = JSON.parse(raw) as SessionSnapshot | AssetRecord[];
  if (Array.isArray(parsed)) {
    return {
      version: SESSION_VERSION,
      assets: parsed,
      config: {
        mode: "inline",
        minifyHTML: true,
        minifyCSS: true,
        minifyJS: true,
        removeComments: true,
        dropConsole: true,
        zipDownloads: false,
        linkZipReferences: true,
        outputNames: {
          html: "index.min.html",
          css: "styles.min.css",
          js: "scripts.min.js"
        }
      }
    };
  }

  if (!parsed || !Array.isArray(parsed.assets) || !parsed.config) {
    throw new Error("Invalid session JSON.");
  }

  return parsed;
};
