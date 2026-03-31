export type BuildMode = "inline" | "bundle" | "batch";

export type AssetKind =
  | "html"
  | "css"
  | "js"
  | "json"
  | "map"
  | "webmanifest"
  | "wasm"
  | "image"
  | "font"
  | "audio"
  | "video"
  | "document"
  | "text"
  | "xml"
  | "other";

export type AssetSource = "manual" | "imported" | "generated" | "extracted";

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  name: string;
  path: string;
  mime: string;
  source: AssetSource;
  size: number;
  textContent?: string;
  binaryContent?: string;
}

export interface BuildConfig {
  mode: BuildMode;
  minifyHTML: boolean;
  minifyCSS: boolean;
  minifyJS: boolean;
  removeComments: boolean;
  dropConsole: boolean;
  zipDownloads: boolean;
  linkZipReferences: boolean;
  outputNames: {
    html: string;
    css: string;
    js: string;
  };
}

export interface BuildArtifact {
  id: string;
  assetId?: string;
  kind: "html" | "css" | "js" | "binary" | "manifest" | "report" | "other";
  name: string;
  path: string;
  mime: string;
  textContent?: string;
  binaryContent?: string;
  size: number;
}

export interface ReferenceGraphEntry {
  sourceAssetId: string;
  sourcePath: string;
  rawRef: string;
  normalizedRef: string;
  resolvedAssetId?: string;
  resolutionType: "relative" | "exact" | "stripped" | "basename" | "ambiguous" | "missing";
  warning?: string;
  kind: string;
}

export interface ReferenceScanResult {
  references: ReferenceGraphEntry[];
  warnings: string[];
  usedAssetIds: Set<string>;
  missingReferences: ReferenceGraphEntry[];
  ambiguousReferences: ReferenceGraphEntry[];
}

export interface BuildDiffPayload {
  original: string;
  output: string;
}

export interface BuildReport {
  mode: string;
  includedAssets: number;
  emittedArtifacts: number;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPct: number;
  workerCount: number;
  durationMs: number;
  summary: string;
  notes: string[];
}

export interface BuildResult {
  mode: BuildMode;
  entryHtmlId?: string;
  secondaryHtmlIds: string[];
  includedAssetIds: string[];
  previewDoc: string;
  artifacts: BuildArtifact[];
  report: BuildReport;
  warnings: string[];
  diff: Record<"html" | "css" | "js" | "bundle", BuildDiffPayload>;
  filenameSnapshot: BuildConfig["outputNames"];
}

export interface SessionSnapshot {
  version: number;
  assets: AssetRecord[];
  config: BuildConfig;
  activeAssetId?: string;
  entryHtmlId?: string;
}

export interface ExtractionResult {
  assets: BuildArtifact[];
  manifest: Record<string, unknown>;
}

export interface WorkerMinifyResult {
  assetId: string;
  textContent: string;
}

export interface CleanerScanSummary {
  files: number;
  directoriesKept: number;
  emptyDirectories: number;
  collisions: number;
}
