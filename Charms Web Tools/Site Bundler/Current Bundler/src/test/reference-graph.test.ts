import { describe, expect, it } from "vitest";

import { collectReferenceGraph } from "../services/reference-graph";
import { createTextAsset } from "../utils/asset-utils";

describe("reference graph", () => {
  it("prefers relative path resolution over basename fallback", () => {
    const html = createTextAsset("index.html", "pages/home/index.html", '<script src="../shared/app.js"></script>', "manual");
    const shared = createTextAsset("app.js", "pages/shared/app.js", "console.log('shared');", "manual");
    const duplicate = createTextAsset("app.js", "other/app.js", "console.log('other');", "manual");

    const scan = collectReferenceGraph([html, shared, duplicate]);

    expect(scan.references[0]?.resolvedAssetId).toBe(shared.id);
    expect(scan.references[0]?.resolutionType).toBe("relative");
  });

  it("reports ambiguous basename-only matches", () => {
    const html = createTextAsset("index.html", "index.html", '<img src="logo.png">', "manual");
    const logoA = createTextAsset("logo.png", "assets/logo.png", "binary-as-text", "manual");
    const logoB = createTextAsset("logo.png", "img/logo.png", "binary-as-text", "manual");

    const scan = collectReferenceGraph([html, logoA, logoB]);

    expect(scan.ambiguousReferences).toHaveLength(1);
    expect(scan.references[0]?.resolutionType).toBe("ambiguous");
  });
});
