import type { AssetRecord, ReferenceGraphEntry, ReferenceScanResult } from "../types";
import {
  getBasename,
  getDirname,
  isExternalRef,
  looksLikeAssetPath,
  normalizePath,
  resolveRelativePath,
  stripLeadingRelative,
  stripQueryHash
} from "../utils/path-utils";

const extractCssReferences = (css = "") => {
  const refs: Array<{ raw: string; kind: string }> = [];
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = urlRegex.exec(css)) !== null) {
    refs.push({ raw: match[2], kind: "CSS url()" });
  }

  const importRegex = /@import\s+(?:url\()?\s*(['"]?)([^'")]+)\1\s*\)?/gi;
  while ((match = importRegex.exec(css)) !== null) {
    refs.push({ raw: match[2], kind: "CSS @import" });
  }

  return refs;
};

const extractJsReferences = (js = "") => {
  const refs: Array<{ raw: string; kind: string }> = [];
  const stringRegex = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null = null;
  while ((match = stringRegex.exec(js)) !== null) {
    const raw = match[2];
    if (!raw || raw.includes("${") || !looksLikeAssetPath(raw)) continue;
    refs.push({ raw, kind: "JS string" });
  }
  return refs;
};

const extractHtmlReferences = (html = "") => {
  const refs: Array<{ raw: string; kind: string }> = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const attrs = [
    "src",
    "href",
    "poster",
    "content",
    "data-src",
    "data-href",
    "data-bg",
    "data-background",
    "data-image",
    "data-video",
    "data-audio"
  ];

  doc.querySelectorAll("*").forEach((element) => {
    attrs.forEach((attr) => {
      const value = element.getAttribute(attr);
      if (value && looksLikeAssetPath(value)) {
        refs.push({ raw: value, kind: `HTML ${attr}` });
      }
    });

    const srcset = element.getAttribute("srcset");
    if (srcset) {
      srcset.split(",").forEach((part) => {
        const [url] = part.trim().split(/\s+/);
        if (url && looksLikeAssetPath(url)) {
          refs.push({ raw: url, kind: "HTML srcset" });
        }
      });
    }

    const style = element.getAttribute("style");
    if (style) {
      extractCssReferences(style).forEach((ref) => refs.push({ raw: ref.raw, kind: `HTML inline style (${ref.kind})` }));
    }
  });

  doc.querySelectorAll("style").forEach((styleTag) => {
    extractCssReferences(styleTag.textContent ?? "").forEach((ref) =>
      refs.push({ raw: ref.raw, kind: `HTML style tag (${ref.kind})` })
    );
  });

  doc.querySelectorAll("script:not([src])").forEach((scriptTag) => {
    extractJsReferences(scriptTag.textContent ?? "").forEach((ref) =>
      refs.push({ raw: ref.raw, kind: `HTML inline script (${ref.kind})` })
    );
  });

  return refs;
};

const collectRawReferences = (asset: AssetRecord) => {
  if (!asset.textContent) return [];
  if (asset.kind === "html") return extractHtmlReferences(asset.textContent);
  if (asset.kind === "css") return extractCssReferences(asset.textContent);
  if (asset.kind === "js") return extractJsReferences(asset.textContent);
  return [];
};

const normalizeReference = (raw = "") => {
  const trimmed = raw.trim();
  if (!trimmed || isExternalRef(trimmed)) return "";
  return normalizePath(stripQueryHash(trimmed));
};

export const collectReferenceGraph = (assets: AssetRecord[]): ReferenceScanResult => {
  const byPath = new Map<string, AssetRecord>();
  const byBasename = new Map<string, AssetRecord[]>();
  const references: ReferenceGraphEntry[] = [];
  const warnings: string[] = [];
  const usedAssetIds = new Set<string>();
  const missingReferences: ReferenceGraphEntry[] = [];
  const ambiguousReferences: ReferenceGraphEntry[] = [];

  assets.forEach((asset) => {
    const normalizedPath = normalizePath(asset.path || asset.name);
    byPath.set(normalizedPath, asset);
    const basename = getBasename(normalizedPath);
    const list = byBasename.get(basename) ?? [];
    list.push(asset);
    byBasename.set(basename, list);
  });

  assets.forEach((asset) => {
    collectRawReferences(asset).forEach((ref) => {
      const normalizedRef = normalizeReference(ref.raw);
      if (!normalizedRef) return;

      const sourcePath = normalizePath(asset.path || asset.name);
      const relativeCandidate = resolveRelativePath(sourcePath, normalizedRef);
      const exactCandidate = normalizedRef;
      const strippedCandidate = stripLeadingRelative(normalizedRef);
      const basename = getBasename(normalizedRef);

      let resolvedAsset: AssetRecord | undefined;
      let resolutionType: ReferenceGraphEntry["resolutionType"] = "missing";
      let warning: string | undefined;

      if (byPath.has(relativeCandidate)) {
        resolvedAsset = byPath.get(relativeCandidate);
        resolutionType = "relative";
      } else if (byPath.has(exactCandidate)) {
        resolvedAsset = byPath.get(exactCandidate);
        resolutionType = "exact";
      } else if (strippedCandidate && byPath.has(strippedCandidate)) {
        resolvedAsset = byPath.get(strippedCandidate);
        resolutionType = "stripped";
      } else {
        const basenameMatches = basename ? byBasename.get(basename) ?? [] : [];
        if (basenameMatches.length === 1) {
          resolvedAsset = basenameMatches[0];
          resolutionType = "basename";
          warning = `Resolved ${ref.raw} by basename fallback.`;
        } else if (basenameMatches.length > 1) {
          resolutionType = "ambiguous";
          warning = `Ambiguous basename match for ${ref.raw}.`;
        }
      }

      const entry: ReferenceGraphEntry = {
        sourceAssetId: asset.id,
        sourcePath,
        rawRef: ref.raw,
        normalizedRef,
        resolvedAssetId: resolvedAsset?.id,
        resolutionType,
        warning,
        kind: ref.kind
      };

      references.push(entry);

      if (resolvedAsset) {
        usedAssetIds.add(resolvedAsset.id);
      } else if (resolutionType === "ambiguous") {
        ambiguousReferences.push(entry);
        warnings.push(warning ?? `Ambiguous reference ${ref.raw}`);
      } else {
        missingReferences.push(entry);
      }
    });
  });

  return {
    references,
    warnings,
    usedAssetIds,
    missingReferences,
    ambiguousReferences
  };
};
