import type { AssetRecord, BuildConfig, WorkerMinifyResult } from "../../types";

type WorkerMessage =
  | {
      type: "result";
      result: WorkerMinifyResult;
    }
  | {
      type: "error";
      assetId: string;
      message: string;
    };

export const minifyAssetsWithWorker = async (assets: AssetRecord[], config: BuildConfig) => {
  const targets = assets.filter((asset) => asset.textContent && ["html", "css", "js"].includes(asset.kind));
  if (!targets.length) {
    return {
      resultMap: new Map<string, string>(),
      workerCount: 0
    };
  }

  const workerUrl = new URL("../../workers/build-worker.ts", import.meta.url);
  const workerCount = Math.min(targets.length, Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4)));
  const resultMap = new Map<string, string>();
  let currentIndex = 0;
  let completed = 0;

  await new Promise<void>((resolve, reject) => {
    const workers = Array.from({ length: workerCount }, () => new Worker(workerUrl, { type: "module" }));
    const cleanup = () => {
      workers.forEach((worker) => worker.terminate());
    };

    const dispatch = (worker: Worker) => {
      const nextAsset = targets[currentIndex];
      currentIndex += 1;
      if (!nextAsset) return;
      worker.postMessage({
        type: "minify",
        asset: nextAsset,
        config
      });
    };

    workers.forEach((worker) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const payload = event.data;
        if (payload.type === "error") {
          cleanup();
          reject(new Error(payload.message));
          return;
        }

        resultMap.set(payload.result.assetId, payload.result.textContent);
        completed += 1;
        if (completed >= targets.length) {
          cleanup();
          resolve();
          return;
        }

        dispatch(worker);
      };

      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message));
      };

      dispatch(worker);
    });
  });

  return {
    resultMap,
    workerCount
  };
};
