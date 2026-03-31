import "./styles.css";

import type {
  AssetRecord,
  BuildArtifact,
  BuildConfig,
  BuildResult,
  ExtractionResult,
  SessionSnapshot
} from "./types";
import { buildProject } from "./services/build/builder";
import { scanDirectory, copyDirectory } from "./services/cleaner";
import { extractFromHtml } from "./services/extractor";
import { collectReferenceGraph } from "./services/reference-graph";
import { createSessionSnapshot, parseSessionSnapshot } from "./services/session";
import { cloneAsset, createBinaryAsset, createTextAsset, renameAssetRecord, updateAssetText } from "./utils/asset-utils";
import { assetByteSize, binaryToDataUrl, fileToBase64, isImageMime } from "./utils/binary";
import { getAssetKindFromPath, getMimeTypeFromPath, isTextAssetKind, normalizePath } from "./utils/path-utils";

type ReviewState = {
  pinnedIds: Set<string>;
  optionalSelectedIds: Set<string>;
  entryHtmlId?: string;
  warnings: string[];
} | null;

type ConverterItem = {
  file: File;
  relativePath: string;
  isImage: boolean;
  shouldConvert: boolean;
  targetMimeType: string;
  convertedBlob?: Blob;
  status: "Pending" | "Skipped" | "Processing" | "Success" | "Error";
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const IMAGE_OUTPUTS = ["image/png", "image/jpeg", "image/webp"] as const;

const nodes = {
  assetCount: byId<HTMLSpanElement>("assetCount"),
  assetList: byId<HTMLDivElement>("assetList"),
  mainEditor: byId<HTMLTextAreaElement>("mainEditor"),
  mediaView: byId<HTMLDivElement>("mediaView"),
  imgPreview: byId<HTMLImageElement>("imgPreview"),
  mediaPreviewMeta: byId<HTMLDivElement>("mediaPreviewMeta"),
  base64Summary: byId<HTMLDivElement>("base64Summary"),
  currentFileName: byId<HTMLSpanElement>("currentFileName"),
  buildStatus: byId<HTMLDivElement>("build-status"),
  noAssetPrompt: byId<HTMLDivElement>("noAssetPrompt"),
  editorHeader: byId<HTMLDivElement>("editorHeader"),
  previewFrame: byId<HTMLIFrameElement>("previewFrame"),
  previewBox: byId<HTMLDivElement>("previewBox"),
  outNameH: byId<HTMLInputElement>("outNameH"),
  outNameC: byId<HTMLInputElement>("outNameC"),
  outNameJ: byId<HTMLInputElement>("outNameJ"),
  lblH: byId<HTMLSpanElement>("lblH"),
  lblC: byId<HTMLSpanElement>("lblC"),
  lblJ: byId<HTMLSpanElement>("lblJ"),
  downH: byId<HTMLButtonElement>("downH"),
  downC: byId<HTMLButtonElement>("downC"),
  downJ: byId<HTMLButtonElement>("downJ"),
  downA: byId<HTMLButtonElement>("downA"),
  linkZipLabel: byId<HTMLLabelElement>("linkZipLabel"),
  linkZipHint: byId<HTMLDivElement>("linkZipHint"),
  logBox: byId<HTMLDivElement>("logBox"),
  buildReportSummary: byId<HTMLDivElement>("buildReportSummary"),
  reportMode: byId<HTMLDivElement>("reportMode"),
  reportAssets: byId<HTMLDivElement>("reportAssets"),
  reportInput: byId<HTMLDivElement>("reportInput"),
  reportOutput: byId<HTMLDivElement>("reportOutput"),
  reportSavings: byId<HTMLDivElement>("reportSavings"),
  reportWorkers: byId<HTMLDivElement>("reportWorkers"),
  buildReportNotes: byId<HTMLDivElement>("buildReportNotes"),
  usageModal: byId<HTMLDivElement>("usageModalOverlay"),
  referencedList: byId<HTMLDivElement>("referencedList"),
  unreferencedList: byId<HTMLDivElement>("unreferencedList"),
  missingRefsOverlay: byId<HTMLDivElement>("missingRefsOverlay"),
  missingRefsList: byId<HTMLDivElement>("missingRefsList"),
  entryHtmlOverlay: byId<HTMLDivElement>("entryHtmlOverlay"),
  entryHtmlList: byId<HTMLDivElement>("entryHtmlList"),
  helpModal: byId<HTMLDivElement>("helpModalOverlay"),
  loadingOverlay: byId<HTMLDivElement>("loadingOverlay"),
  loadingProgressContainer: byId<HTMLDivElement>("loadingProgressContainer"),
  loadingProgressBar: byId<HTMLDivElement>("loadingProgressBar"),
  loadingProgressText: byId<HTMLDivElement>("loadingProgressText"),
  loadingSubtext: byId<HTMLDivElement>("loadingSubtext"),
  diffOriginal: byId<HTMLElement>("diffOriginal"),
  diffOutput: byId<HTMLElement>("diffOutput"),
  diffOriginalLabel: byId<HTMLDivElement>("diffOriginalLabel"),
  diffOutputLabel: byId<HTMLDivElement>("diffOutputLabel"),
  extractorInput: byId<HTMLInputElement>("extractorInput"),
  extractorList: byId<HTMLDivElement>("extractorList"),
  extractorEmptyState: byId<HTMLDivElement>("extractorEmptyState"),
  extractorDownloadAll: byId<HTMLButtonElement>("extractorDownloadAll"),
  cleanerLog: byId<HTMLDivElement>("cleanerLog"),
  cleanerStats: byId<HTMLSpanElement>("cleanerStats"),
  convFileList: byId<HTMLUListElement>("conv-file-list"),
  convMessageContainer: byId<HTMLDivElement>("conv-message-container"),
  convFileCount: byId<HTMLSpanElement>("conv-file-count"),
  convSystemStatus: byId<HTMLSpanElement>("conv-system-status"),
  convSelectAll: byId<HTMLInputElement>("conv-select-all"),
  convGlobalFormat: byId<HTMLSelectElement>("conv-global-format"),
  convFolderControls: byId<HTMLDivElement>("conv-folder-controls"),
  convIncludeNonImage: byId<HTMLInputElement>("conv-include-non-image"),
  convPreserveStructureOption: byId<HTMLDivElement>("conv-preserve-structure-option"),
  convPreserveStructure: byId<HTMLInputElement>("conv-preserve-structure"),
  convConvertBtn: byId<HTMLButtonElement>("conv-convert-btn"),
  convExportZipBtn: byId<HTMLButtonElement>("conv-export-zip-btn"),
  convClearAllBtn: byId<HTMLButtonElement>("conv-clear-all-btn")
};

const state: {
  assets: AssetRecord[];
  activeAssetId?: string;
  lastBuild?: BuildResult;
  extracted?: ExtractionResult;
  reviewState: ReviewState;
  currentDiffTab: "html" | "css" | "js" | "bundle";
  converterItems: ConverterItem[];
  converterFolderMode: boolean;
} = {
  assets: [],
  reviewState: null,
  currentDiffTab: "html",
  converterItems: [],
  converterFolderMode: false
};

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const escapeHtml = (value = "") =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const log = (message: string) => {
  const entry = document.createElement("div");
  entry.className = "log-line border-l-2 border-[#333] pl-3 py-1 mb-2 hover:bg-white/5 transition-colors";
  const time = new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  entry.innerHTML = `<span class="text-[#555] font-mono mr-3">[${time}]</span>${message}`;
  nodes.logBox.appendChild(entry);
  nodes.logBox.scrollTop = nodes.logBox.scrollHeight;
};

const showToast = (message: string, tone: "info" | "success" | "error" = "info") => {
  const toast = document.createElement("div");
  const color = tone === "error" ? "#FF3366" : tone === "success" ? "#58CC02" : "#121212";
  toast.className = "fixed bottom-8 right-8 bg-[#121212] text-white px-6 py-4 font-bold uppercase tracking-wider transition-all duration-300 transform translate-y-20 opacity-0 z-[200] border-l-4";
  toast.style.boxShadow = `4px 4px 0 ${color}`;
  toast.style.borderLeftColor = color;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.remove("translate-y-20", "opacity-0"));
  setTimeout(() => {
    toast.classList.add("translate-y-20", "opacity-0");
    setTimeout(() => toast.remove(), 300);
  }, 2200);
};

const getBuildConfig = (): BuildConfig => ({
  mode: byId<HTMLSelectElement>("mode").value as BuildConfig["mode"],
  minifyHTML: byId<HTMLInputElement>("optMinifyHTML").checked,
  minifyCSS: byId<HTMLInputElement>("optMinifyCSS").checked,
  minifyJS: byId<HTMLInputElement>("optMinifyJS").checked,
  removeComments: byId<HTMLInputElement>("optComments").checked,
  dropConsole: byId<HTMLInputElement>("optConsole").checked,
  zipDownloads: byId<HTMLInputElement>("optZip").checked,
  linkZipReferences: byId<HTMLInputElement>("optLinkZip").checked,
  outputNames: {
    html: nodes.outNameH.value.trim() || "index.min.html",
    css: nodes.outNameC.value.trim() || "styles.min.css",
    js: nodes.outNameJ.value.trim() || "scripts.min.js"
  }
});

const applyConfigToUI = (config: BuildConfig) => {
  byId<HTMLSelectElement>("mode").value = config.mode;
  byId<HTMLInputElement>("optMinifyHTML").checked = config.minifyHTML;
  byId<HTMLInputElement>("optMinifyCSS").checked = config.minifyCSS;
  byId<HTMLInputElement>("optMinifyJS").checked = config.minifyJS;
  byId<HTMLInputElement>("optComments").checked = config.removeComments;
  byId<HTMLInputElement>("optConsole").checked = config.dropConsole;
  byId<HTMLInputElement>("optZip").checked = config.zipDownloads;
  byId<HTMLInputElement>("optLinkZip").checked = config.linkZipReferences;
  nodes.outNameH.value = config.outputNames.html;
  nodes.outNameC.value = config.outputNames.css;
  nodes.outNameJ.value = config.outputNames.js;
  updateFilenameLabels();
  updateZipToggleState();
};

const updateFilenameLabels = () => {
  nodes.lblH.textContent = nodes.outNameH.value.trim() || "index.min.html";
  nodes.lblC.textContent = nodes.outNameC.value.trim() || "styles.min.css";
  nodes.lblJ.textContent = nodes.outNameJ.value.trim() || "scripts.min.js";
};

const updateZipToggleState = () => {
  const mode = getBuildConfig().mode;
  const zip = byId<HTMLInputElement>("optZip");
  if (mode === "inline") {
    zip.checked = false;
    zip.disabled = true;
  } else if (mode === "batch") {
    zip.checked = true;
    zip.disabled = true;
  } else {
    zip.disabled = false;
  }
  nodes.linkZipLabel.classList.toggle("hidden", mode !== "batch");
  nodes.linkZipHint.classList.toggle("hidden", mode !== "batch");
  byId<HTMLInputElement>("optLinkZip").disabled = mode !== "batch";
};

const getActiveAsset = () => state.assets.find((asset) => asset.id === state.activeAssetId);

const syncEditor = () => {
  const active = getActiveAsset();
  if (!active || !active.textContent) return;
  const index = state.assets.findIndex((asset) => asset.id === active.id);
  state.assets[index] = updateAssetText(active, nodes.mainEditor.value);
};

const setActiveTab = (tabId: string) => {
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll<HTMLElement>(".tab-content").forEach((section) => {
    section.classList.toggle("hidden", section.id !== tabId);
    section.classList.toggle("block", section.id === tabId);
  });
};

const renderAssetList = () => {
  nodes.assetCount.textContent = String(state.assets.length);
  nodes.assetList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  state.assets.forEach((asset, index) => {
    const row = document.createElement("div");
    row.className = `asset-item px-4 py-3 cursor-pointer flex justify-between items-center group relative ${asset.id === state.activeAssetId ? "active" : ""}`;
    row.innerHTML = `
      <div class="flex items-center gap-3 overflow-hidden flex-1" data-action="select" data-id="${asset.id}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-mono font-bold truncate">${escapeHtml(asset.name)}</span>
          </div>
          <span class="text-[9px] text-[#888] font-mono">${escapeHtml(asset.path)} • ${formatBytes(asset.size)} • ${asset.kind.toUpperCase()}</span>
        </div>
      </div>
      <div class="asset-controls flex items-center gap-1 pl-2">
        <button data-action="up" data-id="${asset.id}" class="p-1 border border-[#333] text-[10px]">${index === 0 ? "TOP" : "UP"}</button>
        <button data-action="down" data-id="${asset.id}" class="p-1 border border-[#333] text-[10px]">${index === state.assets.length - 1 ? "END" : "DOWN"}</button>
        <button data-action="duplicate" data-id="${asset.id}" class="p-1 border border-[#333] text-[10px]">COPY</button>
        <button data-action="rename" data-id="${asset.id}" class="p-1 border border-[#333] text-[10px]">NAME</button>
      </div>
    `;
    fragment.appendChild(row);
  });

  nodes.assetList.appendChild(fragment);
  const empty = state.assets.length === 0;
  nodes.noAssetPrompt.classList.toggle("hidden", !empty);
  nodes.editorHeader.classList.toggle("hidden", empty);
  if (empty) {
    nodes.mainEditor.classList.add("hidden");
    nodes.mediaView.classList.add("hidden");
  }
};

const selectAsset = (assetId?: string) => {
  syncEditor();
  state.activeAssetId = assetId;
  const asset = getActiveAsset();
  renderAssetList();

  if (!asset) {
    nodes.mainEditor.classList.add("hidden");
    nodes.mediaView.classList.add("hidden");
    nodes.currentFileName.textContent = "Select an asset";
    return;
  }

  nodes.currentFileName.textContent = asset.path;
  if (asset.binaryContent) {
    nodes.mainEditor.classList.add("hidden");
    nodes.mediaView.classList.remove("hidden");
    const dataUrl = binaryToDataUrl(asset.mime, asset.binaryContent);
    if (isImageMime(asset.mime)) {
      nodes.imgPreview.classList.remove("hidden");
      nodes.imgPreview.src = dataUrl;
    } else {
      nodes.imgPreview.classList.add("hidden");
      nodes.imgPreview.removeAttribute("src");
    }
    nodes.mediaPreviewMeta.textContent = `${asset.mime} • ${formatBytes(asset.size)}`;
    nodes.base64Summary.textContent = `${asset.binaryContent.slice(0, 100)}...`;
    return;
  }

  nodes.mainEditor.classList.remove("hidden");
  nodes.mediaView.classList.add("hidden");
  nodes.mainEditor.value = asset.textContent ?? "";
};

const addAssetToState = (asset: AssetRecord) => {
  state.assets.push(asset);
  renderAssetList();
  selectAsset(asset.id);
  log(`Imported <span class="text-[#58CC02] font-bold">${escapeHtml(asset.path)}</span>`);
};

const loadFileAsAsset = async (file: File, relativePath?: string) => {
  const path = normalizePath(relativePath || file.webkitRelativePath || file.name);
  const kind = getAssetKindFromPath(path);
  if (isTextAssetKind(kind) && kind !== "image") {
    addAssetToState(createTextAsset(file.name, path, await file.text(), "imported"));
    return;
  }
  const mime = file.type || getMimeTypeFromPath(path);
  addAssetToState(createBinaryAsset(file.name, path, await fileToBase64(file), mime, "imported"));
};

const readDroppedEntry = async (entry: any, prefix = ""): Promise<File[]> => {
  if (!entry) return [];
  if (entry.isFile) {
    return new Promise<File[]>((resolve) => {
      entry.file((file: File & { _relativePath?: string }) => {
        file._relativePath = `${prefix}${file.name}`;
        resolve([file]);
      });
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const files: File[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const entries = await new Promise<any[]>((resolve) => reader.readEntries(resolve));
      if (!entries.length) break;
      for (const child of entries) {
        files.push(...(await readDroppedEntry(child, `${prefix}${entry.name}/`)));
      }
    }
    return files;
  }
  return [];
};

const collectTransferFiles = async (dataTransfer: DataTransfer) => {
  const files: File[] = [];
  const items = Array.from(dataTransfer.items ?? []);
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => any }).webkitGetAsEntry?.();
    if (entry) {
      files.push(...(await readDroppedEntry(entry)));
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) files.push(...Array.from(dataTransfer.files));
  return files;
};

const renderBuildReport = () => {
  const report = state.lastBuild?.report;
  if (!report) {
    nodes.buildReportSummary.textContent = "Run a build to generate artifact metrics and workflow notes.";
    nodes.reportMode.textContent = "-";
    nodes.reportAssets.textContent = "-";
    nodes.reportInput.textContent = "-";
    nodes.reportOutput.textContent = "-";
    nodes.reportSavings.textContent = "-";
    nodes.reportWorkers.textContent = "-";
    nodes.buildReportNotes.textContent = "No build notes yet.";
    return;
  }
  nodes.buildReportSummary.textContent = report.summary;
  nodes.reportMode.textContent = report.mode;
  nodes.reportAssets.textContent = `${report.includedAssets} IN / ${report.emittedArtifacts} OUT`;
  nodes.reportInput.textContent = formatBytes(report.inputBytes);
  nodes.reportOutput.textContent = formatBytes(report.outputBytes);
  nodes.reportSavings.textContent = `${formatBytes(report.savedBytes)} (${report.savedPct.toFixed(1)}%)`;
  nodes.reportWorkers.textContent = `${report.workerCount} • ${report.durationMs.toFixed(0)}ms`;
  nodes.buildReportNotes.innerHTML = report.notes.map((note) => `<div>&gt; ${escapeHtml(note)}</div>`).join("");
};

const updateDownloadUI = () => {
  const build = state.lastBuild;
  const findArtifact = (path: string) => build?.artifacts.find((artifact) => artifact.path === path);
  nodes.downH.classList.toggle("hidden", !findArtifact(build?.filenameSnapshot.html ?? ""));
  nodes.downC.classList.toggle("hidden", !findArtifact(build?.filenameSnapshot.css ?? ""));
  nodes.downJ.classList.toggle("hidden", !findArtifact(build?.filenameSnapshot.js ?? ""));
  nodes.downA.textContent = build?.mode === "batch" || getBuildConfig().zipDownloads ? "Download ZIP" : "Download Bundle";
};

const setLoading = (active: boolean, message = "Processing...") => {
  nodes.loadingOverlay.classList.toggle("active", active);
  nodes.loadingProgressContainer.classList.toggle("hidden", !active);
  nodes.loadingSubtext.classList.toggle("hidden", !active);
  if (active) {
    nodes.loadingProgressBar.style.width = "30%";
    nodes.loadingProgressText.textContent = "30%";
    nodes.loadingSubtext.textContent = message;
  }
};

const showMissingRefs = async (items: ReturnType<typeof collectReferenceGraph>["missingReferences"]) =>
  new Promise<void>((resolve) => {
    if (!items.length) {
      resolve();
      return;
    }
    nodes.missingRefsList.innerHTML = items
      .map((item) => `<div class="border border-[#121212] bg-white p-3"><div class="font-bold">${escapeHtml(item.rawRef)}</div><div class="text-[10px] text-[#666]">${escapeHtml(item.sourcePath)}</div></div>`)
      .join("");
    nodes.missingRefsOverlay.classList.remove("hidden");
    const close = () => {
      nodes.missingRefsOverlay.classList.add("hidden");
      byId<HTMLButtonElement>("missingRefsClose").onclick = null;
      resolve();
    };
    byId<HTMLButtonElement>("missingRefsClose").onclick = close;
    nodes.missingRefsOverlay.onclick = (event) => {
      if (event.target === nodes.missingRefsOverlay) close();
    };
  });

const promptForEntryHtml = async (assets: AssetRecord[]) =>
  new Promise<string | undefined>((resolve) => {
    let selected = assets[0]?.id;
    nodes.entryHtmlList.innerHTML = "";
    assets.forEach((asset, index) => {
      const row = document.createElement("label");
      row.className = "review-card";
      row.innerHTML = `<input type="radio" name="entry-html" ${index === 0 ? "checked" : ""} value="${asset.id}"><div><div class="font-bold">${escapeHtml(asset.name)}</div><div class="text-[10px] text-[#666]">${escapeHtml(asset.path)}</div></div>`;
      row.querySelector<HTMLInputElement>("input")?.addEventListener("change", () => {
        selected = asset.id;
      });
      nodes.entryHtmlList.appendChild(row);
    });
    nodes.entryHtmlOverlay.classList.remove("hidden");
    byId<HTMLButtonElement>("entryHtmlProceed").onclick = () => {
      nodes.entryHtmlOverlay.classList.add("hidden");
      resolve(selected);
    };
    byId<HTMLButtonElement>("entryHtmlCancel").onclick = () => {
      nodes.entryHtmlOverlay.classList.add("hidden");
      resolve(undefined);
    };
  });

const renderReviewModal = (pinned: AssetRecord[], optional: AssetRecord[], entryHtmlId?: string, warnings: string[] = []) => {
  state.reviewState = {
    pinnedIds: new Set(pinned.map((asset) => asset.id)),
    optionalSelectedIds: new Set(optional.map((asset) => asset.id)),
    entryHtmlId,
    warnings
  };
  nodes.referencedList.innerHTML = "";
  nodes.unreferencedList.innerHTML = "";

  pinned.forEach((asset) => {
    const row = document.createElement("div");
    row.className = "review-card";
    row.innerHTML = `<div><div class="font-bold">${escapeHtml(asset.name)}</div><div class="text-[10px] text-[#666]">${escapeHtml(asset.path)}</div></div>`;
    nodes.referencedList.appendChild(row);
  });

  optional.forEach((asset) => {
    const row = document.createElement("label");
    row.className = "review-card optional";
    row.innerHTML = `<input type="checkbox" checked data-id="${asset.id}"><div><div class="font-bold">${escapeHtml(asset.name)}</div><div class="text-[10px] text-[#666]">${escapeHtml(asset.path)}</div></div>`;
    row.querySelector<HTMLInputElement>("input")?.addEventListener("change", (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      if (!state.reviewState) return;
      if (checked) state.reviewState.optionalSelectedIds.add(asset.id);
      else state.reviewState.optionalSelectedIds.delete(asset.id);
    });
    nodes.unreferencedList.appendChild(row);
  });

  nodes.usageModal.classList.remove("hidden");
};

const artifactToBlob = (artifact: BuildArtifact) => {
  if (artifact.binaryContent) {
    const binary = atob(artifact.binaryContent);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: artifact.mime });
  }
  return new Blob([artifact.textContent ?? ""], { type: artifact.mime });
};

const downloadArtifact = (artifact: BuildArtifact) => {
  const url = URL.createObjectURL(artifactToBlob(artifact));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 250);
};

const downloadArtifactsAsZip = async (artifacts: BuildArtifact[], zipName: string) => {
  const { default: JSZip } = await import("jszip");
  const { saveAs } = await import("file-saver");
  const zip = new JSZip();
  artifacts.forEach((artifact) => {
    if (artifact.binaryContent) {
      zip.file(artifact.path, artifact.binaryContent, { base64: true });
      return;
    }
    zip.file(artifact.path, artifact.textContent ?? "");
  });
  saveAs(await zip.generateAsync({ type: "blob" }), zipName);
};

const generateDiff = async (type: "html" | "css" | "js" | "bundle" = state.currentDiffTab) => {
  state.currentDiffTab = type;
  if (!state.lastBuild) {
    nodes.diffOriginal.textContent = "Build something first.";
    nodes.diffOutput.textContent = "Build something first.";
    return;
  }
  const payload = state.lastBuild.diff[type];
  const collapseBase64 = byId<HTMLInputElement>("diffCollapseBase64").checked;
  const wrap = byId<HTMLInputElement>("diffWrap").checked;
  nodes.diffOriginal.className = `flex-1 p-4 font-mono text-xs overflow-auto text-[#444] leading-relaxed ${wrap ? "whitespace-pre-wrap" : "whitespace-pre"}`;
  nodes.diffOutput.className = nodes.diffOriginal.className;

  let original = payload.original;
  let output = payload.output;
  if (collapseBase64) {
    const regex = /data:[^;]+;base64,[A-Za-z0-9+/=]+/g;
    original = original.replace(regex, "[BASE64]");
    output = output.replace(regex, "[BASE64]");
  }

  const diffLib = await import("diff");
  const segments = (original.length + output.length > 120000 ? diffLib.diffLines : diffLib.diffWordsWithSpace)(original, output);
  const left: string[] = [];
  const right: string[] = [];
  segments.forEach((part) => {
    const value = escapeHtml(part.value);
    if (part.added) right.push(`<span class="bg-green-200 text-green-900 font-bold">${value}</span>`);
    else if (part.removed) left.push(`<span class="bg-red-200 text-red-900 font-bold">${value}</span>`);
    else {
      left.push(`<span class="text-gray-500">${value}</span>`);
      right.push(`<span class="text-gray-500">${value}</span>`);
    }
  });

  nodes.diffOriginalLabel.textContent = `Original ${type.toUpperCase()}`;
  nodes.diffOutputLabel.textContent = `Build Output ${type.toUpperCase()}`;
  nodes.diffOriginal.innerHTML = left.join("");
  nodes.diffOutput.innerHTML = right.join("");
};

const buildNow = async (includedIds: string[], entryHtmlId?: string, warnings: string[] = []) => {
  syncEditor();
  try {
    nodes.buildStatus.classList.remove("hidden");
    setLoading(true, "Building artifacts...");
    state.lastBuild = await buildProject({
      assets: state.assets,
      config: getBuildConfig(),
      includedAssetIds: includedIds,
      entryHtmlId,
      warnings
    });
    nodes.previewFrame.srcdoc = state.lastBuild.previewDoc;
    renderBuildReport();
    updateDownloadUI();
    await generateDiff();
    setActiveTab("output");
    log(`<span class="text-[#58CC02] font-bold">Build complete.</span>`);
    showToast("Build Success", "success");
  } catch (error) {
    log(`<span class="text-[#FF3366]">Build failed:</span> ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    showToast("Build Failed", "error");
  } finally {
    setLoading(false);
    nodes.buildStatus.classList.add("hidden");
  }
};

const startBuildFlow = async () => {
  syncEditor();
  if (!state.assets.length) {
    showToast("No assets to build", "error");
    return;
  }

  const htmlAssets = state.assets.filter((asset) => asset.kind === "html");
  const entryHtmlId = htmlAssets.length > 1 ? await promptForEntryHtml(htmlAssets) : htmlAssets[0]?.id;
  if (htmlAssets.length > 1 && !entryHtmlId) return;

  const scan = collectReferenceGraph(state.assets);
  scan.warnings.forEach((warning) => log(`<span class="text-yellow-500">Scan warning:</span> ${escapeHtml(warning)}`));
  if (scan.missingReferences.length) await showMissingRefs(scan.missingReferences);

  const pinned = state.assets.filter((asset) => scan.usedAssetIds.has(asset.id) || asset.id === entryHtmlId);
  const optional = state.assets.filter((asset) => !pinned.some((pinnedAsset) => pinnedAsset.id === asset.id));
  const warnings = [
    ...scan.warnings,
    ...scan.missingReferences.map((item) => `Missing reference: ${item.rawRef} in ${item.sourcePath}`),
    ...scan.ambiguousReferences.map((item) => item.warning ?? `Ambiguous reference ${item.rawRef}`)
  ];

  if (optional.length) {
    renderReviewModal(pinned, optional, entryHtmlId, warnings);
    return;
  }

  await buildNow(state.assets.map((asset) => asset.id), entryHtmlId, warnings);
};

const renderExtractorList = () => {
  nodes.extractorList.innerHTML = "";
  const extraction = state.extracted;
  if (!extraction || !extraction.assets.length) {
    nodes.extractorList.appendChild(nodes.extractorEmptyState);
    nodes.extractorDownloadAll.classList.add("hidden");
    return;
  }
  nodes.extractorDownloadAll.classList.remove("hidden");
  extraction.assets.forEach((artifact, index) => {
    const row = document.createElement("div");
    row.className = "review-card";
    row.innerHTML = `<div class="flex-1"><div class="font-bold font-mono">${escapeHtml(artifact.path)}</div><div class="text-[10px] text-[#666]">${artifact.mime} • ${formatBytes(artifact.size)}</div></div><button class="border-[3px] border-[#121212] px-3 py-2 text-[10px] font-bold" data-index="${index}">SAVE</button>`;
    nodes.extractorList.appendChild(row);
  });
};

const appendCleanerLog = (message: string, tone: "info" | "error" | "success" = "info") => {
  const row = document.createElement("div");
  row.className = tone === "error" ? "text-[#FF3366]" : tone === "success" ? "text-[#58CC02]" : "";
  row.textContent = `> ${message}`;
  nodes.cleanerLog.appendChild(row);
  nodes.cleanerLog.scrollTop = nodes.cleanerLog.scrollHeight;
};

const runCleaner = async (dryRun: boolean) => {
  const picker = (window as Window & { showDirectoryPicker?: (options?: Record<string, unknown>) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!picker) {
    showToast("Directory picker not supported", "error");
    return;
  }
  nodes.cleanerLog.innerHTML = "";
  appendCleanerLog("Select the source folder.");
  const source = await picker({ id: dryRun ? "cleaner-dry-source" : "cleaner-run-source", mode: "read" });
  if (dryRun) {
    const summary = await scanDirectory(source);
    nodes.cleanerStats.textContent = `${summary.files} FILES`;
    appendCleanerLog(`Dry scan complete: ${summary.files} files, ${summary.directoriesKept} non-empty folders, ${summary.emptyDirectories} empty folders.`);
    return;
  }
  appendCleanerLog("Select the destination parent folder.");
  const destinationParent = await picker({ id: "cleaner-run-destination", mode: "readwrite" });
  const destination = await destinationParent.getDirectoryHandle(`${source.name}_cleaned`, { create: true });
  const summary = await scanDirectory(source, destination);
  nodes.cleanerStats.textContent = `${summary.files} FILES`;
  appendCleanerLog(`Preflight: ${summary.files} files, ${summary.collisions} existing destination files.`);
  await copyDirectory(source, destination, {
    skipExisting: byId<HTMLInputElement>("cleanerSkipExisting").checked,
    onLog: (message, tone) => appendCleanerLog(message, tone)
  });
  appendCleanerLog("Copy complete.", "success");
};

const renderConverter = () => {
  nodes.convFileCount.textContent = String(state.converterItems.length);
  nodes.convFileList.innerHTML = "";
  if (!state.converterItems.length) {
    const empty = document.createElement("li");
    empty.id = "conv-empty-state";
    empty.className = "p-8 text-center font-mono text-sm opacity-50 uppercase";
    empty.textContent = "[ No Data Loaded ]";
    nodes.convFileList.appendChild(empty);
  } else {
    state.converterItems.forEach((item, index) => {
      const row = document.createElement("li");
      row.className = "converter-file-item";
      row.innerHTML = `
        <div class="font-mono text-xs overflow-hidden whitespace-nowrap text-ellipsis pr-4">${index + 1}. ${escapeHtml(item.relativePath)}</div>
        <div class="flex items-center gap-2">
          ${item.isImage ? `<input type="checkbox" ${item.shouldConvert ? "checked" : ""} data-conv="toggle" data-index="${index}"><select data-conv="format" data-index="${index}" ${item.shouldConvert ? "" : "disabled"}>${IMAGE_OUTPUTS.map((mime) => `<option value="${mime}" ${mime === item.targetMimeType ? "selected" : ""}>${mime.split("/")[1]}</option>`).join("")}</select>` : `<span class="text-xs font-bold uppercase opacity-50">NO ACTION</span>`}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-mono uppercase">${item.status}</span>
          <button data-conv="remove" data-index="${index}" class="border-[2px] border-[#121212] px-2 py-1 text-[10px]">X</button>
        </div>
      `;
      nodes.convFileList.appendChild(row);
    });
  }
  const hasImages = state.converterItems.some((item) => item.isImage);
  const hasSelected = state.converterItems.some((item) => item.isImage && item.shouldConvert);
  nodes.convConvertBtn.disabled = !hasSelected;
  nodes.convExportZipBtn.disabled = !state.converterItems.length;
  nodes.convClearAllBtn.disabled = !state.converterItems.length;
  nodes.convSelectAll.disabled = !hasImages;
  nodes.convGlobalFormat.disabled = !hasImages;
  nodes.convFolderControls.classList.toggle("hidden", !state.converterFolderMode);
  nodes.convPreserveStructureOption.classList.toggle("hidden", nodes.convIncludeNonImage.checked);
  nodes.convSystemStatus.textContent = "READY";
};

const addConverterFile = (file: File, relativePath: string) => {
  if (state.converterItems.some((item) => item.relativePath === relativePath)) return;
  const isImage = file.type.startsWith("image/");
  state.converterItems.push({
    file,
    relativePath,
    isImage,
    shouldConvert: isImage,
    targetMimeType: nodes.convGlobalFormat.value || "image/png",
    status: isImage ? "Pending" : "Skipped"
  });
};

const convertImage = async (file: File, mime: string) =>
  new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas context unavailable."));
        return;
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Blob creation failed."));
          return;
        }
        resolve(blob);
      }, mime, 0.92);
    };
    image.onerror = () => reject(new Error("Image load failed."));
    image.src = URL.createObjectURL(file);
  });

const exportConverterZip = async () => {
  const { default: JSZip } = await import("jszip");
  const { saveAs } = await import("file-saver");
  const zip = new JSZip();
  for (const item of state.converterItems) {
    const include = item.isImage || nodes.convIncludeNonImage.checked;
    if (!include) continue;
    const blob = item.convertedBlob ?? item.file;
    zip.file(item.relativePath, blob);
  }
  saveAs(await zip.generateAsync({ type: "blob" }), state.converterFolderMode ? "converted_folder.zip" : "converted_files.zip");
};

const populateConverterFormats = () => {
  IMAGE_OUTPUTS.forEach((mime) => {
    const option = document.createElement("option");
    option.value = mime;
    option.textContent = mime.split("/")[1].toUpperCase();
    nodes.convGlobalFormat.appendChild(option);
  });
  nodes.convGlobalFormat.value = "image/png";
};

document.querySelectorAll<HTMLElement>(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab ?? "workspace"));
});

byId<HTMLButtonElement>("openHelp").onclick = () => nodes.helpModal.classList.remove("hidden");
byId<HTMLButtonElement>("closeHelp").onclick = () => nodes.helpModal.classList.add("hidden");
nodes.helpModal.onclick = (event) => {
  if (event.target === nodes.helpModal) nodes.helpModal.classList.add("hidden");
};

byId<HTMLButtonElement>("addHtml").onclick = () => addAssetToState(createTextAsset("page.html", `page-${state.assets.filter((asset) => asset.kind === "html").length + 1}.html`, "<!DOCTYPE html>\n<html>\n<body>\n</body>\n</html>", "manual"));
byId<HTMLButtonElement>("addCss").onclick = () => addAssetToState(createTextAsset("style.css", `style-${state.assets.filter((asset) => asset.kind === "css").length + 1}.css`, "/* Styles */\n", "manual"));
byId<HTMLButtonElement>("addJs").onclick = () => addAssetToState(createTextAsset("script.js", `script-${state.assets.filter((asset) => asset.kind === "js").length + 1}.js`, "// Script\n", "manual"));
byId<HTMLButtonElement>("removeAsset").onclick = () => {
  if (!state.activeAssetId) return;
  state.assets = state.assets.filter((asset) => asset.id !== state.activeAssetId);
  selectAsset(state.assets[0]?.id);
};

nodes.mainEditor.addEventListener("input", syncEditor);
nodes.assetList.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (!id) return;
  const index = state.assets.findIndex((asset) => asset.id === id);
  if (action === "select") selectAsset(id);
  if (action === "up" && index > 0) [state.assets[index - 1], state.assets[index]] = [state.assets[index], state.assets[index - 1]];
  if (action === "down" && index < state.assets.length - 1) [state.assets[index + 1], state.assets[index]] = [state.assets[index], state.assets[index + 1]];
  if (action === "duplicate") state.assets.push(cloneAsset(state.assets[index]));
  if (action === "rename") {
    const value = window.prompt("Rename asset", state.assets[index].name);
    if (value?.trim()) state.assets[index] = renameAssetRecord(state.assets[index], value.trim());
  }
  renderAssetList();
});

["dragover", "dragenter"].forEach((name) => {
  document.body.addEventListener(name, (event) => {
    event.preventDefault();
    byId<HTMLDivElement>("dropOverlay").classList.remove("hidden");
  });
});
["dragleave", "drop"].forEach((name) => {
  document.body.addEventListener(name, () => byId<HTMLDivElement>("dropOverlay").classList.add("hidden"));
});
document.body.addEventListener("drop", async (event) => {
  event.preventDefault();
  const files = await collectTransferFiles(event.dataTransfer!);
  for (const file of files) {
    const relative = normalizePath((file as File & { _relativePath?: string })._relativePath || file.webkitRelativePath || file.name);
    await loadFileAsAsset(file, relative);
  }
});

byId<HTMLButtonElement>("build").onclick = () => void startBuildFlow();
byId<HTMLButtonElement>("scanMissing").onclick = async () => {
  const scan = collectReferenceGraph(state.assets);
  await showMissingRefs(scan.missingReferences);
};
byId<HTMLButtonElement>("modalCancel").onclick = () => {
  nodes.usageModal.classList.add("hidden");
  state.reviewState = null;
};
byId<HTMLButtonElement>("modalProceed").onclick = () => {
  nodes.usageModal.classList.add("hidden");
  if (!state.reviewState) return;
  const included = [...state.reviewState.pinnedIds, ...state.reviewState.optionalSelectedIds];
  void buildNow(included, state.reviewState.entryHtmlId, state.reviewState.warnings);
  state.reviewState = null;
};

byId<HTMLButtonElement>("openNewTab").onclick = () => {
  if (!state.lastBuild?.previewDoc) return;
  const url = URL.createObjectURL(new Blob([state.lastBuild.previewDoc], { type: "text/html" }));
  window.open(url, "_blank");
};
byId<HTMLButtonElement>("togglePreview").onclick = () => nodes.previewBox.classList.toggle("hidden");
byId<HTMLInputElement>("diffCollapseBase64").onchange = () => void generateDiff();
byId<HTMLInputElement>("diffWrap").onchange = () => void generateDiff();
(["html", "css", "js", "bundle"] as const).forEach((type) => {
  byId<HTMLButtonElement>(`diffTab${type[0].toUpperCase()}${type.slice(1)}`).onclick = () => void generateDiff(type);
});

nodes.downH.onclick = () => {
  const artifact = state.lastBuild?.artifacts.find((item) => item.path === state.lastBuild?.filenameSnapshot.html);
  if (artifact) downloadArtifact(artifact);
};
nodes.downC.onclick = () => {
  const artifact = state.lastBuild?.artifacts.find((item) => item.path === state.lastBuild?.filenameSnapshot.css);
  if (artifact) downloadArtifact(artifact);
};
nodes.downJ.onclick = () => {
  const artifact = state.lastBuild?.artifacts.find((item) => item.path === state.lastBuild?.filenameSnapshot.js);
  if (artifact) downloadArtifact(artifact);
};
nodes.downA.onclick = async () => {
  if (!state.lastBuild) return;
  if (state.lastBuild.mode === "batch" || getBuildConfig().zipDownloads) {
    await downloadArtifactsAsZip(state.lastBuild.artifacts, "bundle.zip");
    return;
  }
  state.lastBuild.artifacts.forEach(downloadArtifact);
};

[nodes.outNameH, nodes.outNameC, nodes.outNameJ].forEach((input) => input.addEventListener("input", updateFilenameLabels));
byId<HTMLSelectElement>("mode").addEventListener("change", updateZipToggleState);

byId<HTMLButtonElement>("extractorUploadBtn").onclick = () => nodes.extractorInput.click();
nodes.extractorInput.onchange = async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  state.extracted = extractFromHtml(await file.text(), byId<HTMLInputElement>("extBase64Dec").checked);
  renderExtractorList();
  nodes.extractorInput.value = "";
};
nodes.extractorList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-index]");
  if (!button || !state.extracted) return;
  const artifact = state.extracted.assets[Number(button.dataset.index)];
  if (artifact) downloadArtifact(artifact);
});
nodes.extractorDownloadAll.onclick = async () => {
  if (!state.extracted) return;
  await downloadArtifactsAsZip(state.extracted.assets, "extracted_project.zip");
};

byId<HTMLButtonElement>("cleanerDryRunBtn").onclick = () => void runCleaner(true);
byId<HTMLButtonElement>("cleanerRunBtn").onclick = () => void runCleaner(false);

populateConverterFormats();
const hiddenFileInput = byId<HTMLInputElement>("conv-hidden-file-input");
const hiddenFolderInput = byId<HTMLInputElement>("conv-hidden-folder-input");
byId<HTMLButtonElement>("conv-upload-files-btn").onclick = () => hiddenFileInput.click();
byId<HTMLButtonElement>("conv-upload-folder-btn").onclick = () => hiddenFolderInput.click();
hiddenFileInput.onchange = () => {
  state.converterFolderMode = false;
  state.converterItems = [];
  Array.from(hiddenFileInput.files ?? []).forEach((file) => addConverterFile(file, file.name));
  renderConverter();
  hiddenFileInput.value = "";
};
hiddenFolderInput.onchange = () => {
  state.converterFolderMode = true;
  state.converterItems = [];
  Array.from(hiddenFolderInput.files ?? []).forEach((file) => addConverterFile(file, normalizePath(file.webkitRelativePath || file.name)));
  renderConverter();
  hiddenFolderInput.value = "";
};
byId<HTMLDivElement>("conv-drop-zone").addEventListener("dragover", (event) => {
  event.preventDefault();
});
byId<HTMLDivElement>("conv-drop-zone").addEventListener("drop", async (event) => {
  event.preventDefault();
  state.converterItems = [];
  const files = await collectTransferFiles(event.dataTransfer!);
  state.converterFolderMode = files.some((file) => Boolean((file as File & { _relativePath?: string })._relativePath?.includes("/")));
  files.forEach((file) => addConverterFile(file, normalizePath((file as File & { _relativePath?: string })._relativePath || file.webkitRelativePath || file.name)));
  renderConverter();
});
nodes.convSelectAll.onchange = () => {
  state.converterItems.forEach((item) => {
    if (item.isImage) {
      item.shouldConvert = nodes.convSelectAll.checked;
      item.status = item.shouldConvert ? "Pending" : "Skipped";
      if (!item.shouldConvert) item.convertedBlob = undefined;
    }
  });
  renderConverter();
};
nodes.convGlobalFormat.onchange = () => {
  state.converterItems.forEach((item) => {
    if (item.isImage) {
      item.targetMimeType = nodes.convGlobalFormat.value;
      item.status = item.shouldConvert ? "Pending" : "Skipped";
      item.convertedBlob = undefined;
    }
  });
  renderConverter();
};
nodes.convIncludeNonImage.onchange = renderConverter;
nodes.convPreserveStructure.onchange = renderConverter;
nodes.convFileList.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const index = Number(target.dataset.index);
  const item = state.converterItems[index];
  if (!item) return;
  if (target.dataset.conv === "toggle" && target instanceof HTMLInputElement) {
    item.shouldConvert = target.checked;
    item.status = target.checked ? "Pending" : "Skipped";
    if (!target.checked) item.convertedBlob = undefined;
  }
  if (target.dataset.conv === "format" && target instanceof HTMLSelectElement) {
    item.targetMimeType = target.value;
    item.status = "Pending";
    item.convertedBlob = undefined;
  }
  renderConverter();
});
nodes.convFileList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-conv='remove']");
  if (!button) return;
  state.converterItems.splice(Number(button.dataset.index), 1);
  renderConverter();
});
nodes.convConvertBtn.onclick = async () => {
  for (const item of state.converterItems) {
    if (!item.isImage || !item.shouldConvert) continue;
    item.status = "Processing";
    renderConverter();
    try {
      item.convertedBlob = await convertImage(item.file, item.targetMimeType);
      item.relativePath = item.relativePath.replace(/\.[^/.]+$/, "") + `.${item.targetMimeType.split("/")[1].replace("jpeg", "jpg")}`;
      item.status = "Success";
    } catch {
      item.status = "Error";
    }
  }
  renderConverter();
};
nodes.convExportZipBtn.onclick = () => void exportConverterZip();
nodes.convClearAllBtn.onclick = () => {
  state.converterItems = [];
  state.converterFolderMode = false;
  renderConverter();
};

byId<HTMLButtonElement>("exportProjectBtn").onclick = async () => {
  syncEditor();
  const snapshot = createSessionSnapshot(state.assets, getBuildConfig(), state.activeAssetId, state.lastBuild?.entryHtmlId);
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `bundler_session_${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 250);
};
const projectInput = byId<HTMLInputElement>("projectInput");
byId<HTMLButtonElement>("importProjectBtn").onclick = () => projectInput.click();
projectInput.onchange = async () => {
  const file = projectInput.files?.[0];
  if (!file) return;
  const session = parseSessionSnapshot(await file.text()) as SessionSnapshot;
  state.assets = session.assets.map((asset) => ({ ...asset, size: assetByteSize(asset) }));
  state.activeAssetId = session.activeAssetId;
  applyConfigToUI(session.config);
  renderAssetList();
  selectAsset(state.activeAssetId ?? state.assets[0]?.id);
  projectInput.value = "";
  showToast("Session Loaded", "success");
};

updateFilenameLabels();
updateZipToggleState();
renderAssetList();
renderBuildReport();
renderConverter();
setActiveTab("workspace");
log(`System initialized. Detected <span class="text-[#58CC02] font-bold">${navigator.hardwareConcurrency || 1}</span> logical CPU cores.`);
