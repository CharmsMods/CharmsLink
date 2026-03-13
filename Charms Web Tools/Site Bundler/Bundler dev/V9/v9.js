    // Library fallback and initialization
    var tailwind = window.tailwind || null;

    // HTML Minifier
    var HTMLMinifier = window.HTMLMinifier || null;
    var minifyHTML = (HTMLMinifier && HTMLMinifier.minify) ? HTMLMinifier.minify : function (h) { console.warn('HTMLMinifier not loaded'); return h; };

    // CleanCSS
    var CleanCSS = window.CleanCSS || function () { console.warn('CleanCSS not loaded'); return { minify: function (c) { return { styles: c }; } }; };

    // Terser
    var Terser = window.Terser || null;
    console.log('Terser Object:', Terser);
    var minifyJS = (Terser && Terser.minify) ? Terser.minify : null;
    if (!minifyJS) console.warn('Terser.minify is missing!');

    // Diff
    var Diff = window.Diff || null;

    // Connectivity State
    let cdnAvailable = false;
    const cdnToggle = document.getElementById('optCDN');
    const cdnContainer = document.getElementById('cdnToggleContainer');
    const cdnStatus = document.getElementById('cdnStatus');

    const checkConnectivity = async () => {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2000);
        // Cache-Busting Check
        await fetch(`https://esm.sh/clean-css?t=${Date.now()}`, { method: 'HEAD', signal: controller.signal });
        clearTimeout(id);

        cdnAvailable = true;
        cdnToggle.disabled = false;
        cdnContainer.classList.remove('opacity-50');
        cdnContainer.title = "Switch to CDN versions";
        cdnStatus.innerText = "Online. CDN Available.";
        cdnStatus.classList.add('text-[#58CC02]');
        cdnStatus.classList.remove('text-[#888]');
      } catch (e) {
        cdnAvailable = false;
        cdnToggle.disabled = true;
        cdnToggle.checked = false;
        cdnContainer.classList.add('opacity-50');
        cdnContainer.title = "Offline or CDN Unreachable";
        cdnStatus.innerText = "Offline / CDN Unreachable";
      }
    };

    window.addEventListener('load', checkConnectivity);

    // Hybrid Library Resolver
    let cachedCDNLibs = null;
    let isFetchingCDN = false;

    const resolveLibraries = async () => {
      const useCDN = cdnToggle.checked;

      if (!useCDN) {
        return {
          CleanCSS: window.CleanCSS,
          minifyHTML: (window.HTMLMinifier && window.HTMLMinifier.minify) ? window.HTMLMinifier.minify : null,
          minifyJS: (window.Terser && window.Terser.minify) ? window.Terser.minify : null
        };
      }

      if (cachedCDNLibs) {
        log("Using cached CDN libraries.");
        return cachedCDNLibs;
      }

      if (isFetchingCDN) {
        log("Waiting for ongoing CDN download...");
        // Simple polling if double-clicked
        while (isFetchingCDN) await new Promise(r => setTimeout(r, 100));
        return cachedCDNLibs;
      }

      isFetchingCDN = true;
      // CDN Mode - Parallel Loading with Timeout & Cache Busting
      log("Initializing CDN download (Network Forced)...");

      const session = Date.now(); // Unique ID for this build session

      const loadWithTimeout = async (url, name) => {
        const forcedUrl = `${url}?v=${session}`;
        log(`Fetching ${name}...`);
        try {
          const importPromise = import(forcedUrl);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout fetching ${name}`)), 15000));
          return await Promise.race([importPromise, timeoutPromise]);
        } catch (e) {
          throw new Error(`Failed to load ${name}: ${e.message}`);
        }
      };

      try {
        // Parallel CDN imports for faster loading
        const [cssMod, htmlMod, jsMod] = await Promise.all([
          loadWithTimeout("https://esm.sh/clean-css", "CleanCSS"),
          loadWithTimeout("https://esm.sh/html-minifier-terser", "HTMLMinifier"),
          loadWithTimeout("https://esm.sh/terser", "Terser")
        ]);

        log("All CDN libraries loaded successfully.");

        cachedCDNLibs = {
          CleanCSS: cssMod.default,
          minifyHTML: htmlMod.minify,
          minifyJS: jsMod.minify
        };
        isFetchingCDN = false;
        return cachedCDNLibs;
      } catch (e) {
        isFetchingCDN = false;
        console.error("CDN Resolution Failed:", e);
        throw e;
      }
    };

    const createEmptyBuildMeta = () => ({
      mode: 'inline',
      includedAssetIds: [],
      includedMediaIds: [],
      secondaryHtmlIds: [],
      excludedAssetIds: [],
      generatedEntry: false,
      entryHtmlName: '',
      configSnapshot: null,
      report: null,
      workerCount: 0,
      buildDurationMs: 0
    });

    let assets = [];
    let activeAssetId = null;
    let outputs = { html: "", css: "", js: "" };
    let originals = { html: "", css: "", js: "", bundle: "" };
    let finals = { html: "", css: "", js: "", bundle: "" };
    let batchFiles = [];
    let bundleHtmlOutputs = [];
    let currentDiffTab = 'html';
    let previewHtml = "";
    let buildMeta = createEmptyBuildMeta();
    let precomputedDiffs = { html: null, css: null, js: null, bundle: null };
    let diffCacheState = { html: 'stale', css: 'stale', js: 'stale', bundle: 'stale' };
    let diffRequestToken = 0;
    const assetSizeCache = new Map();
    const MAX_JS_REFERENCE_SCAN = 800000;
    const MAX_JS_REFERENCE_MATCHES = 2000;
    const MAX_JS_STRING_LENGTH = 260;
    const KNOWN_ASSET_EXTENSIONS = new Set([
      'html', 'htm', 'css', 'js', 'json', 'map', 'webmanifest', 'wasm',
      'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif',
      'woff', 'woff2', 'ttf', 'otf', 'eot',
      'mp4', 'webm', 'ogg', 'mp3', 'wav', 'm4a',
      'pdf', 'txt', 'csv', 'xml'
    ]);

    // UI Elements
    const logBox = document.getElementById("logBox");
    const assetList = document.getElementById("assetList");
    const mainEditor = document.getElementById("mainEditor");
    const mediaView = document.getElementById("mediaView");
    const imgPreview = document.getElementById("imgPreview");
    const base64Summary = document.getElementById("base64Summary");
    const currentFileName = document.getElementById("currentFileName");
    const buildStatus = document.getElementById("build-status");
    const noAssetPrompt = document.getElementById("noAssetPrompt");
    const editorHeader = document.getElementById("editorHeader");
    const assetCount = document.getElementById("assetCount");
    const previewFrame = document.getElementById("previewFrame");
    const outNameH = document.getElementById("outNameH");
    const outNameC = document.getElementById("outNameC");
    const outNameJ = document.getElementById("outNameJ");
    const lblH = document.getElementById("lblH");
    const lblC = document.getElementById("lblC");
    const lblJ = document.getElementById("lblJ");
    const downAll = document.getElementById("downA");
    const scanMissingBtn = document.getElementById("scanMissing");
    const linkZipToggle = document.getElementById("optLinkZip");
    const linkZipLabel = document.getElementById("linkZipLabel");
    const linkZipHint = document.getElementById("linkZipHint");
    const buildReportSummary = document.getElementById("buildReportSummary");
    const reportMode = document.getElementById("reportMode");
    const reportAssets = document.getElementById("reportAssets");
    const reportInput = document.getElementById("reportInput");
    const reportOutput = document.getElementById("reportOutput");
    const reportSavings = document.getElementById("reportSavings");
    const reportWorkers = document.getElementById("reportWorkers");
    const buildReportNotes = document.getElementById("buildReportNotes");
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingSubtext = document.getElementById('loadingSubtext');
    const loadingProgressContainer = document.getElementById('loadingProgressContainer');
    const loadingProgressBar = document.getElementById('loadingProgressBar');
    const loadingProgressText = document.getElementById('loadingProgressText');

    // Modal Elements
    const usageModal = document.getElementById("usageModalOverlay");
    const refList = document.getElementById("referencedList");
    const unrefList = document.getElementById("unreferencedList");
    const modalProceed = document.getElementById("modalProceed");
    const modalCancel = document.getElementById("modalCancel");
    const missingRefsOverlay = document.getElementById("missingRefsOverlay");
    const missingRefsList = document.getElementById("missingRefsList");
    const missingRefsClose = document.getElementById("missingRefsClose");
    const entryHtmlOverlay = document.getElementById("entryHtmlOverlay");
    const entryHtmlList = document.getElementById("entryHtmlList");
    const entryHtmlProceed = document.getElementById("entryHtmlProceed");
    const entryHtmlCancel = document.getElementById("entryHtmlCancel");

    const log = (msg) => {
      if (logBox.children.length === 1 && logBox.querySelector('.italic')) logBox.innerHTML = '';
      const entry = document.createElement("div");
      entry.className = "log-line border-l-2 border-[#333] pl-3 py-1 mb-2 hover:bg-white/5 transition-colors";
      const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      entry.innerHTML = `<span class="text-[#555] font-mono mr-3">[${time}]</span> ${msg}`;
      logBox.appendChild(entry);
      logBox.scrollTop = logBox.scrollHeight;
    };

    const formatBytes = (bytes, decimals = 1) => {
      if (!+bytes) return '0 B';
      const k = 1024;
      const dm = decimals < 0 ? 0 : decimals;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    };

    const escapeHtml = (value = "") => value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalizePath = (value = "") => value
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '');
    const stripQueryHash = (value = "") => value.split(/[?#]/)[0];
    const stripLeadingRelative = (value = "") => value.replace(/^(\.\/)+/, '').replace(/^(\.\.\/)+/, '');
    const getBasename = (value = "") => {
      const norm = normalizePath(value);
      if (!norm) return '';
      const parts = norm.split('/');
      return parts[parts.length - 1] || '';
    };
    const getDirname = (value = "") => {
      const norm = normalizePath(value);
      const idx = norm.lastIndexOf('/');
      return idx === -1 ? '' : norm.slice(0, idx);
    };
    const isExternalRef = (value = "") => /^(data:|blob:|file:|https?:|mailto:|tel:|#|\/\/|javascript:)/i.test(value.trim());
    const looksLikeAssetPath = (value = "") => {
      if (!value || value.length > 300) return false;
      if (isExternalRef(value)) return false;
      const cleaned = stripQueryHash(value).trim();
      if (!cleaned) return false;
      const match = cleaned.match(/\.([a-zA-Z0-9]{1,8})$/);
      if (!match) return false;
      const ext = match[1].toLowerCase();
      return KNOWN_ASSET_EXTENSIONS.has(ext);
    };
    const getAssetPath = (asset) => normalizePath(asset?.path || asset?.name || '');
    const getRelativePath = (fromDir = "", toPath = "") => {
      if (!fromDir) return normalizePath(toPath);
      const fromParts = normalizePath(fromDir).split('/').filter(Boolean);
      const toParts = normalizePath(toPath).split('/').filter(Boolean);
      while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
        fromParts.shift();
        toParts.shift();
      }
      const up = fromParts.map(() => '..');
      const combined = [...up, ...toParts];
      return combined.join('/') || toParts.join('/') || '';
    };
    const getAssetNameCandidates = (asset) => {
      const path = getAssetPath(asset);
      const name = normalizePath(asset?.name || path);
      const baseFromPath = getBasename(path);
      const baseFromName = getBasename(name);
      return Array.from(new Set([path, name, baseFromPath, baseFromName].filter(Boolean)));
    };

    const getDataUrlByteSize = (content = "") => {
      const commaIndex = content.indexOf(',');
      if (commaIndex === -1) return new Blob([content]).size;
      const base64 = content.slice(commaIndex + 1);
      const paddingMatch = base64.match(/=+$/);
      const padding = paddingMatch ? paddingMatch[0].length : 0;
      return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
    };

    const getAssetByteSize = (asset) => {
      if (!asset) return 0;
      if (asset.type === 'media' || asset.type === 'image') return getDataUrlByteSize(asset.content);
      return new Blob([asset.content || ""]).size;
    };

    const syncActiveEditorToAsset = () => {
      if (!activeAssetId) return null;
      const current = assets.find(a => a.id === activeAssetId);
      if (current && current.type !== 'media') {
        current.content = mainEditor.value;
        assetSizeCache.delete(current.id);
      }
      return current;
    };

    const resetBuildMeta = () => {
      previewHtml = "";
      buildMeta = createEmptyBuildMeta();
    };

    const invalidateDiffCache = () => {
      precomputedDiffs = { html: null, css: null, js: null, bundle: null };
      diffCacheState = { html: 'stale', css: 'stale', js: 'stale', bundle: 'stale' };
      diffRequestToken += 1;
    };

    const updateFilenameLabels = () => {
      lblH.textContent = outNameH.value.trim() || 'index.min.html';
      lblC.textContent = outNameC.value.trim() || 'styles.min.css';
      lblJ.textContent = outNameJ.value.trim() || 'scripts.min.js';
    };

    const injectIntoHead = (html, block) => {
      if (!block) return html;
      if (!html) return block;
      if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}\n</head>`);
      if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, match => `${block}\n${match}`);
      if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${block}\n</html>`);
      return `${html}\n${block}`;
    };

    const injectBeforeBodyEnd = (html, block) => {
      if (!block) return html;
      if (!html) return block;
      if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${block}\n</body>`);
      if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${block}\n</html>`);
      return `${html}\n${block}`;
    };

    const stripLocalAssetTags = (html, options = {}) => {
      if (!html) return html;
      const treatFileAsLocal = options.treatFileAsLocal !== false;
      const isLocalRef = (value = "") => {
        const trimmed = value.trim();
        if (!trimmed) return false;
        if (treatFileAsLocal && /^file:/i.test(trimmed)) return true;
        return !isExternalRef(trimmed);
      };

      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script[src]').forEach(tag => {
          const src = tag.getAttribute('src') || '';
          if (isLocalRef(src)) tag.remove();
        });
        doc.querySelectorAll('link[rel]').forEach(tag => {
          const rel = (tag.getAttribute('rel') || '').toLowerCase();
          if (!rel.includes('stylesheet')) return;
          const href = tag.getAttribute('href') || '';
          if (isLocalRef(href)) tag.remove();
        });
        const serialized = doc.documentElement ? doc.documentElement.outerHTML : html;
        const hasDoctype = /<!doctype/i.test(html);
        return hasDoctype ? `<!DOCTYPE html>\n${serialized}` : serialized;
      } catch (err) {
        return html;
      }
    };

    const replaceMediaReferences = (text, mediaAssets) => {
      let updated = text || "";
      mediaAssets.forEach(media => {
        const candidates = getAssetNameCandidates(media);
        candidates.forEach(candidate => {
          const escapedName = escapeRegex(candidate);
          const refRegex = new RegExp(`(^|[\\s"'(,=])(?:[^\\s"'(),=]*[\\\\/])?${escapedName}(?:[?#][^\\s"'(),=]*)?(?=($|[\\s"'),]))`, 'gm');
          updated = updated.replace(refRegex, (match, prefix = '') => `${prefix}${media.content}`);
        });
      });
      return updated;
    };

    const createVirtualHtmlAsset = (mode) => ({
      id: `virtual-wrapper-${mode}`,
      type: 'html',
      name: 'index.generated.html',
      path: 'index.generated.html',
      content: '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Bundled App</title>\n</head>\n<body>\n  <main id="app"></main>\n</body>\n</html>'
    });

    const createBatchPreviewMarkup = () => "<html><body><h2 style='font-family:monospace; text-align:center; margin-top:20%'>BATCH MODE PREVIEW UNAVAILABLE<br>Download ZIP to inspect files.</h2></body></html>";

    const buildPreviewDocument = (config, finalHTML, combinedCSS, combinedJS, mediaAssets) => {
      if (config.mode === 'batch') return createBatchPreviewMarkup();
      let previewDoc = finalHTML || '';
      if ((combinedCSS || combinedJS) && config.mode !== 'batch') {
        previewDoc = stripLocalAssetTags(previewDoc, { treatFileAsLocal: true });
      }
      if (config.mode === 'bundle') {
        if (combinedCSS) previewDoc = injectIntoHead(previewDoc, `<style data-preview-inline="css">\n${combinedCSS}\n</style>`);
        if (combinedJS) previewDoc = injectBeforeBodyEnd(previewDoc, `<script data-preview-inline="js">\n${combinedJS}\n<\/script>`);
      }
      if (mediaAssets.length) previewDoc = replaceMediaReferences(previewDoc, mediaAssets);
      return previewDoc;
    };

    const getPreviewDocument = (config = (buildMeta.mode ? { mode: buildMeta.mode } : getBuildConfig())) => {
      if (config.mode === 'batch') return createBatchPreviewMarkup();
      return previewHtml || outputs.html || "";
    };

    const renderBuildReport = () => {
      const report = buildMeta.report;
      if (!report) {
        buildReportSummary.textContent = 'Run a build to generate artifact metrics and workflow notes.';
        reportMode.textContent = '-';
        reportAssets.textContent = '-';
        reportInput.textContent = '-';
        reportOutput.textContent = '-';
        reportSavings.textContent = '-';
        reportWorkers.textContent = '-';
        buildReportNotes.textContent = 'No build notes yet.';
        return;
      }

      buildReportSummary.textContent = report.summary;
      reportMode.textContent = report.mode;
      reportAssets.textContent = `${report.includedAssets} IN / ${report.emittedArtifacts} OUT`;
      reportInput.textContent = formatBytes(report.inputBytes);
      reportOutput.textContent = formatBytes(report.outputBytes);
      reportSavings.textContent = report.savedBytes >= 0
        ? `${formatBytes(report.savedBytes)} (${report.savedPct.toFixed(1)}%)`
        : `+${formatBytes(Math.abs(report.savedBytes))}`;
      reportWorkers.textContent = `${report.workerCount} • ${report.durationMs.toFixed(0)}ms`;
      buildReportNotes.innerHTML = report.notes.length
        ? report.notes.map(note => `<div>&gt; ${escapeHtml(note)}</div>`).join('')
        : 'No build notes yet.';
    };

    const updateDownloadUI = (config = getBuildConfig()) => {
      if (config.mode === 'batch') {
        document.getElementById("downH").classList.add('hidden');
        document.getElementById("downC").classList.add('hidden');
        document.getElementById("downJ").classList.add('hidden');
        document.getElementById("optZip").checked = true;
        downAll.textContent = 'Download ZIP';
      } else {
        document.getElementById("downH").classList.toggle('hidden', !outputs.html);
        document.getElementById("downC").classList.toggle('hidden', !outputs.css);
        document.getElementById("downJ").classList.toggle('hidden', !outputs.js);
        downAll.textContent = config.mode === 'inline' ? 'Download Output' : 'Download Bundle';
      }
    };

    const resetBuildUI = () => {
      document.body.classList.remove('is-processing');
      buildStatus.classList.add('hidden');
      loadingOverlay.classList.remove('active');
      loadingSubtext.classList.add('hidden');
      loadingProgressContainer.classList.add('hidden');
    };

    const readFileAsDataURL = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });

    const checkModeAvailability = () => {
      const hasHtml = assets.some(a => a.type === 'html');
      const modeSelect = document.getElementById("mode");
      const inlineOpt = modeSelect.querySelector('option[value="inline"]');
      const bundleOpt = modeSelect.querySelector('option[value="bundle"]');
      const batchOpt = modeSelect.querySelector('option[value="batch"]');
      const totalAssets = assets.length;

      if (totalAssets === 0) {
        if (inlineOpt) {
          inlineOpt.disabled = false;
          inlineOpt.textContent = "Single HTML Bundle (Inline)";
        }
        if (bundleOpt) {
          bundleOpt.disabled = false;
          bundleOpt.textContent = "Bundle (Combine by Type)";
        }
        if (batchOpt) {
          batchOpt.disabled = false;
          batchOpt.textContent = "Batch (Minify Individual Files)";
        }
        return;
      }

      if (totalAssets === 1) {
        if (inlineOpt) {
          inlineOpt.disabled = false;
          inlineOpt.textContent = "Single HTML Bundle (Inline)";
        }
        if (bundleOpt) {
          bundleOpt.disabled = true;
          bundleOpt.textContent = "Bundle (Add more files)";
        }
        if (batchOpt) {
          batchOpt.disabled = true;
          batchOpt.textContent = "Batch (Add more files)";
        }
        if (modeSelect.value !== 'inline') {
          modeSelect.value = 'inline';
          updateZipToggleState();
          showToast("Single file detected. Switched to Inline mode.", "info");
        }
        return;
      }

      if (!hasHtml) {
        if (inlineOpt) {
          inlineOpt.disabled = true;
          inlineOpt.textContent = "Single HTML Bundle (Requires HTML File)";
        }
        if (modeSelect.value === 'inline') {
          modeSelect.value = 'bundle';
          updateZipToggleState();
          showToast("Switched to Bundle mode (No HTML)", "info");
        }
      } else if (inlineOpt) {
        inlineOpt.disabled = false;
        inlineOpt.textContent = "Single HTML Bundle (Inline)";
      }

      if (bundleOpt) {
        bundleOpt.disabled = false;
        bundleOpt.textContent = "Bundle (Combine by Type)";
      }
      if (batchOpt) {
        batchOpt.disabled = false;
        batchOpt.textContent = "Batch (Minify Individual Files)";
      }
    };

    const renderAssetList = () => {
      assetCount.innerText = assets.length;

      checkModeAvailability();

      if (assets.length === 0) {
        assetList.innerHTML = '';
        noAssetPrompt.classList.remove('hidden');
        editorHeader.classList.add('hidden');
        mainEditor.classList.add('hidden');
        mediaView.classList.add('hidden');
        return;
      }

      noAssetPrompt.classList.add('hidden');
      editorHeader.classList.remove('hidden');

      // Identify Entry Point (first HTML)
      const firstHtmlId = assets.find(a => a.type === 'html')?.id;

      // Use DocumentFragment for efficient DOM updates
      const frag = document.createDocumentFragment();

      assets.forEach((asset, index) => {
        const div = document.createElement('div');
        div.className = `asset-item px-4 py-3 cursor-pointer flex justify-between items-center group relative ${asset.id === activeAssetId ? 'active' : ''}`;

        // Use cached size or compute and cache it
        let size;
        if (assetSizeCache.has(asset.id)) {
          size = assetSizeCache.get(asset.id);
        } else {
          size = getAssetByteSize(asset);
          assetSizeCache.set(asset.id, size);
        }
        const sizeStr = formatBytes(size);

        let icon = '📄';
        if (asset.type === 'css') icon = '🎨';
        if (asset.type === 'js') icon = '⚡';
        if (asset.type === 'media') icon = '🖼️';

        const isEntryPoint = asset.id === firstHtmlId;
        const displayName = escapeHtml(asset.name || 'untitled');
        const displayPath = asset.path && asset.path !== asset.name ? escapeHtml(asset.path) : '';

        div.innerHTML = `
          <div class="flex items-center gap-3 overflow-hidden flex-1" onclick="selectAsset('${asset.id}')">
            <span class="text-lg">${icon}</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-xs font-mono font-bold truncate ${asset.id === activeAssetId ? 'text-[#121212]' : 'text-[#666]'} group-hover:text-[#121212] transition-colors" title="${escapeHtml(asset.path || asset.name)}">${displayName}</span>
                ${isEntryPoint ? '<span class="text-[8px] bg-[#121212] text-white px-1 font-bold uppercase tracking-wider">ENTRY</span>' : ''}
              </div>
              ${displayPath ? `<span class="text-[9px] text-[#777] font-mono truncate">${displayPath}</span>` : ''}
              <span class="text-[9px] text-[#888] font-mono">${sizeStr} • ${asset.type.toUpperCase()}</span>
            </div>
          </div>
          
          <div class="asset-controls flex items-center gap-1 pl-2">
             <button onclick="moveAsset('${asset.id}', -1)" class="p-1 hover:bg-[#121212] hover:text-white rounded text-[#555] transition-colors" title="Move Up">↑</button>
             <button onclick="moveAsset('${asset.id}', 1)" class="p-1 hover:bg-[#121212] hover:text-white rounded text-[#555] transition-colors" title="Move Down">↓</button>
             <button onclick="duplicateAsset('${asset.id}')" class="p-1 hover:bg-[#121212] hover:text-white rounded text-[#555] transition-colors" title="Duplicate">❐</button>
             <button onclick="renameAsset('${asset.id}')" class="p-1 hover:bg-[#121212] hover:text-white rounded text-[#555] transition-colors" title="Rename">✎</button>
          </div>
        `;
        frag.appendChild(div);
      });

      // Single DOM update
      assetList.innerHTML = '';
      assetList.appendChild(frag);
    };

    // --- TOAST SYSTEM ---
    const showToast = (msg, type = 'info') => {
      const toast = document.createElement('div');
      const color = type === 'error' ? '#FF3366' : '#58CC02';
      toast.className = "fixed bottom-8 right-8 bg-[#121212] text-white px-6 py-4 font-bold uppercase tracking-wider transition-all duration-300 transform translate-y-20 opacity-0 z-[200] border-l-4";
      toast.style.boxShadow = `4px 4px 0 ${color}`;
      toast.style.borderLeftColor = color;
      toast.innerHTML = `<span style="color:${color}">></span> ${msg}`;
      document.body.appendChild(toast);

      // Animate in
      requestAnimationFrame(() => {
        toast.classList.remove('translate-y-20', 'opacity-0');
      });

      // Remove
      setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    };

    // --- ASSET ACTIONS ---

    window.selectAsset = (id) => {
      if (!id) {
        syncActiveEditorToAsset();
        activeAssetId = null;
        renderAssetList();
        return;
      }

      syncActiveEditorToAsset();

      activeAssetId = id;
      const next = assets.find(a => a.id === id);
      if (!next) return;

      currentFileName.innerText = next.name;

      if (next.type === 'media') {
        mainEditor.classList.add('hidden');
        mediaView.classList.remove('hidden');
        imgPreview.src = next.content;
        base64Summary.innerText = next.content.substring(0, 80) + "...";
      } else {
        mainEditor.classList.remove('hidden');
        mediaView.classList.add('hidden');
        mainEditor.value = next.content;
      }

      renderAssetList();
    };

    mainEditor.addEventListener('input', () => {
      syncActiveEditorToAsset();
    });

    window.moveAsset = (id, direction) => {
      const index = assets.findIndex(a => a.id === id);
      if (index < 0) return;

      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= assets.length) return;

      // Swap
      [assets[index], assets[newIndex]] = [assets[newIndex], assets[index]];
      renderAssetList();
    };

    window.renameAsset = (id) => {
      const asset = assets.find(a => a.id === id);
      if (!asset) return;

      const newName = prompt("Rename asset:", asset.name);
      if (newName && newName.trim() !== "") {
        const trimmed = newName.trim();
        asset.name = trimmed;
        asset.path = trimmed;
        if (activeAssetId === id) currentFileName.innerText = asset.name;
        renderAssetList();
      }
    };

    window.duplicateAsset = (id) => {
      syncActiveEditorToAsset();
      const asset = assets.find(a => a.id === id);
      if (!asset) return;

      const newId = crypto.randomUUID();
      const newName = asset.name.replace(/(\.[^.]*)?$/, " (Copy)$1");
      const originalPath = getAssetPath(asset);
      const newPath = originalPath
        ? (getDirname(originalPath) ? `${getDirname(originalPath)}/${newName}` : newName)
        : newName;

      assets.push({
        id: newId,
        type: asset.type,
        name: newName,
        path: newPath,
        content: asset.content
      });

      log(`Duplicated: ${asset.name} -> ${newName}`);
      showToast("Asset Duplicated");
      selectAsset(newId);
    };

    const addAsset = (type, name, content, path = name) => {
      const id = crypto.randomUUID();
      assets.push({ id, type, name, path, content });
      assetSizeCache.delete(id);
      log(`Imported: <span class="text-[#58CC02] font-bold">${name}</span>`);
      selectAsset(id);
    };

    // Help Modal Logic
    const helpModal = document.getElementById("helpModalOverlay");
    document.getElementById("openHelp").onclick = () => helpModal.classList.remove('hidden');
    document.getElementById("closeHelp").onclick = () => helpModal.classList.add('hidden');
    helpModal.onclick = (e) => {
      if (e.target === helpModal) helpModal.classList.add('hidden');
    };

    // Controls
    document.getElementById("addHtml").onclick = () => {
      const name = `page-${assets.filter(a => a.type === 'html').length + 1}.html`;
      addAsset('html', name, '<!DOCTYPE html>\n<html>\n<body>\n  \n</body>\n</html>', name);
    };
    document.getElementById("addCss").onclick = () => {
      const name = `style-${assets.filter(a => a.type === 'css').length + 1}.css`;
      addAsset('css', name, '/* Styles */\n', name);
    };
    document.getElementById("addJs").onclick = () => {
      const name = `script-${assets.filter(a => a.type === 'js').length + 1}.js`;
      addAsset('js', name, '// Script\n', name);
    };

    document.getElementById("removeAsset").onclick = () => {
      const removed = assets.find(a => a.id === activeAssetId);
      if (removed) log(`Deleted asset: ${removed.name}`);

      assets = assets.filter(a => a.id !== activeAssetId);
      if (assets.length > 0) {
        selectAsset(assets[assets.length - 1].id);
      } else {
        selectAsset(null);
      }
    };

    document.querySelectorAll(".tab-btn").forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll(".tab-btn").forEach(e => e.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(e => e.classList.add("hidden"));
        tab.classList.add("active");
        document.getElementById(tab.dataset.tab).classList.remove("hidden");
      };
    });

    // Drag & Drop
    const dropBoundary = document.getElementById("dropBoundary");
    const dropOverlay = document.getElementById("dropOverlay");

    const readEntryFiles = async (entry, pathPrefix = "") => {
      if (!entry) return [];
      if (entry.isFile) {
        return new Promise((resolve) => {
          entry.file((file) => {
            file._relativePath = pathPrefix + file.name;
            resolve([file]);
          });
        });
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const files = [];
        const readBatch = () => new Promise(resolve => reader.readEntries(resolve));
        while (true) {
          const entries = await readBatch();
          if (!entries.length) break;
          for (const child of entries) {
            const childPrefix = `${pathPrefix}${entry.name}/`;
            files.push(...await readEntryFiles(child, childPrefix));
          }
        }
        return files;
      }
      return [];
    };

    const collectDroppedFiles = async (dataTransfer) => {
      const items = Array.from(dataTransfer.items || []);
      const files = [];
      if (items.length) {
        for (const item of items) {
          const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
          if (entry) {
            files.push(...await readEntryFiles(entry, ""));
          } else {
            const file = item.getAsFile ? item.getAsFile() : null;
            if (file) files.push(file);
          }
        }
      } else {
        files.push(...Array.from(dataTransfer.files || []));
      }
      return files;
    };

    dropBoundary.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropOverlay.classList.remove('hidden');
    });

    dropBoundary.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null || e.relatedTarget === dropBoundary) {
        dropOverlay.classList.add('hidden');
      }
    });

    dropBoundary.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropOverlay.classList.add('hidden');

      const files = await collectDroppedFiles(e.dataTransfer);
      if (files.length === 0) return;

      for (const file of files) {
        const relativePath = normalizePath(file._relativePath || file.webkitRelativePath || file.name);
        const baseName = getBasename(relativePath) || file.name;
        const ext = baseName.split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
          const content = await readFileAsDataURL(file);
          addAsset('media', baseName, content, relativePath);
        } else {
          const text = await file.text();
          if (['html', 'htm'].includes(ext)) addAsset('html', baseName, text, relativePath);
          else if (ext === 'css') addAsset('css', baseName, text, relativePath);
          else if (ext === 'js') addAsset('js', baseName, text, relativePath);
        }
      }
    });

    // --- CORE FIX: Usage Detection & Protected Build ---

    const normalizeReference = (raw = "") => {
      const trimmed = (raw || '').trim();
      if (!trimmed) return null;
      if (isExternalRef(trimmed)) return null;
      const base = stripQueryHash(trimmed);
      if (!base) return null;
      const normalized = normalizePath(base);
      return normalized || null;
    };

    const extractCssReferences = (css = "") => {
      const refs = [];
      const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      let match;
      while ((match = urlRegex.exec(css)) !== null) {
        refs.push({ raw: match[2], kind: 'CSS url()' });
      }

      const importRegex = /@import\s+(?:url\()?\s*(['"]?)([^'")]+)\1\s*\)?/gi;
      while ((match = importRegex.exec(css)) !== null) {
        refs.push({ raw: match[2], kind: 'CSS @import' });
      }
      return refs;
    };

    const extractJsReferences = (js = "", options = {}) => {
      const refs = [];
      const maxMatches = Number.isFinite(options.maxMatches) ? options.maxMatches : MAX_JS_REFERENCE_MATCHES;
      const maxStringLength = Number.isFinite(options.maxStringLength) ? options.maxStringLength : MAX_JS_STRING_LENGTH;
      if (!js) return { refs, capped: false };

      const len = js.length;
      let capped = false;
      let i = 0;

      while (i < len) {
        const quote = js[i];
        if (quote !== '"' && quote !== "'" && quote !== '`') {
          i += 1;
          continue;
        }

        let j = i + 1;
        let value = '';
        let valueTooLong = false;
        let hasInterpolation = false;

        while (j < len) {
          const ch = js[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (quote === '`' && ch === '$' && js[j + 1] === '{') {
            hasInterpolation = true;
          }
          if (ch === quote) break;
          if (!valueTooLong) {
            if (value.length < maxStringLength) value += ch;
            else valueTooLong = true;
          }
          j += 1;
        }

        if (!hasInterpolation && !valueTooLong && value && looksLikeAssetPath(value)) {
          refs.push({ raw: value, kind: 'JS string' });
          if (refs.length >= maxMatches) {
            capped = true;
            break;
          }
        }

        i = j + 1;
      }

      return { refs, capped };
    };

    const extractHtmlReferences = (html = "") => {
      const refs = [];
      const pushRef = (raw, kind) => {
        if (!raw || !looksLikeAssetPath(raw)) return;
        refs.push({ raw, kind });
      };

      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const attrs = [
          'src', 'href', 'poster', 'content',
          'data-src', 'data-href', 'data-bg', 'data-background',
          'data-image', 'data-video', 'data-audio'
        ];

        doc.querySelectorAll('*').forEach(el => {
          attrs.forEach(attr => {
            if (el.hasAttribute(attr)) pushRef(el.getAttribute(attr), `HTML ${attr}`);
          });

          if (el.hasAttribute('srcset')) {
            const value = el.getAttribute('srcset') || '';
            value.split(',').forEach(part => {
              const [url] = part.trim().split(/\s+/);
              if (url) pushRef(url, 'HTML srcset');
            });
          }

          if (el.hasAttribute('style')) {
            const styleRefs = extractCssReferences(el.getAttribute('style') || '');
            styleRefs.forEach(ref => pushRef(ref.raw, `HTML inline style (${ref.kind})`));
          }
        });

        doc.querySelectorAll('style').forEach(styleTag => {
          const styleRefs = extractCssReferences(styleTag.textContent || '');
          styleRefs.forEach(ref => pushRef(ref.raw, `HTML <style> (${ref.kind})`));
        });

        doc.querySelectorAll('script:not([src])').forEach(scriptTag => {
          const { refs: scriptRefs } = extractJsReferences(scriptTag.textContent || '');
          scriptRefs.forEach(ref => pushRef(ref.raw, `HTML <script> (${ref.kind})`));
        });
      } catch (err) {
        // Fallback: best-effort regex scans if DOM parsing fails
        extractCssReferences(html).forEach(ref => pushRef(ref.raw, `HTML fallback (${ref.kind})`));
        const { refs: fallbackRefs } = extractJsReferences(html);
        fallbackRefs.forEach(ref => pushRef(ref.raw, `HTML fallback (${ref.kind})`));
      }

      return refs;
    };

    const collectAssetReferences = () => {
      const references = [];
      const warnings = [];
      const pushRef = (ref, asset, sourceType) => {
        const normalized = normalizeReference(ref.raw);
        if (!normalized) return;
        references.push({
          raw: ref.raw,
          normalized,
          sourceId: asset.id,
          sourceType,
          sourceName: asset.path || asset.name,
          kind: ref.kind
        });
      };

      assets.forEach(asset => {
        if (asset.type === 'html') {
          extractHtmlReferences(asset.content).forEach(ref => pushRef(ref, asset, 'HTML'));
        } else if (asset.type === 'css') {
          extractCssReferences(asset.content).forEach(ref => pushRef(ref, asset, 'CSS'));
        } else if (asset.type === 'js') {
          let jsContent = asset.content || '';
          if (jsContent.length > MAX_JS_REFERENCE_SCAN) {
            warnings.push(`JS reference scan limited for ${asset.path || asset.name} (${formatBytes(jsContent.length)}).`);
            jsContent = jsContent.slice(0, MAX_JS_REFERENCE_SCAN);
          }
          const { refs: jsRefs, capped } = extractJsReferences(jsContent, { maxMatches: MAX_JS_REFERENCE_MATCHES });
          jsRefs.forEach(ref => pushRef(ref, asset, 'JS'));
          if (capped) warnings.push(`JS reference scan hit the match limit for ${asset.path || asset.name}.`);
        }
      });

      return { references, warnings };
    };

    const buildAssetIndex = (assetList = assets) => {
      const byPath = new Map();
      const byName = new Map();
      const byBase = new Map();

      assetList.forEach(asset => {
        const path = getAssetPath(asset);
        const name = normalizePath(asset.name || path);
        const base = getBasename(path) || getBasename(name);

        if (path) byPath.set(path, asset);
        if (name) byName.set(name, asset);
        if (base) {
          if (!byBase.has(base)) byBase.set(base, []);
          byBase.get(base).push(asset);
        }
      });

      return { byPath, byName, byBase };
    };

    const resolveReferenceAsset = (normalizedRef, index) => {
      if (!normalizedRef) return null;
      if (index.byPath.has(normalizedRef)) return index.byPath.get(normalizedRef);
      if (index.byName.has(normalizedRef)) return index.byName.get(normalizedRef);

      const stripped = stripLeadingRelative(normalizedRef);
      if (stripped && index.byPath.has(stripped)) return index.byPath.get(stripped);
      if (stripped && index.byName.has(stripped)) return index.byName.get(stripped);

      const base = getBasename(normalizedRef);
      const baseMatches = index.byBase.get(base);
      if (baseMatches && baseMatches.length) return baseMatches[0];
      return null;
    };

    const scanProjectReferences = () => {
      const { references, warnings } = collectAssetReferences();
      const index = buildAssetIndex(assets);
      const usedAssetIds = new Set();
      const matched = [];
      const missing = [];

      references.forEach(ref => {
        const asset = resolveReferenceAsset(ref.normalized, index);
        if (asset) {
          usedAssetIds.add(asset.id);
          matched.push({ ref, asset });
        } else {
          missing.push(ref);
        }
      });

      const missingMap = new Map();
      missing.forEach(ref => {
        const key = ref.normalized || ref.raw;
        if (!missingMap.has(key)) {
          missingMap.set(key, { ...ref, sources: new Set([ref.sourceName]) });
        } else {
          missingMap.get(key).sources.add(ref.sourceName);
        }
      });

      const missingList = Array.from(missingMap.values()).map(item => ({
        ...item,
        sources: Array.from(item.sources)
      }));

      return { references, usedAssetIds, matched, missing: missingList, warnings };
    };

    const reportScanWarnings = (warnings = []) => {
      warnings.forEach(msg => {
        log(`<span class="text-yellow-500">Scan warning:</span> ${escapeHtml(msg)}`);
      });
    };

    const summarizeAssetUsage = (scanResult, entryHtmlId = null) => {
      const usedIds = new Set(scanResult.usedAssetIds);
      if (entryHtmlId) usedIds.add(entryHtmlId);

      const detailMap = new Map();
      scanResult.matched.forEach(({ ref, asset }) => {
        if (!detailMap.has(asset.id)) {
          detailMap.set(asset.id, { foundIn: new Set(), detail: new Set() });
        }
        const entry = detailMap.get(asset.id);
        entry.foundIn.add(ref.sourceType);
        entry.detail.add(`${ref.sourceType}: ${ref.kind}`);
      });

      const used = [];
      const unused = [];

      assets.forEach(asset => {
        const info = detailMap.get(asset.id);
        const usagePayload = {
          ...asset,
          foundIn: info ? Array.from(info.foundIn) : [],
          detail: info ? Array.from(info.detail) : []
        };

        if (entryHtmlId && asset.type === 'html' && asset.id !== entryHtmlId) {
          unused.push({
            ...usagePayload,
            detail: ['Non-entry HTML file (ignored).']
          });
          return;
        }

        if (usedIds.has(asset.id)) {
          if (asset.id === entryHtmlId && usagePayload.detail.length === 0) {
            usagePayload.detail = ['Entry HTML selected.'];
          }
          used.push(usagePayload);
        } else {
          unused.push({
            ...usagePayload,
            detail: ['No reference detected. Review dynamic paths before excluding.']
          });
        }
      });

      return { used, unused };
    };

    const getUsageBadge = (asset) => {
      if (asset.type === 'media') return { label: 'MEDIA', color: '#FF3366' };
      if (asset.type === 'html') return { label: 'HTML', color: '#121212' };
      if (asset.type === 'css') return { label: 'CSS', color: '#0055ff' };
      if (asset.type === 'js') return { label: 'JS', color: '#eebb00' };
      return { label: asset.type.toUpperCase(), color: '#666' };
    };

    const buildUsageRow = (asset, isUsed) => {
      const div = document.createElement('div');
      const badge = getUsageBadge(asset);
      const statusColor = isUsed ? '#58CC02' : '#FF3366';
      const displayName = escapeHtml(asset.name || 'untitled');
      const displayPath = asset.path && asset.path !== asset.name ? escapeHtml(asset.path) : '';

      const preview = asset.type === 'media'
        ? `<img src="${asset.content}" class="w-12 h-12 object-cover ${isUsed ? '' : 'grayscale'} border border-[#333]">`
        : `<div class="w-12 h-12 flex items-center justify-center border border-[#333] text-[10px] font-bold" style="background:${badge.color}; color:${badge.color === '#121212' ? '#fff' : '#121212'}">${badge.label}</div>`;

      const foundIn = asset.foundIn && asset.foundIn.length ? `Found in ${escapeHtml(asset.foundIn.join(' + '))}` : (isUsed ? 'Referenced' : 'No reference detected');
      const detailText = asset.detail && asset.detail.length ? escapeHtml(asset.detail.slice(0, 2).join(' • ')) : '';

      div.className = isUsed
        ? 'flex items-center gap-4 bg-white border-[3px] border-[#121212] p-3 shadow-[3px_3px_0_#000]'
        : 'flex items-center gap-4 bg-[#F8F8F3] border-[3px] border-[#ccc] p-3 opacity-70';

      div.innerHTML = `
          ${preview}
          <div class="flex-1 min-w-0">
              <div class="font-mono text-xs font-bold truncate ${isUsed ? 'text-[#121212]' : 'text-[#666]'}" title="${escapeHtml(asset.path || asset.name)}">${displayName}</div>
              ${displayPath ? `<div class="text-[9px] text-[#777] font-mono truncate">${displayPath}</div>` : ''}
              <div class="text-[10px] uppercase ${isUsed ? 'text-[#58CC02]' : 'text-[#FF3366]'} font-bold">${foundIn}</div>
              ${detailText ? `<div class="text-[9px] text-[#555] font-mono mt-1">${detailText}</div>` : ''}
          </div>
          <div class="w-2 h-2 rounded-full" style="background:${statusColor}"></div>
      `;
      return div;
    };

    const showUsageModal = (used, unused) => {
      refList.innerHTML = '';
      unrefList.innerHTML = '';

      used.forEach(asset => refList.appendChild(buildUsageRow(asset, true)));
      unused.forEach(asset => unrefList.appendChild(buildUsageRow(asset, false)));

      usageModal.classList.remove('hidden');
    };

    const showMissingRefsModal = (missingRefs) => new Promise(resolve => {
      missingRefsList.innerHTML = '';
      if (!missingRefs.length) {
        resolve();
        return;
      }

      missingRefs.forEach(ref => {
        const div = document.createElement('div');
        div.className = 'border border-[#121212] bg-white p-3 shadow-[3px_3px_0_#121212]';
        const sources = ref.sources && ref.sources.length ? ref.sources.join(', ') : ref.sourceName;
        div.innerHTML = `
          <div class="font-bold text-xs font-mono text-[#121212]">${escapeHtml(ref.raw)}</div>
          <div class="text-[9px] font-mono text-[#666] mt-1">${escapeHtml(ref.sourceType)} • ${escapeHtml(sources || '')}</div>
        `;
        missingRefsList.appendChild(div);
      });

      const close = () => {
        missingRefsOverlay.classList.add('hidden');
        missingRefsClose.onclick = null;
        missingRefsOverlay.onclick = null;
        resolve();
      };

      missingRefsClose.onclick = close;
      missingRefsOverlay.onclick = (e) => {
        if (e.target === missingRefsOverlay) close();
      };
      missingRefsOverlay.classList.remove('hidden');
    });

    const promptForEntryHtml = (htmlAssets) => new Promise(resolve => {
      entryHtmlList.innerHTML = '';
      if (!htmlAssets.length) {
        resolve(null);
        return;
      }

      let selectedId = htmlAssets[0].id;

      htmlAssets.forEach((asset, index) => {
        const row = document.createElement('label');
        row.className = 'flex items-center gap-3 border-[3px] border-[#121212] bg-white p-3 shadow-[3px_3px_0_#121212] cursor-pointer';
        row.innerHTML = `
          <input type="radio" name="entryHtmlChoice" value="${asset.id}" ${index === 0 ? 'checked' : ''} class="w-4 h-4 accent-[#58CC02]">
          <div class="flex-1 min-w-0">
            <div class="font-mono text-xs font-bold truncate">${escapeHtml(asset.name)}</div>
            ${asset.path && asset.path !== asset.name ? `<div class="text-[9px] text-[#666] font-mono truncate">${escapeHtml(asset.path)}</div>` : ''}
          </div>
        `;
        const input = row.querySelector('input');
        input.onchange = () => {
          selectedId = asset.id;
        };
        entryHtmlList.appendChild(row);
      });

      const close = (result) => {
        entryHtmlOverlay.classList.add('hidden');
        entryHtmlProceed.onclick = null;
        entryHtmlCancel.onclick = null;
        entryHtmlOverlay.onclick = null;
        resolve(result);
      };

      entryHtmlProceed.onclick = () => close(selectedId);
      entryHtmlCancel.onclick = () => close(null);
      entryHtmlOverlay.onclick = (e) => {
        if (e.target === entryHtmlOverlay) close(null);
      };

      entryHtmlOverlay.classList.remove('hidden');
    });

    let pendingBuildContext = null;

    const prepareBuildContext = async () => {
      syncActiveEditorToAsset();
      if (assets.length === 0) {
        showToast('No assets to build.', 'error');
        return null;
      }

      const htmlAssets = assets.filter(a => a.type === 'html');
      let entryHtmlId = htmlAssets.length === 1 ? htmlAssets[0].id : null;
      if (htmlAssets.length > 1) {
        entryHtmlId = await promptForEntryHtml(htmlAssets);
        if (!entryHtmlId) return null;
      }

      let scan;
      try {
        scan = scanProjectReferences();
      } catch (err) {
        console.error("Reference scan failed:", err);
        log(`<span class="text-[#FF3366]">Scan failed:</span> ${escapeHtml(err?.message || String(err))}`);
        showToast("Reference scan failed. Building with all assets.", "error");
        scan = {
          references: [],
          usedAssetIds: new Set(assets.map(asset => asset.id)),
          matched: [],
          missing: [],
          warnings: []
        };
      }

      if (scan.warnings && scan.warnings.length) {
        reportScanWarnings(scan.warnings);
      }

      if (scan.missing.length) {
        await showMissingRefsModal(scan.missing);
      }

      const { used, unused } = summarizeAssetUsage(scan, entryHtmlId);
      const forcedExcludeIds = entryHtmlId ? htmlAssets.filter(a => a.id !== entryHtmlId).map(a => a.id) : [];
      const excludedIds = Array.from(new Set([...unused.map(u => u.id), ...forcedExcludeIds]));

      return { used, unused, excludedIds, entryHtmlId };
    };

    modalCancel.onclick = () => {
      usageModal.classList.add('hidden');
      pendingBuildContext = null;
    };

    modalProceed.onclick = () => {
      usageModal.classList.add('hidden');
      if (!pendingBuildContext) return;
      const excludedCount = pendingBuildContext.excludedIds.length;
      if (excludedCount) {
        log(`<span class="text-[#FF3366] font-bold">Excluding ${excludedCount} unused asset(s) from output.</span>`);
      }
      executeBuild(pendingBuildContext.excludedIds, pendingBuildContext.entryHtmlId);
      pendingBuildContext = null;
    };

    if (scanMissingBtn) {
      scanMissingBtn.onclick = async () => {
        syncActiveEditorToAsset();
        if (assets.length === 0) {
          showToast('No assets to scan.', 'error');
          return;
        }
        let scan;
        try {
          scan = scanProjectReferences();
        } catch (err) {
          console.error("Reference scan failed:", err);
          log(`<span class="text-[#FF3366]">Scan failed:</span> ${escapeHtml(err?.message || String(err))}`);
          showToast('Reference scan failed. Check logs for details.', 'error');
          return;
        }
        if (scan.warnings && scan.warnings.length) {
          reportScanWarnings(scan.warnings);
        }
        if (!scan.missing.length) {
          showToast('No missing references detected.', 'success');
          return;
        }
        await showMissingRefsModal(scan.missing);
      };
    }

    document.getElementById("build").onclick = async () => {
      const ctx = await prepareBuildContext();
      if (!ctx) return;

      if (ctx.unused.length > 0) {
        pendingBuildContext = ctx;
        showUsageModal(ctx.used, ctx.unused);
      } else {
        executeBuild(ctx.excludedIds, ctx.entryHtmlId);
      }
    };

    // --- DIFF SYSTEM ---
    const diffContainer = document.getElementById("diffContainer");
    const previewBox = document.getElementById("previewBox");
    const diffOriginal = document.getElementById("diffOriginal");
    const diffOutput = document.getElementById("diffOutput");
    const diffOriginalLabel = document.getElementById("diffOriginalLabel");
    const diffOutputLabel = document.getElementById("diffOutputLabel");

    const computeDiffMarkup = async (type) => {
      if (diffCacheState[type] === 'ready') return precomputedDiffs[type];
      if (diffCacheState[type] === 'empty') return null;

      diffCacheState[type] = 'working';

      let sOrig = originals[type] || "";
      let sOut = finals[type] || "";

      if (!sOrig && !sOut) {
        precomputedDiffs[type] = null;
        diffCacheState[type] = 'empty';
        return null;
      }

      if (!Diff || typeof Diff.diffLines !== 'function') {
        log("<span class='text-yellow-500'>Warning:</span> Diff library not loaded. Showing raw content.");
        precomputedDiffs[type] = {
          originalHtml: escapeHtml(sOrig),
          outputHtml: escapeHtml(sOut)
        };
        diffCacheState[type] = 'ready';
        return precomputedDiffs[type];
      }

      if (document.getElementById("diffCollapseBase64").checked) {
        const b64Regex = /data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/g;
        sOrig = sOrig.replace(b64Regex, '[...BASE64...]');
        sOut = sOut.replace(b64Regex, '[...BASE64...]');
      }

      const MAX_DIFF_WORDS = 50000;
      const MAX_RAW_SIZE = 250000;
      const totalLength = sOrig.length + sOut.length;

      if (totalLength > MAX_RAW_SIZE) {
        log(`<span class='text-yellow-500'>Warning:</span> Diff skipped for ${type.toUpperCase()} because files are too large (${formatBytes(totalLength)}). Showing raw output to prevent browser crash.`);
        precomputedDiffs[type] = {
          originalHtml: `<span class="text-yellow-600 block mb-4 border-b border-yellow-800 pb-2">File too large to render diff gracefully.</span>\n${escapeHtml(sOrig.substring(0, 10000))}\n\n... (file truncated in view)`,
          outputHtml: `<span class="text-yellow-600 block mb-4 border-b border-yellow-800 pb-2">Showing full text preview only.</span>\n${escapeHtml(sOut)}`
        };
        diffCacheState[type] = 'ready';
        return precomputedDiffs[type];
      }

      const diffWords = Diff.diffWordsWithSpace || Diff.diffWords || Diff.diffLines;
      const parts = totalLength > MAX_DIFF_WORDS
        ? Diff.diffLines(sOrig, sOut)
        : diffWords(sOrig, sOut);

      let outHtml = '';
      let origHtml = '';
      parts.forEach(part => {
        const value = escapeHtml(part.value);
        if (part.added) outHtml += `<span class="bg-green-200 text-green-900 font-bold">${value}</span>`;
        else if (part.removed) origHtml += `<span class="bg-red-200 text-red-900 font-bold">${value}</span>`;
        else {
          outHtml += `<span class="text-gray-500">${value}</span>`;
          origHtml += `<span class="text-gray-500">${value}</span>`;
        }
      });

      precomputedDiffs[type] = { originalHtml: origHtml, outputHtml: outHtml };
      diffCacheState[type] = 'ready';
      return precomputedDiffs[type];
    };

    const generateDiff = async (type = currentDiffTab) => {
      if (typeof type !== 'string') type = currentDiffTab;
      currentDiffTab = type;
      const requestId = ++diffRequestToken;

      // Update tab styling
      document.querySelectorAll('.diff-tab').forEach(tab => {
        tab.classList.remove('active', 'bg-[#333]');
        tab.classList.add('bg-[#222]', 'opacity-50', 'hover:opacity-100');
        tab.disabled = false;
      });

      // Disable/Dim tabs based on available data
      ['html', 'css', 'js', 'bundle'].forEach(t => {
        const tab = document.getElementById(`diffTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
        if (!finals[t] && !originals[t] && tab) {
          tab.classList.add('opacity-30', 'cursor-not-allowed');
          // tab.disabled = true; // Optional: completely disable interaction
        }
      });

      const activeTab = document.getElementById(`diffTab${type.charAt(0).toUpperCase() + type.slice(1)}`);
      if (activeTab) {
        activeTab.classList.add('active', 'bg-[#333]', 'opacity-100');
        activeTab.classList.remove('bg-[#222]', 'opacity-50');
      }

      // Update labels
      const typeLabel = type.toUpperCase();
      diffOriginalLabel.textContent = `Original ${typeLabel}`;
      diffOutputLabel.textContent = `Build Output ${typeLabel}`;

      const wrap = document.getElementById("diffWrap").checked;
      diffOriginal.className = `flex-1 p-4 font-mono text-xs overflow-auto text-[#444] leading-relaxed ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`;
      diffOutput.className = `flex-1 p-4 font-mono text-xs overflow-auto text-[#444] leading-relaxed ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`;

      diffOriginal.innerHTML = '<span class="text-[#888] italic">Preparing diff...</span>';
      diffOutput.innerHTML = '<span class="text-[#888] italic">Preparing diff...</span>';

      try {
        const preloaded = await computeDiffMarkup(type);
        if (requestId !== diffRequestToken) return;

        if (preloaded) {
          diffOriginal.innerHTML = preloaded.originalHtml;
          diffOutput.innerHTML = preloaded.outputHtml;
        } else {
          diffOriginal.innerHTML = '<span class="text-[#888] italic">No content available for this type.</span>';
          diffOutput.innerHTML = '<span class="text-[#888] italic">No content available for this type.</span>';
        }
      } catch (err) {
        if (requestId !== diffRequestToken) return;
        diffOriginal.innerHTML = '<span class="text-[#FF3366] italic">Diff generation failed.</span>';
        diffOutput.innerHTML = `<span class="text-[#FF3366] italic">${escapeHtml(err.message)}</span>`;
        log(`<span class="text-[#FF3366]">Diff Error:</span> ${err.message}`);
      }
    };

    // Tab click handlers
    document.getElementById("diffTabHtml").onclick = () => { void generateDiff('html'); };
    document.getElementById("diffTabCss").onclick = () => { void generateDiff('css'); };
    document.getElementById("diffTabJs").onclick = () => { void generateDiff('js'); };
    document.getElementById("diffTabBundle").onclick = () => { void generateDiff('bundle'); };

    document.getElementById("openNewTab").onclick = () => {
      const previewDoc = getPreviewDocument();
      if (!previewDoc) {
        showToast("Build first to preview in new tab!", "error");
        return;
      }
      const blob = new Blob([previewDoc], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    };


    document.getElementById("diffCollapseBase64").onchange = () => {
      invalidateDiffCache();
      void generateDiff();
    };
    document.getElementById("diffWrap").onchange = () => {
      void generateDiff();
    };

    const getBuildConfig = () => {
      const isCDN = document.getElementById('optCDN').checked;
      return {
        mode: document.getElementById("mode").value,
        minifyHTML: document.getElementById("optMinifyHTML").checked,
        minifyCSS: document.getElementById("optMinifyCSS").checked,
        minifyJS: document.getElementById("optMinifyJS").checked,
        comments: document.getElementById("optComments").checked,
        console: document.getElementById("optConsole").checked,
        useCDN: isCDN,
        linkZip: document.getElementById("optLinkZip").checked
      };
    };

    const getLocalLibraries = () => ({
      CleanCSS: window.CleanCSS,
      minifyHTML: (window.HTMLMinifier && window.HTMLMinifier.minify) ? window.HTMLMinifier.minify : null,
      minifyJS: (window.Terser && window.Terser.minify) ? window.Terser.minify : null
    });

    const splitRefParts = (raw = "") => {
      const match = raw.match(/^([^?#]+)([?#].*)?$/);
      return {
        base: match ? match[1] : raw,
        suffix: match && match[2] ? match[2] : ''
      };
    };

    const resolveReferenceReplacement = (raw, sourceAssetId, outputPathMap, assetIndex) => {
      if (!raw || !looksLikeAssetPath(raw) || isExternalRef(raw)) return raw;
      const { base, suffix } = splitRefParts(raw);
      const normalized = normalizePath(base);
      const targetAsset = resolveReferenceAsset(normalized, assetIndex);
      if (!targetAsset) return raw;

      const targetPath = outputPathMap.get(targetAsset.id) || getAssetPath(targetAsset);
      const sourceAsset = assets.find(a => a.id === sourceAssetId);
      const sourcePath = outputPathMap.get(sourceAssetId) || getAssetPath(sourceAsset);
      const relative = sourcePath ? getRelativePath(getDirname(sourcePath), targetPath) : targetPath;
      const safePath = relative || getBasename(targetPath) || targetPath;
      return `${safePath}${suffix || ''}`;
    };

    const rewriteCssReferences = (css = "", sourceAssetId, outputPathMap, assetIndex) => {
      let updated = css || "";
      updated = updated.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
        const newUrl = resolveReferenceReplacement(url, sourceAssetId, outputPathMap, assetIndex);
        return `url(${quote}${newUrl}${quote})`;
      });
      updated = updated.replace(/@import\s+(url\()?\s*(['"]?)([^'")]+)\2\s*\)?/gi, (match, urlFn, quote, url) => {
        const newUrl = resolveReferenceReplacement(url, sourceAssetId, outputPathMap, assetIndex);
        return urlFn ? `@import url(${quote}${newUrl}${quote})` : `@import ${quote}${newUrl}${quote}`;
      });
      return updated;
    };

    const rewriteJsReferences = (js = "", sourceAssetId, outputPathMap, assetIndex) => {
      return (js || "").replace(/(['"`])((?:\\.|(?!\1).)*?)\1/g, (match, quote, value) => {
        if (!value || value.includes('${')) return match;
        if (!looksLikeAssetPath(value) || isExternalRef(value)) return match;
        const newValue = resolveReferenceReplacement(value, sourceAssetId, outputPathMap, assetIndex);
        if (newValue === value) return match;
        return `${quote}${newValue}${quote}`;
      });
    };

    const rewriteHtmlReferences = (html = "", sourceAssetId, outputPathMap, assetIndex) => {
      let updated = html || "";
      const attrRegex = /(src|href|poster|content|data-src|data-href|data-bg|data-background|data-image|data-video|data-audio)=(["'])([^"']+)\2/gi;
      updated = updated.replace(attrRegex, (match, attr, quote, url) => {
        const newUrl = resolveReferenceReplacement(url, sourceAssetId, outputPathMap, assetIndex);
        return `${attr}=${quote}${newUrl}${quote}`;
      });

      updated = updated.replace(/srcset=(["'])([^"']+)\1/gi, (match, quote, value) => {
        const parts = value.split(',').map(part => {
          const [url, ...rest] = part.trim().split(/\s+/);
          const newUrl = resolveReferenceReplacement(url, sourceAssetId, outputPathMap, assetIndex);
          return [newUrl, ...rest].join(' ');
        });
        return `srcset=${quote}${parts.join(', ')}${quote}`;
      });

      updated = updated.replace(/(style=)(["'])([^"']*)\2/gi, (match, prefix, quote, styleText) => {
        const rewritten = rewriteCssReferences(styleText, sourceAssetId, outputPathMap, assetIndex);
        return `${prefix}${quote}${rewritten}${quote}`;
      });

      updated = updated.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, cssText) => {
        const rewritten = rewriteCssReferences(cssText, sourceAssetId, outputPathMap, assetIndex);
        return `<style${attrs}>${rewritten}</style>`;
      });

      updated = updated.replace(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, jsText) => {
        const rewritten = rewriteJsReferences(jsText, sourceAssetId, outputPathMap, assetIndex);
        return `<script${attrs}>${rewritten}</script>`;
      });

      return updated;
    };

    const computeBatchOutputPath = (asset, config) => {
      let path = getAssetPath(asset) || asset.name || '';
      if (asset.type === 'css' && config.minifyCSS) path = path.replace(/\.css$/i, '.min.css');
      if (asset.type === 'js' && config.minifyJS) path = path.replace(/\.js$/i, '.min.js');
      if (asset.type === 'html' && config.minifyHTML) path = path.replace(/\.html?$/i, match => `.min${match}`);
      return path;
    };

    const prepareBatchOutputs = (processedAssets, config, linkZip) => {
      const assetIndex = buildAssetIndex(processedAssets);
      const tempPaths = new Map();
      const baseCounts = new Map();

      processedAssets.forEach(asset => {
        const path = computeBatchOutputPath(asset, config);
        tempPaths.set(asset.id, path);
        if (linkZip) {
          const base = getBasename(path);
          if (base) baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
        }
      });

      const collisions = new Set();
      baseCounts.forEach((count, base) => {
        if (count > 1) collisions.add(base);
      });

      const outputPathMap = new Map();
      tempPaths.forEach((path, id) => {
        let outputPath = path;
        if (linkZip) {
          const base = getBasename(path);
          if (base && !collisions.has(base)) outputPath = base;
        }
        outputPathMap.set(id, outputPath);
      });

      const rewrittenAssets = processedAssets.map(asset => {
        let content = asset.content;
        if (asset.type === 'html') content = rewriteHtmlReferences(content, asset.id, outputPathMap, assetIndex);
        else if (asset.type === 'css') content = rewriteCssReferences(content, asset.id, outputPathMap, assetIndex);
        else if (asset.type === 'js') content = rewriteJsReferences(content, asset.id, outputPathMap, assetIndex);
        return { ...asset, outputPath: outputPathMap.get(asset.id) || getAssetPath(asset), content };
      });

      return { rewrittenAssets, outputPathMap, collisions };
    };

    const executeBuild = async (excludedIds = [], entryHtmlId = null) => {
      syncActiveEditorToAsset();
      const config = getBuildConfig();
      const buildStartedAt = performance.now();
      const previousBuildState = JSON.parse(JSON.stringify({
        outputs,
        originals,
        finals,
        batchFiles,
        bundleHtmlOutputs,
        previewHtml,
        buildMeta,
        precomputedDiffs,
        diffCacheState
      }));

      // Filter excluded assets
      let buildAssets = assets.filter(a => !excludedIds.includes(a.id));
      let htmlAssetsForBuild = buildAssets.filter(a => a.type === 'html');
      if (entryHtmlId) {
        const preferred = htmlAssetsForBuild.find(a => a.id === entryHtmlId);
        if (preferred) {
          htmlAssetsForBuild = [preferred, ...htmlAssetsForBuild.filter(a => a.id !== entryHtmlId)];
        }
      }
      let htmlSource = htmlAssetsForBuild[0];
      let generatedEntry = false;
      let workerCountUsed = 0;
      let sourceAssets = buildAssets;

      if (htmlAssetsForBuild.length > 1 && config.mode !== 'batch') {
        log(`<span class='text-yellow-500'>Warning:</span> Multiple HTML files detected. Only the first (<span class="font-bold">${htmlSource.name}</span>) will be used as the Bundle entry point.`);
      }

      if (buildAssets.length === 0) {
        log("<span class='text-[#FF3366]'>Error:</span> No assets to build.");
        return;
      }

      // 1. PREPARATION & FALLBACKS
      if ((config.mode === 'inline' || config.mode === 'bundle') && !htmlSource) {
        generatedEntry = true;
        htmlSource = createVirtualHtmlAsset(config.mode);
        log(`<span class='text-yellow-500'>Note:</span> No HTML file found for ${config.mode.toUpperCase()} build. Auto-generating wrapper.`);
        buildAssets = [htmlSource, ...buildAssets];
        htmlAssetsForBuild = [htmlSource];
      }

      sourceAssets = generatedEntry ? buildAssets.filter(a => a.id !== htmlSource.id) : buildAssets;

      buildStatus.classList.remove('hidden');
      document.body.classList.add('is-processing');
      loadingOverlay.classList.add('active');
      loadingProgressContainer.classList.remove('hidden');
      loadingProgressBar.style.width = '0%';
      loadingProgressText.innerText = '0%';
      loadingSubtext.classList.remove('hidden');

      if (config.useCDN) {
        loadingSubtext.innerText = "Preparing CDN-backed build...";
      } else {
        loadingSubtext.innerText = "Initializing build engine...";
      }

      // UI Yield
      await new Promise(resolve => setTimeout(resolve, 0));

      log("Starting modular build sequence...");
      showToast("Build Started...");

      const needsMainThreadHTMLMinifier = config.minifyHTML && config.mode !== 'batch';
      let Libs = getLocalLibraries();

      if (config.useCDN && needsMainThreadHTMLMinifier) {
        try {
          Libs = await resolveLibraries();
        } catch (e) {
          config.useCDN = false;
          Libs = getLocalLibraries();
          log(`<span class="text-yellow-500">CDN Warning:</span> ${e.message}. Falling back to local libraries.`);
          showToast("CDN unavailable. Using local libraries.");
        }
      }

      const _minifyHTML = Libs.minifyHTML;

      // RESET STATE
      batchFiles = [];
      bundleHtmlOutputs = [];
      outputs = { html: "", css: "", js: "" };
      originals = { html: "", css: "", js: "", bundle: "" };
      finals = { html: "", css: "", js: "", bundle: "" };
      resetBuildMeta();
      invalidateDiffCache();

      try {
        // --- 2. TRANSFORMATION PHASE (Parallelized Minification) ---
        // Process all assets in parallel for faster builds

        const cssAssets = buildAssets.filter(a => a.type === 'css');
        const jsAssets = buildAssets.filter(a => a.type === 'js');
        const htmlAssets = buildAssets.filter(a => a.type === 'html');
        const otherAssets = buildAssets.filter(a => !['css', 'js', 'html'].includes(a.type));

        const getBaseUrl = () => {
          const href = window.location.href;
          return href.substring(0, href.lastIndexOf('/') + 1);
        };

        const libsConfig = {
          useCDN: config.useCDN,
          cleanCssUrl: getBaseUrl() + 'lib/clean-css.js',
          htmlMinifierUrl: getBaseUrl() + 'lib/html-minifier.js',
          terserUrl: getBaseUrl() + 'lib/terser.js'
        };

        const workerScript = `
          let libsLoaded = false;
          self.onmessage = async function(e) {
            const { action, id, asset, config, libs } = e.data;
            try {
              if (action === 'init') {
                if (!libsLoaded) {
                  if (libs.useCDN) {
                    const session = Date.now();
                    const [cssMod, htmlMod, jsMod] = await Promise.all([
                      import("https://esm.sh/clean-css?v=" + session),
                      import("https://esm.sh/html-minifier-terser?v=" + session),
                      import("https://esm.sh/terser?v=" + session)
                    ]);
                    self.CleanCSS = cssMod.default;
                    self.HTMLMinifier = htmlMod;
                    self.Terser = jsMod;
                  } else {
                    importScripts(libs.cleanCssUrl, libs.htmlMinifierUrl, libs.terserUrl);
                  }
                  libsLoaded = true;
                }
                self.postMessage({ id, status: 'ready' });
              } else if (action === 'minifyCSS') {
                self.postMessage({ id, report: "Minifying CSS: " + asset.name });
                let content = asset.content;
                if (config.minifyCSS && self.CleanCSS) {
                  let cssOpts = { level: 1, rebase: false };
                  try {
                    const result = new self.CleanCSS(cssOpts).minify(content);
                    content = result.styles || content;
                  } catch (cssErr) {
                    console.error("CleanCSS error:", cssErr);
                  }
                } else if (config.comments) {
                  content = content.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
                }
                self.postMessage({ id, content });
              } else if (action === 'minifyJS') {
                self.postMessage({ id, report: "Compressing JS: " + asset.name });
                let content = asset.content;
                const minifyJS = self.Terser && self.Terser.minify;
                if (config.minifyJS && minifyJS) {
                  content = (await minifyJS(content, { compress: { drop_console: config.console } })).code;
                } else if ((config.comments || config.console) && minifyJS) {
                  const opts = { compress: { drop_console: config.console, defaults: false }, mangle: false, format: { beautify: true, comments: !config.comments } };
                  content = (await minifyJS(content, opts)).code;
                }
                self.postMessage({ id, content });
              } else if (action === 'minifyHTML') {
                self.postMessage({ id, report: "Parsing HTML: " + asset.name });
                let content = asset.content;
                const minifyHTML = self.HTMLMinifier && self.HTMLMinifier.minify;
                const shouldRun = config.minifyHTML || config.minifyCSS || config.minifyJS || config.comments;
                if (shouldRun && minifyHTML) {
                  const jsOpts = config.minifyJS ? { compress: { drop_console: config.console } } : false;
                  const cssOpts = config.minifyCSS ? { level: 1, rebase: false } : false;
                  try {
                    content = await minifyHTML(content, {
                      collapseWhitespace: config.minifyHTML,
                      removeComments: config.comments,
                      minifyCSS: cssOpts,
                      minifyJS: jsOpts,
                      ignoreCustomFragments: [/<script type="x-shader\\/.*?"[\\s\\S]*?<\\/script>/gi]
                    });
                  } catch (htmlErr) {
                    console.error("HTML Minifier error:", htmlErr);
                  }
                }
                self.postMessage({ id, content });
              }
            } catch (err) {
              self.postMessage({ id, error: err.message });
            }
          };
        `;

        const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);

        const tasks = [];
        cssAssets.forEach(asset => tasks.push({ action: 'minifyCSS', asset }));
        jsAssets.forEach(asset => tasks.push({ action: 'minifyJS', asset }));
        htmlAssets.forEach(asset => tasks.push({ action: 'minifyHTML', asset }));

        let processedCss = [];
        let processedJs = [];
        let processedHtml = [];

        if (tasks.length > 0) {
          log("Spawning Web Workers for parallel processing...");
          loadingSubtext.innerText = "Spawning worker pool...";
          if (buildAssets.length === 1 && htmlAssets.length === 1) {
            log("Single HTML detected: Optimizing embedded resources...");
          }
          await new Promise((resolve, reject) => {
            const maxWorkers = navigator.hardwareConcurrency || 4;
            const numWorkers = Math.min(maxWorkers, tasks.length);
            workerCountUsed = numWorkers;
            const workers = [];
            let tasksCompleted = 0;
            let currentTaskIdx = 0;

            const pushToResult = (assetId, action, content) => {
              const originalAsset = buildAssets.find(a => a.id === assetId);
              const processed = { ...originalAsset, content };
              if (action === 'minifyCSS') processedCss.push(processed);
              else if (action === 'minifyJS') processedJs.push(processed);
              else if (action === 'minifyHTML') processedHtml.push(processed);
            };

            const cleanup = () => {
              workers.forEach(w => w.terminate());
              URL.revokeObjectURL(workerUrl);
            };

            for (let i = 0; i < numWorkers; i++) {
              const worker = new Worker(workerUrl);
              workers.push(worker);

              worker.postMessage({ action: 'init', id: 'init', libs: libsConfig });

              worker.onmessage = (e) => {
                const { id, status, content, error, report } = e.data;
                if (error) {
                  cleanup();
                  reject(new Error(error));
                  return;
                }

                if (report) {
                  loadingSubtext.innerText = report;
                  return;
                }

                if (id === 'init') {
                  if (currentTaskIdx < tasks.length) {
                    const taskId = currentTaskIdx++;
                    const task = tasks[taskId];
                    worker.postMessage({
                      action: task.action,
                      id: taskId,
                      asset: task.asset,
                      config: config
                    });
                  }
                } else if (id !== undefined) {
                  const task = tasks[id];
                  pushToResult(task.asset.id, task.action, content);
                  tasksCompleted++;

                  const pct = Math.round((tasksCompleted / tasks.length) * 60);
                  loadingProgressBar.style.width = pct + '%';
                  loadingProgressText.innerText = pct + '%';

                  if (tasksCompleted === tasks.length) {
                    cleanup();
                    resolve();
                    return;
                  }

                  if (currentTaskIdx < tasks.length) {
                    const taskId = currentTaskIdx++;
                    const nextTask = tasks[taskId];
                    worker.postMessage({
                      action: nextTask.action,
                      id: taskId,
                      asset: nextTask.asset,
                      config: config
                    });
                  }
                }
              };
              worker.onerror = (err) => {
                cleanup();
                reject(err);
              };
            }
          });
        }

        loadingSubtext.innerText = "Sorting back into original order...";
        loadingProgressBar.style.width = "65%";
        loadingProgressText.innerText = "65%";
        await new Promise(r => setTimeout(r, 10));

        const sortById = (arr, orig) => orig.map(o => arr.find(a => a.id === o.id)).filter(Boolean);
        processedCss = sortById(processedCss, cssAssets);
        processedJs = sortById(processedJs, jsAssets);
        processedHtml = sortById(processedHtml, htmlAssets);

        const processedAssets = [...processedCss, ...processedJs, ...processedHtml, ...otherAssets];

        // --- 3. ASSEMBLY PHASE ---

        if (config.mode === 'batch') {
          log("Mode: Batch (Passthrough)");
          const linkZip = Boolean(config.linkZip);
          const { rewrittenAssets, collisions } = prepareBatchOutputs(processedAssets, config, linkZip);
          batchFiles = rewrittenAssets;

          originals = { html: "", css: "", js: "", bundle: "" };
          finals = { html: "", css: "", js: "", bundle: "" };
          outputs = { html: "", css: "", js: "" };
          previewHtml = createBatchPreviewMarkup();

          const inputBytes = sourceAssets.reduce((sum, asset) => sum + getAssetByteSize(asset), 0);
          const outputBytes = batchFiles.reduce((sum, asset) => sum + getAssetByteSize(asset), 0);
          const notes = [
            excludedIds.length ? `Excluded ${excludedIds.length} unused asset(s) from this build.` : null,
            linkZip ? 'Link Files in ZIP enabled: references rewritten for batch output.' : 'Link Files in ZIP disabled: original paths preserved.',
            collisions.size ? `Linking skipped for ${collisions.size} colliding filename(s).` : null,
            'Batch mode keeps files separate and disables combined preview output.',
            'Diffs are generated only when a tab is opened.'
          ].filter(Boolean);

          buildMeta = {
            ...createEmptyBuildMeta(),
            mode: config.mode,
            includedAssetIds: sourceAssets.map(a => a.id),
            includedMediaIds: sourceAssets.filter(a => a.type === 'media').map(a => a.id),
            secondaryHtmlIds: [],
            excludedAssetIds: [...excludedIds],
            generatedEntry,
            entryHtmlName: htmlSource ? htmlSource.name : '',
            configSnapshot: { ...config },
            report: {
              mode: 'BATCH',
              includedAssets: sourceAssets.length,
              emittedArtifacts: batchFiles.length,
              inputBytes,
              outputBytes,
              savedBytes: inputBytes - outputBytes,
              savedPct: inputBytes ? ((inputBytes - outputBytes) / inputBytes) * 100 : 0,
              workerCount: workerCountUsed,
              durationMs: performance.now() - buildStartedAt,
              summary: `Batch build completed for ${sourceAssets.length} source assets.`,
              notes
            },
            workerCount: workerCountUsed,
            buildDurationMs: performance.now() - buildStartedAt
          };

        } else {
          // Bundle or Inline
          loadingSubtext.innerText = "Aggregating transformed CSS and JS...";
          loadingProgressBar.style.width = "70%";
          loadingProgressText.innerText = "70%";
          await new Promise(r => setTimeout(r, 10));

          let combinedCSS = processedAssets.filter(a => a.type === 'css').map(a => a.content).join('\n');
          let combinedJS = processedAssets.filter(a => a.type === 'js').map(a => a.content).join('\n');

          let processedHtmlAsset = processedAssets.find(a => a.type === 'html');
          let baseHTML = processedHtmlAsset ? processedHtmlAsset.content : (htmlSource ? htmlSource.content : "");

          // Prepare Originals for Diff (Raw Concatenation of inputs)
          originals.css = sourceAssets.filter(a => a.type === 'css').map(a => a.content).join('\n');
          originals.js = sourceAssets.filter(a => a.type === 'js').map(a => a.content).join('\n');
          originals.html = htmlSource ? htmlSource.content : "";

          // Inline Images Handling (Affects both HTML and CSS content)
          const mediaAssets = buildAssets.filter(a => a.type === 'media');
          if (config.mode === 'inline' && mediaAssets.length > 0) {
            loadingSubtext.innerText = `Inlining ${mediaAssets.length} media asset(s)...`;
            loadingProgressBar.style.width = "75%";
            loadingProgressText.innerText = "75%";
            await new Promise(r => setTimeout(r, 10));

            baseHTML = replaceMediaReferences(baseHTML, mediaAssets);
            combinedCSS = replaceMediaReferences(combinedCSS, mediaAssets);
          }

          // Processing HTML (Minify wrapper if needed)
          if (config.minifyHTML && _minifyHTML) {
            loadingSubtext.innerText = "Performing final HTML optimization pass...";
            await new Promise(r => setTimeout(r, 10));

            const jsOpts = config.minifyJS ? { compress: { drop_console: config.console } } : false;
            const cssOpts = config.minifyCSS ? { level: 1, rebase: false } : false;
            try {
              baseHTML = await _minifyHTML(baseHTML, {
                collapseWhitespace: config.minifyHTML, // Use config.minifyHTML dynamically instead of true
                removeComments: config.comments,
                minifyCSS: cssOpts, // Ensure internal CSS is minified without URL rebasing
                minifyJS: jsOpts,            // Ensure internal JS is minified
                ignoreCustomFragments: [/<script type="x-shader\/.*?"[\s\S]*?<\/script>/gi] // Preserve GLSL shaders
              });
            } catch (err) {
              console.error("Final HTML pass error:", err);
            }
          }

          let finalHTML = baseHTML;

          if (config.mode === 'inline') {
            loadingSubtext.innerText = "Injecting styles and scripts into master HTML...";
            await new Promise(r => setTimeout(r, 10));

            log("Mode: Inline Assembly");
            if (combinedCSS && finalHTML) {
              finalHTML = injectIntoHead(finalHTML, `<style>\n${combinedCSS}\n</style>`);
            }
            if (combinedJS && finalHTML) {
              finalHTML = injectBeforeBodyEnd(finalHTML, `<script>\n${combinedJS}\n<\/script>`);
            }
          } else if (config.mode === 'bundle') {
            log("Mode: Bundle Assembly");
            const cssFilename = outNameC.value.trim() || 'styles.min.css';
            const jsFilename = outNameJ.value.trim() || 'scripts.min.js';

            if (finalHTML) {
              if (combinedCSS) finalHTML = injectIntoHead(finalHTML, `<link rel="stylesheet" href="${cssFilename}">`);
              if (combinedJS) finalHTML = injectBeforeBodyEnd(finalHTML, `<script src="${jsFilename}"><\/script>`);
            }
          }

          outputs = { html: finalHTML, css: combinedCSS, js: combinedJS };
          finals = { ...outputs, bundle: finalHTML };

          originals.bundle = originals.html;
          finals.bundle = finalHTML;

          if (config.mode === 'inline') {
            const minifiedHtmlAsset = processedAssets.find(a => a.type === 'html');
            if (minifiedHtmlAsset) {
              finals.html = minifiedHtmlAsset.content;
            } else {
              finals.html = processedAssets.find(a => a.id === htmlSource.id)?.content || '';
            }
          } else {
            finals.html = finalHTML;
          }

          const secondaryHtmlOutputs = config.mode === 'bundle'
            ? processedHtml.filter(asset => asset.id !== htmlSource.id)
            : [];
          bundleHtmlOutputs = secondaryHtmlOutputs.map(asset => ({ id: asset.id, name: asset.name, path: asset.path || asset.name, content: asset.content, type: asset.type }));

          const previewMediaAssets = config.mode === 'bundle'
            ? mediaAssets
            : mediaAssets.filter(asset => finals.bundle.includes(asset.content));
          previewHtml = buildPreviewDocument(config, finalHTML, combinedCSS, combinedJS, previewMediaAssets);

          const externalArtifactCount = config.mode === 'bundle'
            ? mediaAssets.length + secondaryHtmlOutputs.length
            : 0;
          const externalArtifactBytes = config.mode === 'bundle'
            ? mediaAssets.reduce((sum, asset) => sum + getAssetByteSize(asset), 0) +
              secondaryHtmlOutputs.reduce((sum, asset) => sum + getAssetByteSize(asset), 0)
            : 0;

          const emittedArtifacts = [
            outputs.html ? 1 : 0,
            outputs.css ? 1 : 0,
            outputs.js ? 1 : 0
          ].filter(Boolean).length + externalArtifactCount;
          const inputBytes = sourceAssets.reduce((sum, asset) => sum + getAssetByteSize(asset), 0);
          const outputBytes =
            (outputs.html ? new Blob([outputs.html]).size : 0) +
            (outputs.css ? new Blob([outputs.css]).size : 0) +
            (outputs.js ? new Blob([outputs.js]).size : 0) +
            externalArtifactBytes;

          const notes = [
            generatedEntry ? `Generated ${htmlSource.name} because no HTML entry file was provided.` : `Using ${htmlSource.name} as the entry HTML file.`,
            excludedIds.length ? `Excluded ${excludedIds.length} potentially unused asset(s).` : 'No assets were excluded.',
            secondaryHtmlOutputs.length ? `Preserved ${secondaryHtmlOutputs.length} additional HTML file(s) as separate output artifacts.` : 'No extra HTML pages needed separate output.',
            config.mode === 'bundle'
              ? 'Preview uses an in-memory merged document so external bundle files render correctly.'
              : 'Preview mirrors the generated inline HTML output.',
            'Diffs are generated on demand when each tab is opened.'
          ];

          buildMeta = {
            ...createEmptyBuildMeta(),
            mode: config.mode,
            includedAssetIds: sourceAssets.map(a => a.id),
            includedMediaIds: mediaAssets.map(a => a.id),
            secondaryHtmlIds: secondaryHtmlOutputs.map(a => a.id),
            excludedAssetIds: [...excludedIds],
            generatedEntry,
            entryHtmlName: htmlSource ? htmlSource.name : '',
            configSnapshot: { ...config },
            report: {
              mode: config.mode.toUpperCase(),
              includedAssets: sourceAssets.length,
              emittedArtifacts,
              inputBytes,
              outputBytes,
              savedBytes: inputBytes - outputBytes,
              savedPct: inputBytes ? ((inputBytes - outputBytes) / inputBytes) * 100 : 0,
              workerCount: workerCountUsed,
              durationMs: performance.now() - buildStartedAt,
              summary: `${config.mode.toUpperCase()} build completed with ${sourceAssets.length} source assets and ${emittedArtifacts} emitted artifacts.`,
              notes
            },
            workerCount: workerCountUsed,
            buildDurationMs: performance.now() - buildStartedAt
          };
        }

        // Final UI Updates
        loadingProgressBar.style.width = '92%';
        loadingProgressText.innerText = '92%';
        loadingSubtext.innerText = "Refreshing preview and reports...";
        await new Promise(r => setTimeout(r, 10));

        previewFrame.srcdoc = getPreviewDocument(config);
        renderBuildReport();
        updateDownloadUI(config);
        loadingProgressBar.style.width = '100%';
        loadingProgressText.innerText = '100%';
        loadingSubtext.innerText = "Finalizing build...";
        await generateDiff();

        log("<span class='text-[#58CC02] font-bold'>Build Complete.</span>");
        showToast("Build Success!", "success");
        document.querySelector('[data-tab="output"]').click();

      } catch (err) {
        outputs = previousBuildState.outputs;
        originals = previousBuildState.originals;
        finals = previousBuildState.finals;
        batchFiles = previousBuildState.batchFiles;
        bundleHtmlOutputs = previousBuildState.bundleHtmlOutputs;
        previewHtml = previousBuildState.previewHtml;
        buildMeta = previousBuildState.buildMeta;
        precomputedDiffs = previousBuildState.precomputedDiffs;
        diffCacheState = previousBuildState.diffCacheState;
        previewFrame.srcdoc = getPreviewDocument();
        renderBuildReport();
        updateDownloadUI({ mode: buildMeta.mode || getBuildConfig().mode });
        void generateDiff();
        log(`<span class="text-[#FF3366]">Error:</span> ${err.message}`);
        console.error(err);
        showToast("Build Failed", "error");
      } finally {
        resetBuildUI();
      }
    };

    // Utils
    const getMimeType = (filename) => {
      if (/\.html?$/i.test(filename)) return 'text/html';
      if (/\.css$/i.test(filename)) return 'text/css';
      if (/\.js$/i.test(filename)) return 'application/javascript';
      if (/\.json$/i.test(filename)) return 'application/json';
      return 'text/plain';
    };

    const triggerDownload = (href, filename) => {
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    const dl = (n, c) => {
      if (!c) return;
      const url = URL.createObjectURL(new Blob([c], { type: getMimeType(n) }));
      triggerDownload(url, n);
      setTimeout(() => URL.revokeObjectURL(url), 250);
    };

    const downloadDataUrlAsset = (name, dataUrl) => {
      if (!dataUrl) return;
      triggerDownload(dataUrl, name);
    };

    const getBuiltConfig = () => buildMeta.configSnapshot || getBuildConfig();

    const getBuiltMode = () => buildMeta.mode || getBuiltConfig().mode;

    const getBuiltMediaAssets = () => buildMeta.includedMediaIds
      .map(id => assets.find(asset => asset.id === id))
      .filter(Boolean);

    const hasBuildArtifacts = () => {
      const mode = getBuiltMode();
      if (mode === 'batch') return batchFiles.length > 0;
      return Boolean(outputs.html || outputs.css || outputs.js || getBuiltMediaAssets().length || bundleHtmlOutputs.length);
    };

    document.getElementById("downH").onclick = () => dl(outNameH.value.trim() || 'index.min.html', outputs.html);
    document.getElementById("downC").onclick = () => dl(outNameC.value.trim() || 'styles.min.css', outputs.css);
    document.getElementById("downJ").onclick = () => dl(outNameJ.value.trim() || 'scripts.min.js', outputs.js);

    // ZIP Download Function
    const downloadAsZip = async () => {
      if (!hasBuildArtifacts()) {
        showToast("Build first to download artifacts.", "error");
        return;
      }

      if (typeof JSZip === 'undefined') {
        showToast("JSZip not loaded!", "error");
        return;
      }

        const zip = new JSZip();
        const mode = getBuiltMode();
        const htmlName = outNameH.value.trim() || 'index.min.html';
      const cssName = outNameC.value.trim() || 'styles.min.css';
      const jsName = outNameJ.value.trim() || 'scripts.min.js';

      if (outputs.html && mode !== 'batch') zip.file(htmlName, outputs.html);
      if (outputs.css && mode !== 'batch') zip.file(cssName, outputs.css);
      if (outputs.js && mode !== 'batch') zip.file(jsName, outputs.js);

        if (mode === 'bundle') {
          const mediaAssets = getBuiltMediaAssets();
          mediaAssets.forEach(media => {
            const base64Data = media.content.split(',')[1];
            const mediaName = getAssetPath(media) || media.name;
            zip.file(mediaName, base64Data, { base64: true });
          });

          bundleHtmlOutputs.forEach(file => zip.file(file.path || file.name, file.content));
        }

        if (mode === 'batch') {
          batchFiles.forEach(f => {
            const name = f.outputPath || f.path || f.name;
            if (f.type !== 'media') {
              zip.file(name, f.content);
              return;
            }
            const base64Data = f.content.split(',')[1];
            zip.file(name, base64Data, { base64: true });
          });
        }

      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      triggerDownload(url, 'bundle.zip');
      setTimeout(() => URL.revokeObjectURL(url), 250);

      showToast("ZIP Downloaded!", "success");
    };

    const downloadSequentialBundle = async () => {
      if (!hasBuildArtifacts()) {
        showToast("Build first to download artifacts.", "error");
        return;
      }

      const mode = getBuiltMode();
      const artifacts = [];
      if (outputs.html) artifacts.push({ kind: 'text', name: outNameH.value.trim() || 'index.min.html', content: outputs.html });
        if (outputs.css) artifacts.push({ kind: 'text', name: outNameC.value.trim() || 'styles.min.css', content: outputs.css });
        if (outputs.js) artifacts.push({ kind: 'text', name: outNameJ.value.trim() || 'scripts.min.js', content: outputs.js });
        if (mode === 'bundle') {
          bundleHtmlOutputs.forEach(file => artifacts.push({ kind: 'text', name: file.path || file.name, content: file.content }));
          getBuiltMediaAssets().forEach(media => artifacts.push({ kind: 'dataUrl', name: getAssetPath(media) || media.name, content: media.content }));
        }

      if (!artifacts.length) {
        showToast("No downloadable artifacts are available.", "error");
        return;
      }

      if (artifacts.length > 3) {
        showToast(`Starting ${artifacts.length} downloads. Your browser may ask for permission.`);
      }

      for (const artifact of artifacts) {
        if (artifact.kind === 'dataUrl') downloadDataUrlAsset(artifact.name, artifact.content);
        else dl(artifact.name, artifact.content);
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    };

    document.getElementById("downA").onclick = async () => {
      const mode = getBuiltMode();
      const useZip = document.getElementById("optZip").checked;

      if (mode === 'batch' || useZip) {
        await downloadAsZip();
      } else {
        await downloadSequentialBundle();
      }
    };

    // Mode change handler - disable ZIP toggle for inline mode
    const modeSelector = document.getElementById("mode");
    const zipCheckbox = document.getElementById("optZip");
    const zipLabel = document.getElementById("zipToggleLabel");

    const updateZipToggleState = () => {
      const mode = modeSelector.value;

      if (mode === 'inline') {
        // Inline: Single file, no Zip needed usually (but optional)
        zipCheckbox.disabled = true;
        zipCheckbox.checked = false;
        zipLabel.classList.add('opacity-50', 'cursor-not-allowed');
      } else if (mode === 'batch') {
        // Batch: MUST be Zip
        zipCheckbox.disabled = true;
        zipCheckbox.checked = true;
        zipLabel.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        // Bundle: Choice
        zipCheckbox.disabled = false;
        zipLabel.classList.remove('opacity-50', 'cursor-not-allowed');
      }

      const showLinkZip = mode === 'batch';
      if (linkZipLabel && linkZipHint) {
        linkZipLabel.classList.toggle('hidden', !showLinkZip);
        linkZipHint.classList.toggle('hidden', !showLinkZip);
        linkZipToggle.disabled = !showLinkZip;
      }
    };

    modeSelector.addEventListener('change', updateZipToggleState);
    // Initialize state on load
    updateZipToggleState();
    updateFilenameLabels();
    renderBuildReport();
    updateDownloadUI(getBuildConfig());

    [outNameH, outNameC, outNameJ].forEach(input => {
      input.addEventListener('input', updateFilenameLabels);
    });

    document.getElementById("togglePreview").onclick = () => {
      const box = document.getElementById("previewBox");
      box.classList.toggle('hidden');
    };

    // --- EXTRACTOR LOGIC ---
    const extractorInput = document.getElementById("extractorInput");
    const extractorUploadBtn = document.getElementById("extractorUploadBtn");
    const extractorList = document.getElementById("extractorList");
    const extractorDownloadAll = document.getElementById("extractorDownloadAll");
    const extractorEmptyState = document.getElementById("extractorEmptyState");
    const extBase64Dec = document.getElementById("extBase64Dec");

    let extractedAssets = [];

    extractorUploadBtn.onclick = () => extractorInput.click();

    extractorInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      log(`[EXTRACTOR] Processing file: <span class="text-[#FF3366]">${file.name}</span>...`);

      const htmlText = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');

      extractedAssets = [];
      let extractIdCount = 1;

      const addExAsset = (name, content, type) => {
        extractedAssets.push({ id: extractIdCount++, name, content, type });
      };

      // 1. Extract CSS
      const styles = doc.querySelectorAll('style');
      styles.forEach((styleTag, index) => {
        let content = styleTag.innerHTML;
        let name = styles.length === 1 ? 'extracted_style.css' : `extracted_style_${index + 1}.css`;
        addExAsset(name, content, 'css');

        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = name;
        styleTag.replaceWith(link);
      });

      // 2. Extract JS
      const scripts = doc.querySelectorAll('script');
      scripts.forEach((scriptTag, index) => {
        if (scriptTag.hasAttribute('src')) return;

        const typeAttr = scriptTag.getAttribute('type');
        if (typeAttr && typeAttr.includes('x-shader')) {
          let ext = typeAttr.includes('fragment') ? 'frag' : (typeAttr.includes('vertex') ? 'vert' : 'glsl');
          addExAsset(`shader_${index + 1}.${ext}`, scriptTag.innerHTML, 'glsl');
          return;
        }

        let name = scripts.length === 1 ? 'extracted_script.js' : `extracted_script_${index + 1}.js`;
        addExAsset(name, scriptTag.innerHTML, 'js');

        const newScript = doc.createElement('script');
        newScript.src = name;
        newScript.defer = true;
        scriptTag.replaceWith(newScript);
      });

      // 3. Extract Base64 Images
      if (extBase64Dec.checked) {
        const imgs = doc.querySelectorAll('img[src^="data:image"]');
        imgs.forEach((imgTag, index) => {
          const src = imgTag.getAttribute('src');
          const mimeMatch = src.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,/);
          if (mimeMatch) {
            const mimeType = mimeMatch[1];
            let ext = 'png';
            if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
            else if (mimeType.includes('gif')) ext = 'gif';
            else if (mimeType.includes('svg')) ext = 'svg';
            else if (mimeType.includes('webp')) ext = 'webp';

            const name = `extracted_image_${index + 1}.${ext}`;
            addExAsset(name, src, 'image');
            imgTag.setAttribute('src', name);
          }
        });
      }

      const finalHTML = `<!DOCTYPE html>\n${doc.documentElement.lang ? '<html lang="' + doc.documentElement.lang + '">' : '<html>'}\n${doc.documentElement.innerHTML}\n</html>`;
      addExAsset(`index_extracted.html`, finalHTML, 'html');

      log(`[EXTRACTOR] Extraction complete. Found ${extractedAssets.length} distinct assets.`);
      showToast("Extraction Complete", "success");
      renderExtractorList();
      extractorInput.value = '';
    };

    const renderExtractorList = () => {
      extractorList.innerHTML = '';
      if (extractedAssets.length === 0) {
        extractorList.appendChild(extractorEmptyState);
        extractorDownloadAll.disabled = true;
        extractorDownloadAll.classList.add('hidden');
        return;
      }
      extractorDownloadAll.disabled = false;
      extractorDownloadAll.classList.remove('hidden');

      const frag = document.createDocumentFragment();
      extractedAssets.forEach(asset => {
        let sizeBytes = asset.type === 'image'
          ? getDataUrlByteSize(asset.content)
          : new Blob([asset.content]).size;

        let visualColor = '#FF3366';
        if (asset.type === 'html') visualColor = '#121212';
        else if (asset.type === 'css') visualColor = '#0055ff';
        else if (asset.type === 'js') visualColor = '#eebb00';
        else if (asset.type === 'glsl') visualColor = '#9900ff';

        const row = document.createElement('div');
        row.className = "flex justify-between items-center p-3 bg-white border border-[#ccc] brutal-shadow mb-2 hover:border-[#121212] transition-colors";
        row.innerHTML = `
          <div class="flex items-center gap-3">
             <div class="w-3 h-3 rounded-full border border-black" style="background:${visualColor}"></div>
             <div>
                <div class="font-bold text-sm font-mono text-[#121212]">${asset.name}</div>
                <div class="text-[10px] text-[#888] font-mono">${formatBytes(sizeBytes)} • ${asset.type.toUpperCase()}</div>
             </div>
          </div>
          <button class="bg-[#121212] flex items-center gap-1 text-white hover:bg-[#FF3366] text-[10px] px-3 py-2 font-bold tracking-wider uppercase" onclick="downloadExtractedAsset(${asset.id})"><span>⬇</span> Save</button>
        `;
        frag.appendChild(row);
      });
      extractorList.appendChild(frag);
    };

    window.downloadExtractedAsset = (id) => {
      const asset = extractedAssets.find(a => a.id === id);
      if (!asset) return;

      if (asset.type === 'image') {
        downloadDataUrlAsset(asset.name, asset.content);
      } else {
        dl(asset.name, asset.content);
      }
    };

    extractorDownloadAll.onclick = async () => {
      if (extractedAssets.length === 0) return;

      if (typeof JSZip === 'undefined') {
        showToast("JSZip not loaded!", "error");
        return;
      }

      const zip = new JSZip();

      extractedAssets.forEach(asset => {
        if (asset.type === 'image') {
          const base64Data = asset.content.split(',')[1];
          zip.file(asset.name, base64Data, { base64: true });
        } else {
          zip.file(asset.name, asset.content);
        }
      });

      try {
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `extracted_project.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("Extraction ZIP Downloaded", "success");
      } catch (err) {
        console.error(err);
        showToast("ZIP Generation Failed", "error");
        log(`<span class="text-[#FF3366]">Extractor ZIP Error: ${err.message}</span>`);
      }
    };

    // Custom Cursor Logic - Throttled with RAF for performance
    const cursor = document.getElementById('cursor');

    if (cursor) {
      let cursorX = 0, cursorY = 0;
      let rafScheduled = false;

      document.addEventListener('mousemove', (e) => {
        cursorX = e.clientX;
        cursorY = e.clientY;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            cursor.style.transform = `translate3d(calc(${cursorX}px - 50%), calc(${cursorY}px - 50%), 0)`;
            rafScheduled = false;
          });
        }
      });

      const interactiveElements = 'a, button, .tab-btn, .asset-item';

      document.addEventListener('mouseover', (e) => {
        if (e.target.closest(interactiveElements)) {
          cursor.classList.add('hovered');
        }
      });

      document.addEventListener('mouseout', (e) => {
        if (e.target.closest(interactiveElements)) {
          cursor.classList.remove('hovered');
        }
      });
    }

    // --- SESSION MANAGEMENT ---
    const getProjectData = () => {
      syncActiveEditorToAsset();
      return {
        assets,
        activeAssetId,
        outputs,
        originals,
        finals,
        batchFiles,
        bundleHtmlOutputs,
        buildMeta,
        precomputedDiffs,
        config: getBuildConfig(),
        filenames: {
          h: outNameH.value,
          c: outNameC.value,
          j: outNameJ.value
        }
      };
    };

    const restoreUIState = (config) => {
      const mode = buildMeta.mode || config.mode || 'inline';
      if (mode === 'bundle' && outputs.html) {
        previewHtml = buildPreviewDocument({ mode }, outputs.html, outputs.css, outputs.js, getBuiltMediaAssets());
      } else if (mode === 'inline') {
        previewHtml = outputs.html || "";
      } else if (mode === 'batch') {
        previewHtml = createBatchPreviewMarkup();
      }

      previewFrame.srcdoc = getPreviewDocument({ mode });
      renderBuildReport();
      updateDownloadUI({ mode });
      void generateDiff();
    };

    const loadProjectData = (data) => {
      const isLegacyAssetList = Array.isArray(data);
      if (!isLegacyAssetList && (!data || !data.assets)) throw new Error("Invalid project data in session.");

      const session = isLegacyAssetList ? { assets: data } : data;

      assets = (session.assets || []).map(asset => ({
        ...asset,
        path: asset.path || asset.name
      }));
      activeAssetId = session.activeAssetId || (assets.length > 0 ? assets[0].id : null);

      outputs = session.outputs || { html: "", css: "", js: "" };
      originals = session.originals || { html: "", css: "", js: "", bundle: "" };
      finals = session.finals || { html: "", css: "", js: "", bundle: "" };
      batchFiles = (session.batchFiles || []).map(file => ({ ...file, path: file.path || file.name }));
      bundleHtmlOutputs = (session.bundleHtmlOutputs || []).map(file => ({ ...file, path: file.path || file.name }));
      buildMeta = session.buildMeta || createEmptyBuildMeta();
      precomputedDiffs = session.precomputedDiffs || { html: null, css: null, js: null, bundle: null };
      diffCacheState = {
        html: precomputedDiffs.html ? 'ready' : 'stale',
        css: precomputedDiffs.css ? 'ready' : 'stale',
        js: precomputedDiffs.js ? 'ready' : 'stale',
        bundle: precomputedDiffs.bundle ? 'ready' : 'stale'
      };

      if (session.filenames) {
        outNameH.value = session.filenames.h || 'index.min.html';
        outNameC.value = session.filenames.c || 'styles.min.css';
        outNameJ.value = session.filenames.j || 'scripts.min.js';
      }

      if (session.config) {
        document.getElementById("mode").value = session.config.mode || 'inline';
        if (session.config.minifyHTML !== undefined) document.getElementById("optMinifyHTML").checked = session.config.minifyHTML;
        if (session.config.minifyCSS !== undefined) document.getElementById("optMinifyCSS").checked = session.config.minifyCSS;
        if (session.config.minifyJS !== undefined) document.getElementById("optMinifyJS").checked = session.config.minifyJS;
        if (session.config.comments !== undefined) document.getElementById("optComments").checked = session.config.comments;
        if (session.config.console !== undefined) document.getElementById("optConsole").checked = session.config.console;
        if (session.config.useCDN !== undefined) document.getElementById("optCDN").checked = session.config.useCDN;
        if (session.config.linkZip !== undefined) document.getElementById("optLinkZip").checked = session.config.linkZip;
      }

      assetSizeCache.clear();
      updateFilenameLabels();
      updateZipToggleState();
      renderAssetList();
      if (activeAssetId) selectAsset(activeAssetId);

      restoreUIState(session.config || getBuildConfig());
    };

    // Manual Save/Load Files
    document.getElementById("exportProjectBtn").onclick = () => {
      if (assets.length === 0) {
        showToast("No assets to export!", "error");
        return;
      }
      log("Exporting session data...");
      const blob = new Blob([JSON.stringify(getProjectData())], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `bundler_session_${Date.now()}.json`);
      setTimeout(() => URL.revokeObjectURL(url), 250);
      showToast("Session Exported", "success");
    };

    const projectInput = document.getElementById("projectInput");
    document.getElementById("importProjectBtn").onclick = () => projectInput.click();

    projectInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      log(`Loading session from <span class="text-[#FF3366]">${file.name}</span>...`);
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const isLegacyAssetList = Array.isArray(data);
        loadProjectData(data);
        showToast("Session Loaded", "success");
        log(isLegacyAssetList
          ? `Restored legacy asset list with ${assets.length} assets.`
          : `Restored session with ${assets.length} assets and preserved computations.`);
      } catch (err) {
        showToast("Failed to load session", "error");
        log(`<span class="text-[#FF3366]">Session Load Error:</span> ${err.message}`);
      }
      projectInput.value = '';
    };

    // --- FOLDER CLEANER LOGIC ---
    const cleanerBtn = document.getElementById('cleanerBtn');
    const cleanerLog = document.getElementById('cleanerLog');
    const cleanerStats = document.getElementById('cleanerStats');

    const appendCleanerLog = (msg, isError = false) => {
      const div = document.createElement('div');
      div.className = `mb-1 ${isError ? 'text-[#FF3366]' : ''}`;
      div.innerHTML = msg;
      cleanerLog.appendChild(div);
      cleanerLog.scrollTop = cleanerLog.scrollHeight;
    };

    const processDirectory = async (sourceHandle, getDestHandleFn, path = "") => {
      let hasFiles = false;
      let filesCopied = 0;

      try {
        for await (const [name, handle] of sourceHandle.entries()) {
          if (handle.kind === 'directory') {
            let createdDirHandle = null;
            const getThisDestHandle = async () => {
              if (!createdDirHandle) {
                const parentDir = await getDestHandleFn();
                createdDirHandle = await parentDir.getDirectoryHandle(name, { create: true });
              }
              return createdDirHandle;
            };

            const result = await processDirectory(handle, getThisDestHandle, path + name + "/");
            filesCopied += result.filesCopied;

            if (result.hasFiles) {
              hasFiles = true;
            } else {
              appendCleanerLog(`> <span class="text-[#888] font-bold">SKIPPED EMPTY:</span> ${path}${name}/`);
            }
          } else {
            hasFiles = true;
            try {
              const destDir = await getDestHandleFn();
              const destFile = await destDir.getFileHandle(name, { create: true });
              const sourceFile = await handle.getFile();
              const writable = await destFile.createWritable();
              await writable.write(sourceFile);
              await writable.close();
              filesCopied++;
              appendCleanerLog(`> <span class="text-[#121212] font-bold">COPIED:</span> ${path}${name}`);
            } catch (fileErr) {
              appendCleanerLog(`> <span class="bg-[#FF3366] text-white px-1">FAILED</span> to copy: ${path}${name} (${fileErr.message})`, true);
            }
          }
        }
      } catch (err) {
        appendCleanerLog(`> <span class="bg-[#FF3366] text-white px-1">ERROR</span> reading directory: ${path} (${err.message})`, true);
      }

      return { hasFiles, filesCopied };
    };

    cleanerBtn.onclick = async () => {
      if (!window.showDirectoryPicker) {
        alert("Your browser does not support the File System Access API. Please use a modern browser like Chrome or Edge.");
        return;
      }

      try {
        cleanerLog.innerHTML = '';
        cleanerStats.innerText = 'WAITING...';

        appendCleanerLog(`> Please select the <span class="text-[#121212] font-bold">SOURCE</span> folder...`);
        const sourceHandle = await window.showDirectoryPicker({ id: 'cleaner-source', mode: 'read' });
        appendCleanerLog(`> Source selected: <span class="text-[#121212] font-bold">${sourceHandle.name}</span>`);

        appendCleanerLog(`> Please select the <span class="text-[#58CC02] font-bold">DESTINATION</span> folder (where the cleaned copy will be saved)...`);

        // Wait a tiny bit for UI update before next prompt
        await new Promise(r => setTimeout(r, 50));

        const destParentHandle = await window.showDirectoryPicker({ id: 'cleaner-dest', mode: 'readwrite' });

        document.body.classList.add('is-processing');
        cleanerStats.innerText = 'COPYING...';

        const newFolderName = sourceHandle.name + "_cleaned";
        appendCleanerLog(`> Creating new folder: <span class="text-[#121212] font-bold">${newFolderName}</span> in destination...`);

        const destHandle = await destParentHandle.getDirectoryHandle(newFolderName, { create: true });
        const getDestHandle = async () => destHandle;

        // Ensure UI updates before heavy processing
        await new Promise(r => setTimeout(r, 50));

        const result = await processDirectory(sourceHandle, getDestHandle, "");
        const totalCopied = result.filesCopied;

        appendCleanerLog(`> <span class="text-[#58CC02] font-bold">COPY COMPLETE.</span>`);
        cleanerStats.innerText = `${totalCopied} FILES COPIED`;

        if (totalCopied === 0) {
          appendCleanerLog(`> No files found to copy.`);
        } else {
          showToast(`Copied ${totalCopied} files safely`, "success");
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err);
          appendCleanerLog(`> <span class="bg-[#FF3366] text-white px-1">FATAL ERROR</span> ${err.message}`, true);
          cleanerStats.innerText = 'ERROR';
          showToast("Cleanup failed", "error");
        } else {
          appendCleanerLog(`> <span class="text-[#888]">Operation cancelled by user.</span>`);
          cleanerStats.innerText = 'CANCELLED';
        }
      } finally {
        document.body.classList.remove('is-processing');
      }
    };

    const cores = navigator.hardwareConcurrency || 4;
    log(`System initialized. Detected <span class="text-[#58CC02] font-bold">${cores}</span> logical CPU cores available for parallel processing.`);
    renderAssetList();
  
