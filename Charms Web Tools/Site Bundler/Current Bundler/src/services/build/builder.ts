import type { AssetRecord, BuildConfig, BuildResult } from "../../types";
import { assembleBuildResult } from "./core";
import { minifyAssetsWithWorker } from "./worker-client";

export interface BuildRequest {
  assets: AssetRecord[];
  config: BuildConfig;
  includedAssetIds: string[];
  entryHtmlId?: string;
  warnings?: string[];
}

export const buildProject = async ({
  assets,
  config,
  includedAssetIds,
  entryHtmlId,
  warnings = []
}: BuildRequest): Promise<BuildResult> => {
  const startedAt = performance.now();
  const selectedAssets = assets.filter((asset) => includedAssetIds.includes(asset.id));
  const minified = await minifyAssetsWithWorker(selectedAssets, config);
  const resultMap = minified?.resultMap ?? new Map<string, string>();
  const workerCount = minified?.workerCount ?? 0;

  return assembleBuildResult({
    assets: selectedAssets,
    processedText: resultMap,
    config,
    entryHtmlId,
    warnings: [...warnings],
    durationMs: performance.now() - startedAt,
    workerCount
  });
};
