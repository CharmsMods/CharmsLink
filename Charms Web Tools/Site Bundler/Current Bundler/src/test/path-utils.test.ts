import { describe, expect, it } from "vitest";

import { getRelativePath, normalizePath, resolveRelativePath } from "../utils/path-utils";

describe("path utils", () => {
  it("normalizes slashes and leading dots", () => {
    expect(normalizePath(".\\assets\\\\img\\logo.png")).toBe("assets/img/logo.png");
  });

  it("resolves relative references from the source asset directory", () => {
    expect(resolveRelativePath("pages/home/index.html", "../shared/app.js")).toBe("pages/shared/app.js");
  });

  it("computes relative output paths from emitted artifacts", () => {
    expect(getRelativePath("pages/home", "assets/logo.png")).toBe("../../assets/logo.png");
  });
});
