import type { AssetRecord, BuildConfig, WorkerMinifyResult } from "../types";

type WorkerRequest = {
  type: "minify";
  asset: AssetRecord;
  config: BuildConfig;
};

type WorkerResponse =
  | {
      type: "result";
      result: WorkerMinifyResult;
    }
  | {
      type: "error";
      assetId: string;
      message: string;
    };

let cachedCleanCss: unknown;
let cachedHtmlMinifier: unknown;
let cachedTerser: unknown;

const loadLibraries = async () => {
  if (!cachedCleanCss) {
    cachedCleanCss = await import("clean-css");
  }
  if (!cachedHtmlMinifier) {
    cachedHtmlMinifier = await import("html-minifier-terser");
  }
  if (!cachedTerser) {
    cachedTerser = await import("terser");
  }
};

const stripJsComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");

const stripCssComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "");

const processCss = async (asset: AssetRecord, config: BuildConfig) => {
  let next = asset.textContent ?? "";
  if (!config.minifyCSS && !config.removeComments) return next;
  await loadLibraries();
  const CleanCssModule = cachedCleanCss as { default?: new (options: Record<string, unknown>) => { minify: (code: string) => { styles?: string } } };
  if (config.minifyCSS && CleanCssModule.default) {
    const instance = new CleanCssModule.default({ level: 2, rebase: false });
    next = instance.minify(next).styles ?? next;
  } else if (config.removeComments) {
    next = stripCssComments(next);
  }
  return next;
};

const processJs = async (asset: AssetRecord, config: BuildConfig) => {
  let next = asset.textContent ?? "";
  if (!config.minifyJS && !config.removeComments && !config.dropConsole) return next;
  await loadLibraries();
  const terserModule = cachedTerser as { minify?: (code: string, options: Record<string, unknown>) => Promise<{ code?: string }> };
  if (terserModule.minify) {
    const result = await terserModule.minify(next, {
      compress: config.minifyJS ? { drop_console: config.dropConsole } : { defaults: false, drop_console: config.dropConsole },
      format: config.minifyJS ? undefined : { beautify: true, comments: !config.removeComments },
      mangle: config.minifyJS
    });
    next = result.code ?? next;
  } else if (config.removeComments) {
    next = stripJsComments(next);
  }
  return next;
};

const processHtml = async (asset: AssetRecord, config: BuildConfig) => {
  let next = asset.textContent ?? "";
  if (!config.minifyHTML && !config.removeComments && !config.minifyCSS && !config.minifyJS) return next;
  await loadLibraries();
  const htmlModule = cachedHtmlMinifier as {
    minify?: (code: string, options: Record<string, unknown>) => Promise<string>;
  };
  if (htmlModule.minify) {
    next = await htmlModule.minify(next, {
      collapseWhitespace: config.minifyHTML,
      removeComments: config.removeComments,
      minifyCSS: config.minifyCSS ? { level: 2, rebase: false } : false,
      minifyJS: config.minifyJS ? { compress: { drop_console: config.dropConsole } } : false,
      ignoreCustomFragments: [/<script type="x-shader\/.*?"[\s\S]*?<\/script>/gi]
    });
  }
  return next;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { asset, config } = event.data;
  try {
    let textContent = asset.textContent ?? "";
    if (asset.kind === "css") textContent = await processCss(asset, config);
    if (asset.kind === "js") textContent = await processJs(asset, config);
    if (asset.kind === "html") textContent = await processHtml(asset, config);

    const message: WorkerResponse = {
      type: "result",
      result: {
        assetId: asset.id,
        textContent
      }
    };
    self.postMessage(message);
  } catch (error) {
    const message: WorkerResponse = {
      type: "error",
      assetId: asset.id,
      message: error instanceof Error ? error.message : String(error)
    };
    self.postMessage(message);
  }
};
