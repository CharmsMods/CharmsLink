import type { AssetRecord, BuildArtifact, BuildConfig, BuildResult } from "../../types";
import { assetByteSize, binaryToDataUrl } from "../../utils/binary";
import {
  getBasename,
  getDirname,
  getRelativePath,
  isExternalRef,
  looksLikeAssetPath,
  normalizePath,
  splitRefParts
} from "../../utils/path-utils";

const ARTIFACT_TEXT_KIND = new Set(["html", "css", "js", "json", "map", "webmanifest", "text", "xml"]);

const cloneAssetWithText = (asset: AssetRecord, textContent?: string): AssetRecord => {
  if (textContent === undefined) return asset;
  return {
    ...asset,
    textContent,
    size: new Blob([textContent]).size
  };
};

export const createVirtualEntryAsset = (mode: BuildConfig["mode"]): AssetRecord => {
  const textContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Generated ${mode} bundle</title>
</head>
<body>
  <main id="app"></main>
</body>
</html>`;

  return {
    id: `generated-entry-${mode}`,
    kind: "html",
    name: "index.generated.html",
    path: "index.generated.html",
    mime: "text/html",
    source: "generated",
    size: new Blob([textContent]).size,
    textContent
  };
};

const injectIntoHead = (html: string, block: string) => {
  if (!html) return block;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}\n</head>`);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, (match) => `${block}\n${match}`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${block}\n</html>`);
  return `${html}\n${block}`;
};

const injectBeforeBodyEnd = (html: string, block: string) => {
  if (!html) return block;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${block}\n</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${block}\n</html>`);
  return `${html}\n${block}`;
};

const stripLocalAssetTags = (html: string) => {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script[src]").forEach((scriptTag) => {
    const src = scriptTag.getAttribute("src") ?? "";
    if (!isExternalRef(src)) scriptTag.remove();
  });
  doc.querySelectorAll("link[rel]").forEach((linkTag) => {
    const rel = (linkTag.getAttribute("rel") ?? "").toLowerCase();
    const href = linkTag.getAttribute("href") ?? "";
    if (rel.includes("stylesheet") && !isExternalRef(href)) {
      linkTag.remove();
    }
  });
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
};

const createArtifact = (
  path: string,
  mime: string,
  payload: { textContent?: string; binaryContent?: string },
  assetId?: string
): BuildArtifact => {
  const name = getBasename(path) || path;
  return {
    id: `${assetId ?? "artifact"}:${path}`,
    assetId,
    kind: payload.binaryContent ? "binary" : (mime.includes("html") ? "html" : mime.includes("css") ? "css" : mime.includes("javascript") ? "js" : "other"),
    name,
    path,
    mime,
    textContent: payload.textContent,
    binaryContent: payload.binaryContent,
    size: payload.binaryContent ? assetByteSize({ size: 0, binaryContent: payload.binaryContent }) : new Blob([payload.textContent ?? ""]).size
  };
};

const resolveReplacementPath = (
  raw: string,
  sourcePath: string,
  outputPath: string,
  emittedPaths: Map<string, string>,
  assetIndex: Map<string, AssetRecord>
) => {
  if (!raw || isExternalRef(raw) || !looksLikeAssetPath(raw)) return raw;
  const { base, suffix } = splitRefParts(raw);
  const normalized = normalizePath(base);
  const sourceDir = getDirname(sourcePath);
  const candidates = [normalizePath(`${sourceDir}/${normalized}`), normalized];

  for (const candidate of candidates) {
    const asset = assetIndex.get(candidate);
    if (!asset) continue;
    const emitted = emittedPaths.get(asset.id);
    if (emitted) return `${getRelativePath(getDirname(outputPath), emitted)}${suffix}`;
  }

  const basename = getBasename(normalized);
  const matches = [...assetIndex.entries()].filter(([candidate]) => getBasename(candidate) === basename);
  if (matches.length === 1) {
    const emitted = emittedPaths.get(matches[0][1].id);
    if (emitted) {
      return `${getRelativePath(getDirname(outputPath), emitted)}${suffix}`;
    }
  }

  return raw;
};

const rewriteCssReferences = (
  css: string,
  sourcePath: string,
  outputPath: string,
  emittedPaths: Map<string, string>,
  assetIndex: Map<string, AssetRecord>,
  inlineMap?: Map<string, string>
) => {
  let updated = css;
  updated = updated.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
    const next =
      inlineMap?.get(normalizePath(splitRefParts(url).base)) ??
      resolveReplacementPath(url, sourcePath, outputPath, emittedPaths, assetIndex);
    return `url(${quote}${next}${quote})`;
  });
  updated = updated.replace(/@import\s+(url\()?\s*(['"]?)([^'")]+)\2\s*\)?/gi, (match, urlFn, quote, url) => {
    const next = resolveReplacementPath(url, sourcePath, outputPath, emittedPaths, assetIndex);
    return urlFn ? `@import url(${quote}${next}${quote})` : `@import ${quote}${next}${quote}`;
  });
  return updated;
};

const rewriteJsReferences = (
  js: string,
  sourcePath: string,
  outputPath: string,
  emittedPaths: Map<string, string>,
  assetIndex: Map<string, AssetRecord>
) =>
  js.replace(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g, (match, quote, value) => {
    if (!value || value.includes("${")) return match;
    const next = resolveReplacementPath(value, sourcePath, outputPath, emittedPaths, assetIndex);
    return next === value ? match : `${quote}${next}${quote}`;
  });

const rewriteHtmlReferences = (
  html: string,
  sourcePath: string,
  outputPath: string,
  emittedPaths: Map<string, string>,
  assetIndex: Map<string, AssetRecord>,
  inlineMap?: Map<string, string>
) => {
  let updated = html;
  const attrRegex = /(src|href|poster|content|data-src|data-href|data-bg|data-background|data-image|data-video|data-audio)=(["'])([^"']+)\2/gi;
  updated = updated.replace(attrRegex, (match, attr, quote, url) => {
    const inline = inlineMap?.get(normalizePath(splitRefParts(url).base));
    const next = inline ?? resolveReplacementPath(url, sourcePath, outputPath, emittedPaths, assetIndex);
    return `${attr}=${quote}${next}${quote}`;
  });

  updated = updated.replace(/srcset=(["'])([^"']+)\1/gi, (match, quote, value) => {
    const entries = value.split(",").map((item) => {
        const [url, ...rest] = item.trim().split(/\s+/);
        const inline = inlineMap?.get(normalizePath(splitRefParts(url).base));
      const next = inline ?? resolveReplacementPath(url, sourcePath, outputPath, emittedPaths, assetIndex);
      return [next, ...rest].join(" ");
    });
    return `srcset=${quote}${entries.join(", ")}${quote}`;
  });

  updated = updated.replace(/(style=)(["'])([^"']*)\2/gi, (match, prefix, quote, styleText) => {
    const next = rewriteCssReferences(styleText, sourcePath, outputPath, emittedPaths, assetIndex, inlineMap);
    return `${prefix}${quote}${next}${quote}`;
  });

  updated = updated.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, cssText) => {
    const next = rewriteCssReferences(cssText, sourcePath, outputPath, emittedPaths, assetIndex, inlineMap);
    return `<style${attrs}>${next}</style>`;
  });

  updated = updated.replace(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, jsText) => {
    const next = rewriteJsReferences(jsText, sourcePath, outputPath, emittedPaths, assetIndex);
    return `<script${attrs}>${next}</script>`;
  });

  return updated;
};

const createInlineMap = (assets: AssetRecord[]) => {
  const inlineMap = new Map<string, string>();
  assets
    .filter((asset) => asset.binaryContent)
    .forEach((asset) => {
      inlineMap.set(normalizePath(asset.path), binaryToDataUrl(asset.mime, asset.binaryContent));
    });
  return inlineMap;
};

const buildAssetIndex = (assets: AssetRecord[]) =>
  new Map(assets.map((asset) => [normalizePath(asset.path || asset.name), asset]));

const sumBytes = (assets: Array<{ size: number }>) => assets.reduce((total, asset) => total + asset.size, 0);

export interface BuildAssemblyInput {
  assets: AssetRecord[];
  processedText: Map<string, string>;
  config: BuildConfig;
  entryHtmlId?: string;
  warnings: string[];
  durationMs: number;
  workerCount: number;
}

export const assembleBuildResult = ({
  assets,
  processedText,
  config,
  entryHtmlId,
  warnings,
  durationMs,
  workerCount
}: BuildAssemblyInput): BuildResult => {
  const selectedAssets = assets.map((asset) => cloneAssetWithText(asset, processedText.get(asset.id)));
  const inputBytes = sumBytes(selectedAssets);
  const htmlAssets = selectedAssets.filter((asset) => asset.kind === "html");
  const cssAssets = selectedAssets.filter((asset) => asset.kind === "css");
  const jsAssets = selectedAssets.filter((asset) => asset.kind === "js");
  const passthroughAssets = selectedAssets.filter((asset) => !["html", "css", "js"].includes(asset.kind));

  const generatedEntry = !htmlAssets.length && config.mode !== "batch";
  const entryAsset =
    (entryHtmlId ? htmlAssets.find((asset) => asset.id === entryHtmlId) : undefined) ??
    htmlAssets[0] ??
    (generatedEntry ? createVirtualEntryAsset(config.mode) : undefined);

  const htmlForBundle = entryAsset ? [entryAsset, ...htmlAssets.filter((asset) => asset.id !== entryAsset.id)] : [];
  const assetIndex = buildAssetIndex(selectedAssets);
  const emittedPaths = new Map<string, string>();
  const artifacts: BuildArtifact[] = [];
  const inlineMap = createInlineMap(passthroughAssets);
  const secondaryHtmlIds: string[] = [];

  let previewDoc = "";
  let outputHtml = "";
  let outputCss = "";
  let outputJs = "";

  const originalHtml = entryAsset?.textContent ?? "";
  const originalCss = cssAssets.map((asset) => asset.textContent ?? "").join("\n");
  const originalJs = jsAssets.map((asset) => asset.textContent ?? "").join("\n");

  if (config.mode === "batch") {
    selectedAssets.forEach((asset) => {
      let outputPath = asset.path;
      if (asset.kind === "html" && config.minifyHTML) outputPath = outputPath.replace(/\.html?$/i, ".min.html");
      if (asset.kind === "css" && config.minifyCSS) outputPath = outputPath.replace(/\.css$/i, ".min.css");
      if (asset.kind === "js" && config.minifyJS) outputPath = outputPath.replace(/\.js$/i, ".min.js");
      emittedPaths.set(asset.id, outputPath);
    });

    selectedAssets.forEach((asset) => {
      if (asset.binaryContent) {
        artifacts.push(createArtifact(emittedPaths.get(asset.id) ?? asset.path, asset.mime, { binaryContent: asset.binaryContent }, asset.id));
        return;
      }

      let textContent = asset.textContent ?? "";
      if (config.linkZipReferences) {
        if (asset.kind === "html") {
          const outputPath = emittedPaths.get(asset.id) ?? asset.path;
          textContent = rewriteHtmlReferences(textContent, asset.path, outputPath, emittedPaths, assetIndex);
        } else if (asset.kind === "css") {
          const outputPath = emittedPaths.get(asset.id) ?? asset.path;
          textContent = rewriteCssReferences(textContent, asset.path, outputPath, emittedPaths, assetIndex);
        } else if (asset.kind === "js") {
          const outputPath = emittedPaths.get(asset.id) ?? asset.path;
          textContent = rewriteJsReferences(textContent, asset.path, outputPath, emittedPaths, assetIndex);
        }
      }
      artifacts.push(createArtifact(emittedPaths.get(asset.id) ?? asset.path, asset.mime, { textContent }, asset.id));
    });

    previewDoc = "<html><body><h2 style='font-family:monospace;text-align:center;margin-top:20%'>BATCH MODE PREVIEW UNAVAILABLE<br>DOWNLOAD ZIP TO INSPECT FILES.</h2></body></html>";
  } else {
    outputCss = cssAssets
      .map((asset) => rewriteCssReferences(asset.textContent ?? "", asset.path, config.outputNames.css, emittedPaths, assetIndex, config.mode === "inline" ? inlineMap : undefined))
      .join("\n");
    outputJs = jsAssets
      .map((asset) => rewriteJsReferences(asset.textContent ?? "", asset.path, config.outputNames.js, emittedPaths, assetIndex))
      .join("\n");

    passthroughAssets.forEach((asset) => {
      emittedPaths.set(asset.id, asset.path);
    });

    htmlForBundle.forEach((asset) => {
      const sourcePath = asset.path;
      const outputPath = asset.id === entryAsset?.id ? config.outputNames.html : asset.path;
      const htmlBase = rewriteHtmlReferences(
        asset.textContent ?? "",
        sourcePath,
        outputPath,
        emittedPaths,
        assetIndex,
        config.mode === "inline" ? inlineMap : undefined
      );
      let finalHtml = stripLocalAssetTags(htmlBase);

      if (config.mode === "inline") {
        if (outputCss) finalHtml = injectIntoHead(finalHtml, `<style>\n${outputCss}\n</style>`);
        if (outputJs) finalHtml = injectBeforeBodyEnd(finalHtml, `<script>\n${outputJs}\n</script>`);
      } else {
        if (outputCss) finalHtml = injectIntoHead(finalHtml, `<link rel="stylesheet" href="${config.outputNames.css}">`);
        if (outputJs) finalHtml = injectBeforeBodyEnd(finalHtml, `<script src="${config.outputNames.js}"></script>`);
      }

      if (asset.id === entryAsset?.id) {
        outputHtml = finalHtml;
      } else {
        secondaryHtmlIds.push(asset.id);
        const rewrittenPath = asset.path;
        emittedPaths.set(asset.id, rewrittenPath);
        artifacts.push(createArtifact(rewrittenPath, "text/html", { textContent: finalHtml }, asset.id));
      }
    });

    const entryPath = config.outputNames.html;
    emittedPaths.set(entryAsset?.id ?? "entry", entryPath);
    artifacts.push(createArtifact(entryPath, "text/html", { textContent: outputHtml }, entryAsset?.id));

    if (config.mode === "bundle") {
      if (outputCss) artifacts.push(createArtifact(config.outputNames.css, "text/css", { textContent: outputCss }));
      if (outputJs) artifacts.push(createArtifact(config.outputNames.js, "application/javascript", { textContent: outputJs }));

      passthroughAssets.forEach((asset) => {
        const outputPath = asset.path;
        emittedPaths.set(asset.id, outputPath);
        if (asset.binaryContent) {
          artifacts.push(createArtifact(outputPath, asset.mime, { binaryContent: asset.binaryContent }, asset.id));
        } else if (ARTIFACT_TEXT_KIND.has(asset.kind)) {
          artifacts.push(createArtifact(outputPath, asset.mime, { textContent: asset.textContent ?? "" }, asset.id));
        }
      });
    } else {
      const unbundledAssets = passthroughAssets.filter((asset) => !inlineMap.has(normalizePath(asset.path)));
      if (unbundledAssets.length) {
        warnings.push(`${unbundledAssets.length} non-inline assets remain external in inline mode and were not emitted.`);
      }
    }

    previewDoc =
      config.mode === "inline"
        ? outputHtml
        : injectBeforeBodyEnd(
            injectIntoHead(rewriteHtmlReferences(outputHtml, entryAsset?.path ?? entryPath, entryPath, emittedPaths, assetIndex, inlineMap), `<style data-preview-inline="css">\n${outputCss}\n</style>`),
            `<script data-preview-inline="js">\n${outputJs}\n</script>`
          );
  }

  const outputBytes = sumBytes(artifacts);
  const savedBytes = inputBytes - outputBytes;
  const report = {
    mode: config.mode.toUpperCase(),
    includedAssets: selectedAssets.length,
    emittedArtifacts: artifacts.length,
    inputBytes,
    outputBytes,
    savedBytes,
    savedPct: inputBytes ? (savedBytes / inputBytes) * 100 : 0,
    workerCount,
    durationMs,
    summary: `${config.mode.toUpperCase()} build completed with ${selectedAssets.length} input assets and ${artifacts.length} emitted artifacts.`,
    notes: [
      generatedEntry ? "Generated an entry HTML wrapper because no HTML page was selected." : `Entry HTML: ${entryAsset?.name ?? "none"}`,
      config.mode === "bundle" ? "Secondary HTML pages are preserved as emitted artifacts." : "Secondary HTML pages are only emitted in bundle mode.",
      config.mode === "batch"
        ? (config.linkZipReferences ? "Batch references were rewritten to emitted filenames." : "Batch references were left unchanged.")
        : "Output filenames were snapped at build time for stable downloads and ZIP exports."
    ]
  };

  return {
    mode: config.mode,
    entryHtmlId: entryAsset?.id,
    secondaryHtmlIds,
    includedAssetIds: selectedAssets.map((asset) => asset.id),
    previewDoc,
    artifacts,
    report,
    warnings,
    diff: {
      html: { original: originalHtml, output: outputHtml },
      css: { original: originalCss, output: outputCss },
      js: { original: originalJs, output: outputJs },
      bundle: { original: originalHtml, output: outputHtml }
    },
    filenameSnapshot: { ...config.outputNames }
  };
};
