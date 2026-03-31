import type { AssetKind } from "../types";

const EXTENSION_KIND_MAP: Record<string, AssetKind> = {
  html: "html",
  htm: "html",
  css: "css",
  js: "js",
  json: "json",
  map: "map",
  webmanifest: "webmanifest",
  wasm: "wasm",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  mp4: "video",
  webm: "video",
  ogg: "audio",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  pdf: "document",
  txt: "text",
  csv: "text",
  xml: "xml"
};

const MIME_MAP: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  xml: "application/xml"
};

export const TEXT_ASSET_KINDS = new Set<AssetKind>([
  "html",
  "css",
  "js",
  "json",
  "map",
  "webmanifest",
  "text",
  "xml"
]);

export const normalizePath = (value = "") =>
  value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");

export const stripQueryHash = (value = "") => value.split(/[?#]/)[0];

export const stripLeadingRelative = (value = "") =>
  value.replace(/^(\.\/)+/, "").replace(/^(\.\.\/)+/, "");

export const getBasename = (value = "") => {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? "";
};

export const getDirname = (value = "") => {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
};

export const joinPath = (...parts: string[]) => normalizePath(parts.filter(Boolean).join("/"));

export const splitRefParts = (raw = "") => {
  const match = raw.match(/^([^?#]+)([?#].*)?$/);
  return {
    base: match ? match[1] : raw,
    suffix: match?.[2] ?? ""
  };
};

export const resolveRelativePath = (fromPath: string, refPath: string) => {
  const baseDir = getDirname(fromPath);
  const sourceParts = normalizePath(baseDir).split("/").filter(Boolean);
  const refParts = normalizePath(refPath).split("/").filter(Boolean);
  const output = [...sourceParts];

  for (const part of refParts) {
    if (part === ".") continue;
    if (part === "..") {
      output.pop();
      continue;
    }
    output.push(part);
  }

  return output.join("/");
};

export const getRelativePath = (fromDir = "", toPath = "") => {
  const source = normalizePath(fromDir).split("/").filter(Boolean);
  const target = normalizePath(toPath).split("/").filter(Boolean);

  while (source.length && target.length && source[0] === target[0]) {
    source.shift();
    target.shift();
  }

  return [...source.map(() => ".."), ...target].join("/") || getBasename(toPath);
};

export const isExternalRef = (value = "") =>
  /^(data:|blob:|file:|https?:|mailto:|tel:|#|\/\/|javascript:)/i.test(value.trim());

export const getExtension = (value = "") => {
  const basename = getBasename(stripQueryHash(value));
  const index = basename.lastIndexOf(".");
  return index === -1 ? "" : basename.slice(index + 1).toLowerCase();
};

export const getAssetKindFromPath = (value = ""): AssetKind => {
  const ext = getExtension(value);
  return EXTENSION_KIND_MAP[ext] ?? "other";
};

export const getMimeTypeFromPath = (value = "") => {
  const ext = getExtension(value);
  return MIME_MAP[ext] ?? "application/octet-stream";
};

export const looksLikeAssetPath = (value = "") => {
  if (!value || value.length > 300) return false;
  if (isExternalRef(value)) return false;
  return Boolean(getExtension(value));
};

export const isTextAssetKind = (kind: AssetKind) => TEXT_ASSET_KINDS.has(kind);
