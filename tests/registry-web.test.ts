import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRegistryWeb } from "../src/registry-web.js";

describe("Registry Web assets", () => {
  it("serves a CSP-protected functional shell without inline code", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.body).toContain("PitLore Registry");
    expect(response.body).toContain('src="/app.js"');
    expect(response.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
    await app.close();
  });

  it("serves JavaScript, CSS, and the local mark with nosniff", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    for (const [url, type, content] of [
      ["/app.js", "text/javascript", "loadPublicPackages"],
      ["/app.css", "text/css", "--signal-700"],
      ["/pitlore-mark.svg", "image/svg+xml", "PitLore mark"],
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(type);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.body).toContain(content);
    }
    await app.close();
  });

  it("keeps the collapsed rejection form out of keyboard focus and exposes its state", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const response = await app.inject({ method: "GET", url: "/app.js" });
    expect(response.body).toContain('rejectPanel.hidden = true');
    expect(response.body).toContain('reject.setAttribute("aria-expanded", "false")');
    expect(response.body).toContain('reject.setAttribute("aria-controls"');
    expect(response.body).toContain("input.focus()");
    await app.close();
  });

  it("prefers the browser session without emitting an empty bearer and binds cookie mutations to CSRF", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const script = await app.inject({ method: "GET", url: "/app.js" });
    expect(script.body).toContain(
      'api("/auth/session", { includeSession: true })',
    );
    expect(script.body).toContain('state.authMode === "bearer"');
    expect(script.body).toContain('state.authMode === "session"');
    expect(script.body).toContain('headers["x-pitlore-csrf"]');
    expect(script.body).toContain('cookieValue("__Host-pitlore_csrf")');
    expect(script.body).toContain(
      'options.includeSession || (options.auth && state.authMode === "session")',
    );
    expect(script.body).not.toContain("if (options.auth) headers.authorization");

    const html = await app.inject({ method: "GET", url: "/" });
    expect(html.body).toContain('id="sso-login"');
    expect(html.body).toContain('id="session-sign-out"');
    expect(html.body).not.toMatch(/id="bearer-token"[^>]*\srequired(?:\s|>)/);
    await app.close();
  });

  it("consumes public and protected cursors through bounded explicit pagination", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const script = await app.inject({ method: "GET", url: "/app.js" });
    expect(script.body).toContain("const MAX_PUBLIC_PAGES = 20");
    expect(script.body).toContain("result?.next_cursor");
    expect(script.body).toContain("checkedNextCursor(");
    expect(script.body).toContain("seenCursors.has(value)");
    expect(script.body).toContain("state.catalogPageCount >= MAX_PUBLIC_PAGES");
    expect(script.body).toContain("state.releasePageCount >= MAX_PUBLIC_PAGES");
    expect(script.body).toContain("loadPublicPackages(state.catalogQuery, true)");
    expect(script.body).toContain("loadPublicReleases(state.releasePackage, true)");
    expect(script.body).toContain("const MAX_AUTH_PAGES = 20");
    expect(script.body).toContain("state.pendingPageCount >= MAX_AUTH_PAGES");
    expect(script.body).toContain("state.auditPageCount >= MAX_AUTH_PAGES");
    expect(script.body).toContain("loadId !== state.pendingRequestId");
    expect(script.body).toContain("loadId !== state.auditRequestId");
    expect(script.body).toContain("loadPendingReleases(state.workspaceRequestId, true)");
    expect(script.body).toContain("loadAudit(state.workspaceRequestId, true)");
    expect(script.body).not.toContain("[...result.events].reverse()");

    const html = await app.inject({ method: "GET", url: "/" });
    expect(html.body).toContain('id="catalog-load-more"');
    expect(html.body).toContain('id="release-load-more"');
    expect(html.body).toContain('id="pending-load-more"');
    expect(html.body).toContain('id="audit-load-more"');
    await app.close();
  });

  it("filters public discovery with a strict bounded facets contract", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const [html, script, css] = await Promise.all([
      app.inject({ method: "GET", url: "/" }),
      app.inject({ method: "GET", url: "/app.js" }),
      app.inject({ method: "GET", url: "/app.css" }),
    ]);

    expect(html.body).toContain('id="discovery-language"');
    expect(html.body).toContain('id="discovery-ecosystem"');
    expect(html.body).toContain('id="discovery-tag"');
    expect(html.body).toContain('id="discovery-filter-clear"');
    expect(html.body).toContain("up to four values per field");
    expect(html.body).toContain("only match indexed, published release metadata");

    expect(script.body).toContain("const MAX_PUBLIC_CURSOR_LENGTH = 1_024");
    expect(script.body).toContain("const MAX_DISCOVERY_FILTER_VALUES = 4");
    expect(script.body).toContain('include: "facets"');
    expect(script.body).toContain('parameters.append(name, value)');
    expect(script.body).toContain("state.catalogFilters.languages");
    expect(script.body).toContain("loadPublicPackages(state.catalogQuery, true)");
    expect(script.body).toContain('.normalize("NFKC").toLocaleLowerCase("en-US")');
    expect(script.body).toContain("validatePublicPackagePage(");
    expect(script.body).toContain("value.packages.length > PUBLIC_PAGE_SIZE");
    expect(script.body).toContain('hasExactKeys(value, ["packages", "next_cursor"])');
    for (const field of [
      '"latest_version"',
      '"discovery_available"',
      '"description"',
      '"lesson_count"',
      '"facets"',
    ]) {
      expect(script.body).toContain(field);
    }
    expect(script.body).toContain("validCanonicalFacetArray(value.languages)");
    expect(script.body).toContain("unicodeLength(value) <= MAX_DISCOVERY_DESCRIPTION_LENGTH");
    expect(script.body).toContain('value.description === ""');
    expect(script.body).toContain("Discovery metadata is not indexed for this Pack.");
    expect(script.body).toContain("renderPackageEvidence(");
    expect(script.body).not.toContain(".innerHTML");

    expect(css.body).toContain(".discovery-filters");
    expect(css.body).toContain(".facet-chip");
    expect(css.body).toContain(".catalog-description.is-unavailable");
    await app.close();
  });

  it("renders bounded semantic release comparisons with honest async and no-script states", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const [html, script, css] = await Promise.all([
      app.inject({ method: "GET", url: "/" }),
      app.inject({ method: "GET", url: "/app.js" }),
      app.inject({ method: "GET", url: "/app.css" }),
    ]);

    expect(html.body).toContain('id="version-compare-submit"');
    expect(html.body).toContain('aria-controls="version-comparison"');
    expect(html.body).toContain(
      'id="version-comparison-status" class="comparison-status" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(html.body).toContain(
      'id="version-comparison" class="version-comparison" aria-labelledby="version-comparison-title" aria-busy="false" tabindex="-1" hidden',
    );
    expect(html.body).toContain("Interactive version comparison requires JavaScript.");
    expect(html.body.indexOf("<noscript>")).toBeLessThan(
      html.body.indexOf('id="pack-detail-content" hidden'),
    );

    const compareStart = script.body.indexOf(
      "async function loadVersionComparison",
    );
    const compareEnd = script.body.indexOf(
      "function renderVersionComparison",
      compareStart,
    );
    const compareSource = script.body.slice(compareStart, compareEnd);
    expect(compareStart).toBeGreaterThan(-1);
    expect(compareEnd).toBeGreaterThan(compareStart);
    expect(compareSource).toContain("baseline.version === candidate.version");
    expect(compareSource.indexOf("baseline.version === candidate.version")).toBeLessThan(
      compareSource.indexOf("await api("),
    );
    expect(compareSource).toContain("/v1/public/diff?${parameters}");
    expect(compareSource).toContain("from_version: baseline.version");
    expect(compareSource).toContain("to_version: candidate.version");
    expect(compareSource).toContain("requestId !== state.comparisonRequestId");
    expect(compareSource).toContain("state.selectedPackage?.name !== packageName");
    expect(script.body).toContain('setAttribute("aria-busy", String(loading))');
    expect(script.body).toContain("elements.compareSubmit.disabled = loading");
    expect(script.body).toContain('alert.setAttribute("role", "alert")');
    expect(script.body).toContain("Output limited. ");
    expect(script.body).toContain("canonical_payload_changed");
    expect(script.body).toContain("artifact_digest_changed");
    expect(script.body).toContain("change.semantic_fields");
    expect(script.body).toContain("change.metadata_fields");
    expect(script.body).toContain("MAX_DIFF_DETAILS = 100");
    expect(script.body).toContain("MAX_DIFF_LESSONS = 1_000");
    expect(script.body).toContain("DIFF_MANIFEST_FIELDS");
    expect(script.body).toContain("DIFF_SEMANTIC_FIELDS");
    expect(script.body).toContain("hasExactKeys");
    expect(script.body).toContain("isAllowedUniqueStringArray");
    expect(script.body).toContain(
      'options.includeSession || (options.auth && state.authMode === "session")',
    );
    expect(script.body).not.toContain(".innerHTML");

    expect(css.body).toContain(".diff-summary");
    expect(css.body).toContain(".diff-kind.is-added");
    expect(css.body).toContain(".diff-kind.is-removed");
    expect(css.body).toContain(".diff-kind.is-changed");
    expect(css.body).toContain(".diff-omitted");
    await app.close();
  });

  it("offers sign-out only for restored SSO sessions and clears protected UI after CSRF logout", async () => {
    const app = fastify();
    registerRegistryWeb(app);
    const script = await app.inject({ method: "GET", url: "/app.js" });
    expect(script.body).toContain('if (state.authMode !== "session") return');
    expect(script.body).toContain('api("/auth/logout", { auth: true, method: "POST" })');
    expect(script.body).toContain("clearProtectedWorkspace()");
    expect(script.body).toContain("elements.actorEvidence.replaceChildren()");
    expect(script.body).toContain("elements.auditTimeline.replaceChildren()");
    expect(script.body).toContain("elements.sessionSignOut.hidden = !sessionConnected");
    await app.close();
  });
});
