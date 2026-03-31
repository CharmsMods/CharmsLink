import type { BuildArtifact, ExtractionResult } from "../types";
import { dataUrlToBase64 } from "../utils/binary";
import { getExtension, getMimeTypeFromPath } from "../utils/path-utils";

const inferExtensionFromMime = (mime: string) => {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("woff2")) return "woff2";
  if (mime.includes("woff")) return "woff";
  if (mime.includes("css")) return "css";
  if (mime.includes("javascript")) return "js";
  return "bin";
};

const createArtifact = (
  path: string,
  payload: { textContent?: string; binaryContent?: string },
  mime = getMimeTypeFromPath(path)
): BuildArtifact => ({
  id: `extract:${path}`,
  kind: payload.binaryContent ? "binary" : (mime.includes("html") ? "html" : mime.includes("css") ? "css" : mime.includes("javascript") ? "js" : "other"),
  name: path.split("/").pop() ?? path,
  path,
  mime,
  textContent: payload.textContent,
  binaryContent: payload.binaryContent,
  size: payload.binaryContent
    ? Math.max(0, Math.floor((payload.binaryContent.length * 3) / 4))
    : new Blob([payload.textContent ?? ""]).size
});

const extractDataUrlAsset = (dataUrl: string, suggestedBase: string, counter: { value: number }) => {
  const mimeMatch = dataUrl.match(/^data:([^;,]+)(;base64)?,/i);
  if (!mimeMatch) return null;
  const mime = mimeMatch[1];
  const extension = inferExtensionFromMime(mime);
  const name = `${suggestedBase}_${counter.value}.${extension}`;
  counter.value += 1;
  return {
    path: name,
    artifact: createArtifact(name, { binaryContent: dataUrlToBase64(dataUrl) }, mime)
  };
};

const replaceCssDataUrls = (css: string, suggestedBase: string, counter: { value: number }, artifacts: BuildArtifact[]) =>
  css.replace(/url\(\s*(['"]?)(data:[^)'" ]+)\1\s*\)/gi, (match, quote, value) => {
    const extracted = extractDataUrlAsset(value, suggestedBase, counter);
    if (!extracted) return match;
    artifacts.push(extracted.artifact);
    return `url(${quote}${extracted.path}${quote})`;
  });

export const extractFromHtml = (html: string, decodeBase64 = true): ExtractionResult => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const artifacts: BuildArtifact[] = [];
  const counter = { value: 1 };

  doc.querySelectorAll("style").forEach((styleTag, index) => {
    const path = `extracted/style_${index + 1}.css`;
    const rewritten = decodeBase64 ? replaceCssDataUrls(styleTag.textContent ?? "", "style_asset", counter, artifacts) : styleTag.textContent ?? "";
    artifacts.push(createArtifact(path, { textContent: rewritten }, "text/css"));
    const replacement = doc.createElement("link");
    replacement.rel = "stylesheet";
    replacement.href = path;
    styleTag.replaceWith(replacement);
  });

  doc.querySelectorAll("script:not([src])").forEach((scriptTag, index) => {
    const path = `extracted/script_${index + 1}.js`;
    artifacts.push(createArtifact(path, { textContent: scriptTag.textContent ?? "" }, "application/javascript"));
    const replacement = doc.createElement("script");
    replacement.src = path;
    replacement.defer = true;
    scriptTag.replaceWith(replacement);
  });

  const assetTags = doc.querySelectorAll("img[src], source[src], source[srcset], img[srcset]");
  assetTags.forEach((element) => {
    const attrs = ["src", "srcset"];
    attrs.forEach((attr) => {
      const value = element.getAttribute(attr);
      if (!value) return;

      if (attr === "srcset") {
        const next = value
          .split(",")
          .map((entry) => {
            const [url, ...rest] = entry.trim().split(/\s+/);
            if (!decodeBase64 || !url.startsWith("data:")) return entry.trim();
            const extracted = extractDataUrlAsset(url, "asset", counter);
            if (!extracted) return entry.trim();
            artifacts.push(extracted.artifact);
            return [extracted.path, ...rest].join(" ");
          })
          .join(", ");
        element.setAttribute(attr, next);
        return;
      }

      if (!decodeBase64 || !value.startsWith("data:")) return;
      const extracted = extractDataUrlAsset(value, "asset", counter);
      if (!extracted) return;
      artifacts.push(extracted.artifact);
      element.setAttribute(attr, extracted.path);
    });
  });

  doc.querySelectorAll<HTMLElement>("[style]").forEach((element, index) => {
    const current = element.getAttribute("style") ?? "";
    const next = decodeBase64 ? replaceCssDataUrls(current, `inline_style_${index + 1}`, counter, artifacts) : current;
    element.setAttribute("style", next);
  });

  const finalHtml = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  const manifest = {
    extractedAt: new Date().toISOString(),
    extractedAssets: artifacts.map((artifact) => ({
      path: artifact.path,
      mime: artifact.mime,
      type: artifact.kind
    })),
    htmlOutput: "index.extracted.html",
    base64Decoded: decodeBase64
  };

  artifacts.push(createArtifact("extracted/manifest.json", { textContent: JSON.stringify(manifest, null, 2) }, "application/json"));
  artifacts.push(createArtifact("index.extracted.html", { textContent: finalHtml }, "text/html"));

  return { assets: artifacts, manifest };
};
