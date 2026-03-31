import type { AssetRecord, BuildArtifact } from "../types";

export const bytesFromBase64 = (base64 = "") => {
  const paddingMatch = base64.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

export const dataUrlToBase64 = (value: string) => {
  const [, meta = "", base64 = ""] = value.match(/^data:([^,]*?),(.*)$/) ?? [];
  const isBase64 = /;base64/i.test(meta);
  if (!isBase64) {
    return btoa(decodeURIComponent(base64));
  }
  return base64;
};

export const assetByteSize = (asset: Pick<AssetRecord | BuildArtifact, "textContent" | "binaryContent" | "size">) => {
  if (asset.size) return asset.size;
  if (asset.binaryContent) return bytesFromBase64(asset.binaryContent);
  return new Blob([asset.textContent ?? ""]).size;
};

export const fileToBase64 = async (file: File) => {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

export const binaryToDataUrl = (mime: string, base64 = "") => `data:${mime};base64,${base64}`;

export const isImageMime = (mime = "") => mime.startsWith("image/");
