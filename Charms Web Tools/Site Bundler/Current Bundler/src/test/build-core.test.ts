import { describe, expect, it } from "vitest";

import { assembleBuildResult } from "../services/build/core";
import { createTextAsset } from "../utils/asset-utils";

describe("build core", () => {
  it("keeps secondary html pages in bundle mode", () => {
    const entry = createTextAsset("index.html", "index.html", "<html><body>Entry</body></html>", "manual");
    const about = createTextAsset("about.html", "about.html", "<html><body>About</body></html>", "manual");

    const result = assembleBuildResult({
      assets: [entry, about],
      processedText: new Map(),
      config: {
        mode: "bundle",
        minifyHTML: false,
        minifyCSS: false,
        minifyJS: false,
        removeComments: false,
        dropConsole: false,
        zipDownloads: true,
        linkZipReferences: true,
        outputNames: {
          html: "index.bundle.html",
          css: "styles.bundle.css",
          js: "scripts.bundle.js"
        }
      },
      entryHtmlId: entry.id,
      warnings: [],
      durationMs: 10,
      workerCount: 1
    });

    expect(result.secondaryHtmlIds).toContain(about.id);
    expect(result.artifacts.some((artifact) => artifact.path === "about.html")).toBe(true);
  });

  it("uses build-time filename snapshots for emitted artifact paths", () => {
    const entry = createTextAsset("index.html", "index.html", "<html><body>Entry</body></html>", "manual");

    const result = assembleBuildResult({
      assets: [entry],
      processedText: new Map(),
      config: {
        mode: "inline",
        minifyHTML: false,
        minifyCSS: false,
        minifyJS: false,
        removeComments: false,
        dropConsole: false,
        zipDownloads: false,
        linkZipReferences: false,
        outputNames: {
          html: "frozen-name.html",
          css: "styles.min.css",
          js: "scripts.min.js"
        }
      },
      entryHtmlId: entry.id,
      warnings: [],
      durationMs: 10,
      workerCount: 1
    });

    expect(result.filenameSnapshot.html).toBe("frozen-name.html");
    expect(result.artifacts[0]?.path).toBe("frozen-name.html");
  });
});
