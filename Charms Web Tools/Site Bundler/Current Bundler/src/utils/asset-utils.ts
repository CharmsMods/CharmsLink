import type { AssetRecord, AssetSource } from "../types";
import { assetByteSize } from "./binary";
import { getBasename, getDirname, getMimeTypeFromPath, getAssetKindFromPath, joinPath } from "./path-utils";

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `asset-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createTextAsset = (
  name: string,
  path: string,
  textContent: string,
  source: AssetSource
): AssetRecord => {
  const normalizedPath = path || name;
  return {
    id: createId(),
    kind: getAssetKindFromPath(normalizedPath),
    name: getBasename(normalizedPath) || name,
    path: normalizedPath,
    mime: getMimeTypeFromPath(normalizedPath),
    source,
    size: new Blob([textContent]).size,
    textContent
  };
};

export const createBinaryAsset = (
  name: string,
  path: string,
  binaryContent: string,
  mime: string,
  source: AssetSource
): AssetRecord => {
  const normalizedPath = path || name;
  const asset: AssetRecord = {
    id: createId(),
    kind: getAssetKindFromPath(normalizedPath),
    name: getBasename(normalizedPath) || name,
    path: normalizedPath,
    mime,
    source,
    size: 0,
    binaryContent
  };
  asset.size = assetByteSize(asset);
  return asset;
};

export const cloneAsset = (asset: AssetRecord): AssetRecord => {
  const directory = getDirname(asset.path);
  const dotIndex = asset.name.lastIndexOf(".");
  const stem = dotIndex === -1 ? asset.name : asset.name.slice(0, dotIndex);
  const ext = dotIndex === -1 ? "" : asset.name.slice(dotIndex);
  const copyName = `${stem} copy${ext}`;
  const copyPath = directory ? joinPath(directory, copyName) : copyName;
  return {
    ...asset,
    id: createId(),
    name: copyName,
    path: copyPath
  };
};

export const renameAssetRecord = (asset: AssetRecord, newName: string): AssetRecord => {
  const trimmed = newName.trim();
  const directory = getDirname(asset.path);
  const nextPath = directory ? joinPath(directory, trimmed) : trimmed;
  const next = {
    ...asset,
    name: trimmed,
    path: nextPath,
    mime: getMimeTypeFromPath(nextPath),
    kind: getAssetKindFromPath(nextPath)
  };
  next.size = assetByteSize(next);
  return next;
};

export const updateAssetText = (asset: AssetRecord, textContent: string): AssetRecord => ({
  ...asset,
  textContent,
  size: new Blob([textContent]).size
});
