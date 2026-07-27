const PUBLIC_PAGE_SIZE = 50;
const MAX_PUBLIC_PAGES = 20;
const MAX_PUBLIC_CURSOR_LENGTH = 1_024;
const MAX_DISCOVERY_FILTER_VALUES = 4;
const MAX_DISCOVERY_FACET_VALUES = 64;
const MAX_DISCOVERY_FACET_LENGTH = 64;
const MAX_DISCOVERY_DESCRIPTION_LENGTH = 512;
const MAX_DISCOVERY_LESSONS = 1_000;
const AUTH_PAGE_SIZE = 50;
const MAX_AUTH_PAGES = 20;
const MAX_DIFF_DETAILS = 100;
const MAX_DIFF_LESSONS = 1_000;
const DIFF_INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
const DIFF_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DIFF_LESSON_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,127}$/;
const DIFF_MANIFEST_FIELDS = new Set([
  "description",
  "visibility",
  "dependencies",
  "default_status_for_new",
]);
const DIFF_SEMANTIC_FIELDS = new Set([
  "version",
  "title",
  "languages",
  "ecosystems",
  "category",
  "symptom",
  "root_cause",
  "forbid_pattern_abstract",
  "safe_pattern_abstract",
  "scope.paths",
  "scope.confidence_min",
  "severity",
  "confidence",
  "sources.count",
  "sources.references",
  "enforcement.test_idea",
  "enforcement.detector_ref",
  "enforcement.patterns",
  "enforcement.fixtures.bad",
  "enforcement.fixtures.good",
  "enforcement.fixtures.bad_content",
  "enforcement.fixtures.good_content",
  "tags",
  "status",
  "visibility",
]);
const DIFF_METADATA_FIELDS = new Set(["created_at", "updated_at"]);
const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

class PaginationSafetyError extends Error {
  constructor() {
    super("Registry pagination stopped because the continuation cursor was invalid or repeated.");
    this.name = "PaginationSafetyError";
  }
}

class DiscoveryFilterError extends Error {
  constructor(message, input) {
    super(message);
    this.name = "DiscoveryFilterError";
    this.input = input;
  }
}

const state = {
  selectedPackage: null,
  catalogPackages: [],
  catalogQuery: "",
  catalogFilters: emptyDiscoveryFilters(),
  catalogCursor: null,
  catalogSeenCursors: new Set(),
  catalogPageCount: 0,
  catalogLoading: false,
  catalogRequestId: 0,
  publicReleases: [],
  releasePackage: null,
  releaseCursor: null,
  releaseSeenCursors: new Set(),
  releasePageCount: 0,
  releaseLoading: false,
  releaseRequestId: 0,
  comparisonRequestId: 0,
  comparisonLoading: false,
  orgId: "",
  bearer: "",
  authMode: "none",
  actor: null,
  workspaceRequestId: 0,
  pendingItems: [],
  pendingCursor: null,
  pendingSeenCursors: new Set(),
  pendingPageCount: 0,
  pendingLoading: false,
  pendingRequestId: 0,
  auditItems: [],
  auditCursor: null,
  auditSeenCursors: new Set(),
  auditPageCount: 0,
  auditLoading: false,
  auditRequestId: 0,
};

const elements = {
  serviceState: document.querySelector(".service-state"),
  serviceStateLabel: document.querySelector("#service-state-label"),
  searchForm: document.querySelector("#public-search-form"),
  searchInput: document.querySelector("#public-search"),
  discoveryLanguage: document.querySelector("#discovery-language"),
  discoveryEcosystem: document.querySelector("#discovery-ecosystem"),
  discoveryTag: document.querySelector("#discovery-tag"),
  discoveryFilterClear: document.querySelector("#discovery-filter-clear"),
  catalogList: document.querySelector("#catalog-list"),
  catalogCount: document.querySelector("#catalog-count"),
  catalogEmpty: document.querySelector("#catalog-empty"),
  catalogLoadMore: document.querySelector("#catalog-load-more"),
  packDetailTitle: document.querySelector("#pack-detail-title"),
  packDetailSummary: document.querySelector("#pack-detail-summary"),
  packDetailContent: document.querySelector("#pack-detail-content"),
  packEvidence: document.querySelector("#pack-evidence"),
  publicReleaseCount: document.querySelector("#public-release-count"),
  publicReleaseList: document.querySelector("#public-release-list"),
  releaseLoadMore: document.querySelector("#release-load-more"),
  compareForm: document.querySelector("#version-compare-form"),
  compareFrom: document.querySelector("#compare-from"),
  compareTo: document.querySelector("#compare-to"),
  compareSubmit: document.querySelector("#version-compare-submit"),
  comparisonStatus: document.querySelector("#version-comparison-status"),
  versionComparison: document.querySelector("#version-comparison"),
  versionForm: document.querySelector("#version-lookup-form"),
  releaseVersion: document.querySelector("#release-version"),
  releaseRecord: document.querySelector("#release-record"),
  connectionForm: document.querySelector("#connection-form"),
  orgId: document.querySelector("#org-id"),
  bearer: document.querySelector("#bearer-token"),
  ssoLogin: document.querySelector("#sso-login"),
  sessionSignOut: document.querySelector("#session-sign-out"),
  connectionNote: document.querySelector("#connection-note"),
  workspaceContent: document.querySelector("#workspace-content"),
  actorEvidence: document.querySelector("#actor-evidence"),
  usageEvidence: document.querySelector("#usage-evidence"),
  pendingReleases: document.querySelector("#pending-releases"),
  pendingCount: document.querySelector("#pending-count"),
  pendingEmpty: document.querySelector("#pending-empty"),
  pendingLoadMore: document.querySelector("#pending-load-more"),
  auditLocked: document.querySelector("#audit-locked"),
  auditTimeline: document.querySelector("#audit-timeline"),
  refreshAudit: document.querySelector("#refresh-audit"),
  auditLoadMore: document.querySelector("#audit-load-more"),
  toast: document.querySelector("#toast"),
};

document.querySelectorAll("[data-view-target]").forEach((control) => {
  control.addEventListener("click", () => switchView(control.dataset.viewTarget));
});

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const filters = readDiscoveryFilters();
    syncDiscoveryFilterInputs(filters);
    loadPublicPackages(elements.searchInput.value.trim(), false, filters);
  } catch (error) {
    if (error instanceof DiscoveryFilterError) error.input.focus();
    showToast(error.message, true);
  }
});

elements.discoveryFilterClear.addEventListener("click", () => {
  const filters = emptyDiscoveryFilters();
  syncDiscoveryFilterInputs(filters);
  loadPublicPackages(elements.searchInput.value.trim(), false, filters);
});

elements.catalogLoadMore.addEventListener("click", () => {
  loadPublicPackages(state.catalogQuery, true);
});

elements.releaseLoadMore.addEventListener("click", () => {
  if (state.releasePackage) loadPublicReleases(state.releasePackage, true);
});

elements.versionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedPackage) return;
  const form = new FormData(elements.versionForm);
  const version = String(form.get("version") ?? "").trim();
  await inspectRelease(state.selectedPackage.name, version);
});

elements.compareForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadVersionComparison(elements.compareFrom.value, elements.compareTo.value);
});

elements.connectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.connectionForm);
  const bearer = String(form.get("bearer") ?? "");
  elements.bearer.value = "";
  if (!bearer) {
    elements.connectionNote.textContent = "Enter a deployment-issued bearer or choose SSO.";
    return;
  }
  state.orgId = String(form.get("org_id") ?? "").trim();
  state.bearer = bearer;
  state.authMode = "bearer";
  syncAuthControls();
  await connectWorkspace();
});

elements.ssoLogin.addEventListener("click", () => {
  if (!elements.connectionForm.reportValidity()) return;
  const orgId = elements.orgId.value.trim();
  window.location.assign(`/auth/login?org_id=${encodeURIComponent(orgId)}`);
});

elements.sessionSignOut.addEventListener("click", () => signOutSession());

elements.refreshAudit.addEventListener("click", () => loadAudit());
elements.pendingLoadMore.addEventListener("click", () => {
  loadPendingReleases(state.workspaceRequestId, true);
});
elements.auditLoadMore.addEventListener("click", () => {
  loadAudit(state.workspaceRequestId, true);
});

window.addEventListener("pagehide", () => {
  state.bearer = "";
  state.authMode = "none";
  state.actor = null;
});

checkHealth();
restoreBrowserSession();
loadPublicPackages("");

async function restoreBrowserSession() {
  try {
    const session = await api("/auth/session", { includeSession: true });
    if (!session?.authenticated) return;
    state.authMode = "session";
    state.orgId = session.org_id;
    state.bearer = "";
    elements.orgId.value = session.org_id;
    elements.bearer.value = "";
    syncAuthControls();
    await connectWorkspace();
  } catch {
    // Browser login is optional; the deployment-issued bearer remains usable.
  }
}

async function checkHealth() {
  try {
    await api("/healthz");
    elements.serviceState.classList.add("is-ready");
    elements.serviceStateLabel.textContent = "Registry ready";
  } catch {
    elements.serviceState.classList.add("is-error");
    elements.serviceStateLabel.textContent = "Registry unavailable";
  }
}

function emptyDiscoveryFilters() {
  return { languages: [], ecosystems: [], tags: [] };
}

function copyDiscoveryFilters(filters) {
  return {
    languages: [...filters.languages],
    ecosystems: [...filters.ecosystems],
    tags: [...filters.tags],
  };
}

function readDiscoveryFilters() {
  return {
    languages: readDiscoveryFilterValues(elements.discoveryLanguage, "Languages"),
    ecosystems: readDiscoveryFilterValues(elements.discoveryEcosystem, "Frameworks / ecosystems"),
    tags: readDiscoveryFilterValues(elements.discoveryTag, "Tags"),
  };
}

function readDiscoveryFilterValues(input, label) {
  const values = input.value
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length > MAX_DISCOVERY_FILTER_VALUES) {
    throw new DiscoveryFilterError(
      `${label} accepts at most ${MAX_DISCOVERY_FILTER_VALUES} comma-separated values.`,
      input,
    );
  }
  try {
    return [...new Set(values.map(canonicalDiscoveryFacet))].sort(compareText);
  } catch (error) {
    throw new DiscoveryFilterError(`${label}: ${error.message}`, input);
  }
}

function syncDiscoveryFilterInputs(filters) {
  elements.discoveryLanguage.value = filters.languages.join(", ");
  elements.discoveryEcosystem.value = filters.ecosystems.join(", ");
  elements.discoveryTag.value = filters.tags.join(", ");
}

function appendDiscoveryFilter(parameters, name, values) {
  values.forEach((value) => parameters.append(name, value));
}

function canonicalDiscoveryFacet(value) {
  const canonical = value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  if (canonical.length === 0) {
    throw new Error("values cannot be empty.");
  }
  if (CONTROL_CHARACTERS.test(canonical)) {
    throw new Error("values cannot contain control characters.");
  }
  if (unicodeLength(canonical) > MAX_DISCOVERY_FACET_LENGTH) {
    throw new Error(`each value must be at most ${MAX_DISCOVERY_FACET_LENGTH} characters.`);
  }
  return canonical;
}

function validatePublicPackagePage(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["packages", "next_cursor"]) ||
    !Array.isArray(value.packages) ||
    value.packages.length > PUBLIC_PAGE_SIZE ||
    !value.packages.every(validPublicPackage) ||
    new Set(value.packages.map((item) => item.name)).size !== value.packages.length ||
    !validPublicCursor(value.next_cursor)
  ) {
    throw new Error("The Registry returned an invalid public discovery response.");
  }
  return value;
}

function validPublicPackage(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "name",
      "visibility",
      "created_at",
      "latest_version",
      "discovery_available",
      "description",
      "lesson_count",
      "facets",
    ]) &&
    typeof value.name === "string" &&
    value.name.length <= 128 &&
    PACK_NAME_PATTERN.test(value.name) &&
    value.visibility === "public" &&
    validRegistryTimestamp(value.created_at) &&
    (value.latest_version === null || validSemanticVersion(value.latest_version)) &&
    typeof value.discovery_available === "boolean" &&
    validDiscoveryDescription(value.description) &&
    Number.isSafeInteger(value.lesson_count) &&
    value.lesson_count >= 0 &&
    value.lesson_count <= MAX_DISCOVERY_LESSONS &&
    validDiscoveryFacets(value.facets) &&
    (value.discovery_available
      ? value.latest_version !== null
      : value.description === "" &&
        value.lesson_count === 0 &&
        value.facets.languages.length === 0 &&
        value.facets.ecosystems.length === 0 &&
        value.facets.tags.length === 0)
  );
}

function validDiscoveryFacets(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["languages", "ecosystems", "tags"]) &&
    validCanonicalFacetArray(value.languages) &&
    validCanonicalFacetArray(value.ecosystems) &&
    validCanonicalFacetArray(value.tags)
  );
}

function validCanonicalFacetArray(value) {
  if (!Array.isArray(value) || value.length > MAX_DISCOVERY_FACET_VALUES) return false;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") return false;
    try {
      if (canonicalDiscoveryFacet(item) !== item) return false;
    } catch {
      return false;
    }
    if (index > 0 && compareText(value[index - 1], item) >= 0) return false;
  }
  return true;
}

function validDiscoveryDescription(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value) &&
    unicodeLength(value) <= MAX_DISCOVERY_DESCRIPTION_LENGTH
  );
}

function validRegistryTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validSemanticVersion(value) {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    STRICT_SEMVER_PATTERN.test(value)
  );
}

function validPublicCursor(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_PUBLIC_CURSOR_LENGTH)
  );
}

function unicodeLength(value) {
  return Array.from(value).length;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function loadPublicPackages(
  query,
  append = false,
  filters = state.catalogFilters,
) {
  if (append && state.catalogLoading) return;
  if (!append) {
    state.catalogRequestId += 1;
    state.catalogPackages = [];
    state.catalogQuery = query;
    state.catalogFilters = copyDiscoveryFilters(filters);
    state.catalogCursor = null;
    state.catalogSeenCursors = new Set();
    state.catalogPageCount = 0;
    elements.catalogLoadMore.hidden = true;
    elements.catalogEmpty.hidden = true;
    setListLoading(elements.catalogList, "Reading the public catalog…");
    clearPackageDetail();
  }
  const cursor = append ? state.catalogCursor : null;
  if (append && !cursor) return;
  if (
    state.catalogPageCount >= MAX_PUBLIC_PAGES ||
    (cursor && state.catalogSeenCursors.has(cursor))
  ) {
    stopCatalogPagination();
    return;
  }
  const requestId = state.catalogRequestId;
  state.catalogLoading = true;
  elements.catalogLoadMore.disabled = true;
  elements.catalogLoadMore.textContent = "Reading more…";
  try {
    const parameters = new URLSearchParams({
      query,
      limit: String(PUBLIC_PAGE_SIZE),
      include: "facets",
    });
    appendDiscoveryFilter(parameters, "language", state.catalogFilters.languages);
    appendDiscoveryFilter(parameters, "ecosystem", state.catalogFilters.ecosystems);
    appendDiscoveryFilter(parameters, "tag", state.catalogFilters.tags);
    if (cursor) parameters.set("cursor", cursor);
    const result = validatePublicPackagePage(
      await api(`/v1/public/packages?${parameters}`),
    );
    if (requestId !== state.catalogRequestId) return;
    const nextCursor = checkedNextCursor(
      result?.next_cursor,
      cursor,
      state.catalogSeenCursors,
    );
    if (cursor) state.catalogSeenCursors.add(cursor);
    const page = result.packages;
    const knownNames = new Set(state.catalogPackages.map((item) => item.name));
    const additions = page.filter((item) => {
      if (knownNames.has(item.name)) return false;
      knownNames.add(item.name);
      return true;
    });
    state.catalogPackages.push(...additions);
    state.catalogCursor = nextCursor;
    state.catalogPageCount += 1;
    if (!append) elements.catalogList.replaceChildren();
    if (state.catalogPackages.length === 0 && nextCursor) {
      throw new PaginationSafetyError();
    }
    const startIndex = state.catalogPackages.length - additions.length;
    additions.forEach((registryPackage, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "catalog-item";
      button.append(
        textNode("span", String(startIndex + index + 1).padStart(2, "0"), "catalog-number"),
        packageLabel(registryPackage),
        textNode("span", "→", "catalog-arrow"),
      );
      button.addEventListener("click", () => selectPackage(registryPackage, button));
      item.append(button);
      elements.catalogList.append(item);
    });
    const capped = Boolean(nextCursor) && state.catalogPageCount >= MAX_PUBLIC_PAGES;
    elements.catalogCount.value = `${state.catalogPackages.length}${capped ? "+" : ""} record${state.catalogPackages.length === 1 ? "" : "s"}`;
    elements.catalogEmpty.hidden = state.catalogPackages.length !== 0;
    elements.catalogLoadMore.hidden = !nextCursor || capped;
    if (capped) {
      showToast(`Catalog stopped at the ${MAX_PUBLIC_PAGES}-page safety limit. Refine the search to continue.`, true);
    }
    if (!append) {
      if (state.catalogPackages[0]) {
        selectPackage(
          state.catalogPackages[0],
          elements.catalogList.querySelector("button"),
        );
      } else {
        clearPackageDetail();
      }
    }
  } catch (error) {
    if (requestId !== state.catalogRequestId) return;
    if (error instanceof PaginationSafetyError) stopCatalogPagination();
    if (!append) {
      elements.catalogList.replaceChildren();
      elements.catalogCount.value = "Unavailable";
    }
    showToast(error.message, true);
  } finally {
    if (requestId === state.catalogRequestId) {
      state.catalogLoading = false;
      elements.catalogLoadMore.disabled = false;
      elements.catalogLoadMore.textContent = "Load more Packs";
    }
  }
}

function stopCatalogPagination() {
  state.catalogCursor = null;
  elements.catalogLoadMore.hidden = true;
  if (state.catalogPackages.length > 0) {
    elements.catalogCount.value = `${state.catalogPackages.length}+ records`;
  }
}

function appendFacetPreview(container, values, label) {
  const visible = values.slice(0, 3);
  visible.forEach((value) => {
    container.append(textNode("span", `${label}: ${value}`, "facet-chip"));
  });
  if (values.length > visible.length) {
    container.append(
      textNode("span", `+${values.length - visible.length}`, "facet-overflow"),
    );
  }
}

function packageLabel(registryPackage) {
  const wrapper = document.createElement("span");
  wrapper.className = "catalog-copy";
  wrapper.append(
    textNode("span", registryPackage.name, "catalog-name"),
    textNode(
      "span",
      registryPackage.latest_version === null
        ? "No published release"
        : `${registryPackage.latest_version} · ${registryPackage.lesson_count} approved lesson${registryPackage.lesson_count === 1 ? "" : "s"}`,
      "catalog-meta",
    ),
  );
  wrapper.append(
    textNode(
      "span",
      registryPackage.discovery_available
        ? registryPackage.description || "No public description."
        : "Discovery metadata is not indexed for this Pack.",
      `catalog-description${registryPackage.discovery_available ? "" : " is-unavailable"}`,
    ),
  );
  if (registryPackage.discovery_available) {
    const facets = document.createElement("span");
    facets.className = "facet-summary";
    appendFacetPreview(facets, registryPackage.facets.languages, "Language");
    appendFacetPreview(facets, registryPackage.facets.ecosystems, "Ecosystem");
    appendFacetPreview(facets, registryPackage.facets.tags, "Tag");
    if (facets.childElementCount > 0) wrapper.append(facets);
  }
  return wrapper;
}

function selectPackage(registryPackage, button) {
  resetVersionComparison();
  state.selectedPackage = registryPackage;
  elements.catalogList.querySelectorAll("button").forEach((item) => item.classList.remove("is-selected"));
  button?.classList.add("is-selected");
  elements.packDetailTitle.textContent = registryPackage.name;
  elements.packDetailSummary.textContent = registryPackage.discovery_available
    ? registryPackage.description || `Discovery metadata is indexed for ${registryPackage.latest_version}; this Pack has no public description.`
    : "Discovery metadata is not indexed for this Pack. Published release history remains available below.";
  elements.packDetailContent.hidden = false;
  elements.releaseRecord.hidden = true;
  renderPackageEvidence(elements.packEvidence, registryPackage, [
    ["Visibility", registryPackage.visibility],
    ["Latest published", registryPackage.latest_version ?? "None"],
    ["Discovery", registryPackage.discovery_available ? "Indexed from verified release" : "Not indexed"],
    ["Approved lessons", registryPackage.discovery_available ? registryPackage.lesson_count : "Unavailable"],
    ["Created", formatDate(registryPackage.created_at)],
    ["Registry", window.location.origin],
  ]);
  loadPublicReleases(registryPackage.name);
}

function clearPackageDetail() {
  resetVersionComparison();
  state.selectedPackage = null;
  state.publicReleases = [];
  state.releaseRequestId += 1;
  state.releasePackage = null;
  state.releaseCursor = null;
  state.releaseSeenCursors = new Set();
  state.releasePageCount = 0;
  state.releaseLoading = false;
  elements.packDetailTitle.textContent = "Choose a Pack from the index";
  elements.packDetailSummary.textContent = "The release record will show its exact version and integrity before you install it.";
  elements.packDetailContent.hidden = true;
  elements.publicReleaseList.replaceChildren();
  elements.publicReleaseCount.value = "—";
  elements.releaseLoadMore.hidden = true;
  elements.compareForm.hidden = true;
}

async function loadPublicReleases(packageName, append = false) {
  if (append && state.releaseLoading) return;
  if (!append) {
    state.releaseRequestId += 1;
    state.publicReleases = [];
    state.releasePackage = packageName;
    state.releaseCursor = null;
    state.releaseSeenCursors = new Set();
    state.releasePageCount = 0;
    elements.publicReleaseCount.value = "Reading…";
    elements.releaseLoadMore.hidden = true;
    elements.compareForm.hidden = true;
    resetVersionComparison();
    setListLoading(elements.publicReleaseList, "Reading immutable release history…");
  }
  const cursor = append ? state.releaseCursor : null;
  if (append && !cursor) return;
  if (
    state.releasePageCount >= MAX_PUBLIC_PAGES ||
    (cursor && state.releaseSeenCursors.has(cursor))
  ) {
    stopReleasePagination();
    return;
  }
  const requestId = state.releaseRequestId;
  state.releaseLoading = true;
  elements.releaseLoadMore.disabled = true;
  elements.releaseLoadMore.textContent = "Reading more…";
  try {
    const parameters = new URLSearchParams({
      package_name: packageName,
      limit: String(PUBLIC_PAGE_SIZE),
    });
    if (cursor) parameters.set("cursor", cursor);
    const result = await api(
      `/v1/public/releases?${parameters}`,
    );
    if (
      requestId !== state.releaseRequestId ||
      state.selectedPackage?.name !== packageName
    ) {
      return;
    }
    const nextCursor = checkedNextCursor(
      result?.next_cursor,
      cursor,
      state.releaseSeenCursors,
    );
    if (cursor) state.releaseSeenCursors.add(cursor);
    const page = Array.isArray(result?.releases) ? result.releases : [];
    const knownVersions = new Set(
      state.publicReleases.map((item) => item.version),
    );
    const additions = page.filter((item) => {
      if (knownVersions.has(item.version)) return false;
      knownVersions.add(item.version);
      return true;
    });
    state.publicReleases.push(...additions);
    state.releaseCursor = nextCursor;
    state.releasePageCount += 1;
    if (!append) elements.publicReleaseList.replaceChildren();
    if (state.publicReleases.length === 0) {
      if (nextCursor) throw new PaginationSafetyError();
      setListLoading(elements.publicReleaseList, "No published version is available yet.");
      return;
    }
    additions.forEach((release) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "public-release-button";
      button.append(
        textNode("strong", release.version ?? "Unknown version"),
        textNode("span", release.status ?? "unknown", `release-state is-${release.status ?? "unknown"}`),
        textNode("small", `Published ${formatDate(release.published_at)}`),
      );
      button.addEventListener("click", () => {
        elements.releaseVersion.value = release.version ?? "";
        inspectRelease(packageName, release.version ?? "");
      });
      item.append(button);
      elements.publicReleaseList.append(item);
    });
    const capped = Boolean(nextCursor) && state.releasePageCount >= MAX_PUBLIC_PAGES;
    elements.publicReleaseCount.value = `${state.publicReleases.length}${capped ? "+" : ""} version${state.publicReleases.length === 1 ? "" : "s"}`;
    elements.releaseLoadMore.hidden = !nextCursor || capped;
    if (capped) {
      showToast(`Release history stopped at the ${MAX_PUBLIC_PAGES}-page safety limit.`, true);
    }
    populateVersionSelector(elements.compareFrom, state.publicReleases);
    populateVersionSelector(elements.compareTo, state.publicReleases);
    if (state.publicReleases.length > 1) {
      elements.compareFrom.value = state.publicReleases[1].version;
      elements.compareTo.value = state.publicReleases[0].version;
      elements.compareForm.hidden = false;
    }
    const installable = state.publicReleases.find((release) => release.status === "published");
    if (installable) elements.releaseVersion.value = installable.version;
  } catch (error) {
    if (
      requestId !== state.releaseRequestId ||
      state.selectedPackage?.name !== packageName
    ) {
      return;
    }
    if (error instanceof PaginationSafetyError) stopReleasePagination();
    if (!append) {
      elements.publicReleaseCount.value = "Unavailable";
      setListLoading(elements.publicReleaseList, error.message);
    } else {
      showToast(error.message, true);
    }
  } finally {
    if (requestId === state.releaseRequestId) {
      state.releaseLoading = false;
      elements.releaseLoadMore.disabled = false;
      elements.releaseLoadMore.textContent = "Load more versions";
    }
  }
}

function stopReleasePagination() {
  state.releaseCursor = null;
  elements.releaseLoadMore.hidden = true;
  if (state.publicReleases.length > 0) {
    elements.publicReleaseCount.value = `${state.publicReleases.length}+ versions`;
  }
}

function checkedNextCursor(value, currentCursor, seenCursors) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PUBLIC_CURSOR_LENGTH ||
    value === currentCursor ||
    seenCursors.has(value)
  ) {
    throw new PaginationSafetyError();
  }
  return value;
}

function populateVersionSelector(select, releases) {
  select.replaceChildren();
  releases.forEach((release) => {
    const option = document.createElement("option");
    option.value = release.version;
    option.textContent = `${release.version} — ${release.status}`;
    select.append(option);
  });
}

async function loadVersionComparison(fromVersion, toVersion) {
  const requestId = ++state.comparisonRequestId;
  setComparisonLoading(false);
  const baseline = state.publicReleases.find((release) => release.version === fromVersion);
  const candidate = state.publicReleases.find((release) => release.version === toVersion);
  if (!baseline || !candidate) {
    renderComparisonError("Both release records are required for comparison.");
    elements.comparisonStatus.textContent = "Comparison was not started.";
    return;
  }
  if (baseline.version === candidate.version) {
    renderComparisonError("Choose two different versions to compare.");
    elements.comparisonStatus.textContent = "Comparison was not started.";
    elements.compareTo.focus();
    return;
  }

  const packageName = state.selectedPackage?.name;
  if (!packageName) {
    renderComparisonError("Choose a Pack before comparing releases.");
    elements.comparisonStatus.textContent = "Comparison was not started.";
    return;
  }

  setComparisonLoading(true);
  elements.versionComparison.hidden = true;
  elements.versionComparison.replaceChildren();
  elements.comparisonStatus.textContent = `Comparing ${baseline.version} with ${candidate.version}…`;
  try {
    const parameters = new URLSearchParams({
      package_name: packageName,
      from_version: baseline.version,
      to_version: candidate.version,
    });
    const semanticDiff = await api(`/v1/public/diff?${parameters}`);
    if (
      requestId !== state.comparisonRequestId ||
      state.selectedPackage?.name !== packageName
    ) {
      return;
    }
    assertSemanticDiff(semanticDiff, packageName, baseline, candidate);
    renderVersionComparison(baseline, candidate, semanticDiff);
    elements.comparisonStatus.textContent = `${semanticDiff.lessons.added.total} added, ${semanticDiff.lessons.removed.total} removed, and ${semanticDiff.lessons.changed.total} changed lessons.`;
    elements.versionComparison.focus({ preventScroll: true });
  } catch (error) {
    if (
      requestId !== state.comparisonRequestId ||
      state.selectedPackage?.name !== packageName
    ) {
      return;
    }
    renderComparisonError(error instanceof Error ? error.message : "The semantic comparison failed.");
    elements.comparisonStatus.textContent = "Comparison failed.";
  } finally {
    if (
      requestId === state.comparisonRequestId &&
      state.selectedPackage?.name === packageName
    ) {
      setComparisonLoading(false);
    }
  }
}

function renderVersionComparison(baseline, candidate, semanticDiff) {
  const title = textNode("h4", `${baseline.version} → ${candidate.version}`);
  title.id = "version-comparison-title";
  const metadataTitle = textNode("h5", "Release metadata", "comparison-subtitle");
  const metadata = comparisonTable(
    [
      ["State", baseline.status, candidate.status],
      ["Integrity", baseline.artifact?.integrity, candidate.artifact?.integrity],
      ["Source commit", baseline.artifact?.provenance?.source_commit, candidate.artifact?.provenance?.source_commit],
      ["Approvals", baseline.approval_count, candidate.approval_count],
      ["Published", formatDate(baseline.published_at), formatDate(candidate.published_at)],
    ],
    baseline.version,
    candidate.version,
  );
  metadata.setAttribute("aria-label", "Release metadata comparison");

  elements.versionComparison.replaceChildren(
    title,
    metadataTitle,
    metadata,
    semanticDiffView(semanticDiff),
  );
  elements.versionComparison.className = "version-comparison";
  elements.versionComparison.hidden = false;
}

function semanticDiffView(diff) {
  const wrapper = document.createElement("div");
  wrapper.className = "semantic-diff";

  const title = textNode("h5", "Semantic Pack changes", "comparison-subtitle");
  const summary = document.createElement("dl");
  summary.className = "diff-summary";
  summary.setAttribute("aria-label", "Lesson change summary");
  summary.append(
    diffSummaryItem("Added", diff.lessons.added.total, "is-added"),
    diffSummaryItem("Removed", diff.lessons.removed.total, "is-removed"),
    diffSummaryItem("Changed", diff.lessons.changed.total, "is-changed"),
  );

  const facts = document.createElement("dl");
  facts.className = "semantic-facts";
  appendDefinition(facts, "Format", diff.format);
  appendDefinition(facts, "Lessons before", diff.lessons.before_count);
  appendDefinition(facts, "Lessons after", diff.lessons.after_count);
  appendDefinition(facts, "Unchanged lessons", diff.lessons.unchanged_count);

  const payloadTitle = textNode("h6", "Payload verification", "diff-section-title");
  const payloadFlags = document.createElement("dl");
  payloadFlags.className = "diff-flags";
  appendFlag(
    payloadFlags,
    "Canonical payload",
    diff.payload.canonical_payload_changed,
  );
  appendFlag(
    payloadFlags,
    "Artifact digest",
    diff.payload.artifact_digest_changed,
  );

  const manifestTitle = textNode("h6", "Manifest fields", "diff-section-title");
  const manifest = document.createElement("div");
  manifest.className = "manifest-diff";
  if (diff.manifest.changed_fields.length === 0) {
    manifest.append(textNode("p", "No manifest fields changed."));
  } else {
    const list = document.createElement("ul");
    list.className = "diff-field-list";
    diff.manifest.changed_fields.forEach((field) => {
      const item = document.createElement("li");
      item.append(textNode("code", field), textNode("span", "Changed", "diff-kind is-changed"));
      list.append(item);
    });
    manifest.append(list);
  }

  wrapper.append(
    title,
    summary,
    facts,
    payloadTitle,
    payloadFlags,
    manifestTitle,
    manifest,
  );
  appendIdentifierGroup(wrapper, "Added lesson IDs", "Added", diff.lessons.added, "is-added");
  appendIdentifierGroup(wrapper, "Removed lesson IDs", "Removed", diff.lessons.removed, "is-removed");
  appendChangedLessons(wrapper, diff.lessons.changed);
  return wrapper;
}

function diffSummaryItem(label, count, className) {
  const item = document.createElement("div");
  item.className = className;
  item.append(textNode("dt", label), textNode("dd", String(count)));
  return item;
}

function appendDefinition(list, term, value) {
  const item = document.createElement("div");
  item.append(textNode("dt", String(term)), textNode("dd", String(value)));
  list.append(item);
}

function appendFlag(list, label, changed) {
  const item = document.createElement("div");
  const stateLabel = changed ? "Changed" : "Unchanged";
  item.append(
    textNode("dt", label),
    textNode("dd", stateLabel, `diff-kind ${changed ? "is-changed" : "is-unchanged"}`),
  );
  list.append(item);
}

function appendIdentifierGroup(wrapper, heading, kind, group, className) {
  if (group.total === 0) return;
  const section = document.createElement("section");
  section.className = "diff-group";
  section.append(textNode("h6", heading, "diff-section-title"));
  if (group.items.length > 0) {
    const list = document.createElement("ul");
    list.className = "diff-id-list";
    group.items.forEach((id) => {
      const item = document.createElement("li");
      item.append(
        textNode("code", id),
        textNode("span", kind, `diff-kind ${className}`),
      );
      list.append(item);
    });
    section.append(list);
  }
  appendOmittedNotice(section, group.omitted, kind.toLowerCase());
  wrapper.append(section);
}

function appendChangedLessons(wrapper, group) {
  if (group.total === 0) return;
  const section = document.createElement("section");
  section.className = "diff-group";
  section.append(textNode("h6", "Changed lesson fields", "diff-section-title"));
  if (group.items.length > 0) {
    const list = document.createElement("ol");
    list.className = "diff-change-list";
    group.items.forEach((change) => {
      const item = document.createElement("li");
      const header = document.createElement("header");
      header.append(
        textNode("code", change.id),
        textNode("span", "Changed", "diff-kind is-changed"),
      );
      const fields = document.createElement("dl");
      fields.className = "diff-change-fields";
      appendDefinition(
        fields,
        "Semantic fields",
        change.semantic_fields.length > 0 ? change.semantic_fields.join(", ") : "None",
      );
      appendDefinition(
        fields,
        "Metadata fields",
        change.metadata_fields.length > 0 ? change.metadata_fields.join(", ") : "None",
      );
      item.append(header, fields);
      list.append(item);
    });
    section.append(list);
  }
  appendOmittedNotice(section, group.omitted, "changed");
  wrapper.append(section);
}

function appendOmittedNotice(container, omitted, kind) {
  if (omitted === 0) return;
  const notice = document.createElement("p");
  notice.className = "diff-omitted";
  notice.append(
    textNode("strong", "Output limited. "),
    textNode(
      "span",
      `${omitted} additional ${kind} lesson${omitted === 1 ? " was" : "s were"} omitted by the server.`,
    ),
  );
  container.append(notice);
}

function renderComparisonError(message) {
  const title = textNode("h4", "Comparison unavailable");
  title.id = "version-comparison-title";
  const alert = document.createElement("div");
  alert.className = "comparison-error";
  alert.setAttribute("role", "alert");
  alert.append(title, textNode("p", message));
  elements.versionComparison.replaceChildren(alert);
  elements.versionComparison.className = "version-comparison is-error";
  elements.versionComparison.hidden = false;
  elements.versionComparison.focus({ preventScroll: true });
}

function setComparisonLoading(loading) {
  state.comparisonLoading = loading;
  elements.compareForm.setAttribute("aria-busy", String(loading));
  elements.versionComparison.setAttribute("aria-busy", String(loading));
  elements.compareFrom.disabled = loading;
  elements.compareTo.disabled = loading;
  elements.compareSubmit.disabled = loading;
  elements.compareSubmit.textContent = loading ? "Comparing…" : "Compare evidence";
}

function resetVersionComparison() {
  state.comparisonRequestId += 1;
  setComparisonLoading(false);
  elements.comparisonStatus.textContent = "";
  elements.versionComparison.className = "version-comparison";
  elements.versionComparison.replaceChildren();
  elements.versionComparison.hidden = true;
}

function assertSemanticDiff(diff, packageName, baseline, candidate) {
  const invalid = () => {
    throw new Error("Registry returned an invalid semantic comparison.");
  };
  if (
    !isRecord(diff) ||
    !hasExactKeys(diff, [
      "format",
      "pack_name",
      "from",
      "to",
      "payload",
      "manifest",
      "lessons",
    ]) ||
    diff.format !== "pitlore.pack.semantic-diff.v1" ||
    diff.pack_name !== packageName ||
    !validDiffIdentity(diff.from, baseline) ||
    !validDiffIdentity(diff.to, candidate) ||
    !isRecord(diff.payload) ||
    !hasExactKeys(diff.payload, [
      "canonical_payload_changed",
      "artifact_digest_changed",
    ]) ||
    typeof diff.payload.canonical_payload_changed !== "boolean" ||
    typeof diff.payload.artifact_digest_changed !== "boolean" ||
    !isRecord(diff.manifest) ||
    !hasExactKeys(diff.manifest, ["changed_fields"]) ||
    !isAllowedUniqueStringArray(
      diff.manifest.changed_fields,
      DIFF_MANIFEST_FIELDS,
      DIFF_MANIFEST_FIELDS.size,
    ) ||
    !isRecord(diff.lessons) ||
    !hasExactKeys(diff.lessons, [
      "before_count",
      "after_count",
      "unchanged_count",
      "added",
      "removed",
      "changed",
    ]) ||
    !isDiffCount(diff.lessons.before_count) ||
    !isDiffCount(diff.lessons.after_count) ||
    !isDiffCount(diff.lessons.unchanged_count) ||
    !validIdentifierGroup(diff.lessons.added) ||
    !validIdentifierGroup(diff.lessons.removed) ||
    !validChangedGroup(diff.lessons.changed)
  ) {
    invalid();
  }
  if (
    (diff.from.version === diff.to.version &&
      (diff.from.integrity !== diff.to.integrity ||
        diff.from.digest_hex !== diff.to.digest_hex)) ||
    diff.payload.canonical_payload_changed !==
      (diff.from.integrity !== diff.to.integrity) ||
    diff.payload.artifact_digest_changed !==
      (diff.from.digest_hex !== diff.to.digest_hex) ||
    diff.lessons.before_count !==
      diff.lessons.unchanged_count + diff.lessons.removed.total + diff.lessons.changed.total ||
    diff.lessons.after_count !==
      diff.lessons.unchanged_count + diff.lessons.added.total + diff.lessons.changed.total
  ) {
    invalid();
  }
  const returnedIds = [
    ...diff.lessons.added.items,
    ...diff.lessons.removed.items,
    ...diff.lessons.changed.items.map((item) => item.id),
  ];
  if (new Set(returnedIds).size !== returnedIds.length) invalid();
}

function validDiffIdentity(identity, release) {
  return (
    isRecord(identity) &&
    hasExactKeys(identity, ["version", "integrity", "digest_hex"]) &&
    typeof identity.version === "string" &&
    identity.version === release.version &&
    typeof identity.integrity === "string" &&
    identity.integrity === release.artifact?.integrity &&
    DIFF_INTEGRITY_PATTERN.test(identity.integrity) &&
    typeof identity.digest_hex === "string" &&
    DIFF_DIGEST_PATTERN.test(identity.digest_hex)
  );
}

function validIdentifierGroup(group) {
  return (
    isRecord(group) &&
    hasExactKeys(group, ["total", "items", "omitted"]) &&
    isDiffCount(group.total) &&
    Array.isArray(group.items) &&
    group.items.length <= MAX_DIFF_DETAILS &&
    group.items.every(
      (id) => typeof id === "string" && DIFF_LESSON_ID_PATTERN.test(id),
    ) &&
    new Set(group.items).size === group.items.length &&
    isDiffCount(group.omitted) &&
    group.total === group.items.length + group.omitted
  );
}

function validChangedGroup(group) {
  return (
    isRecord(group) &&
    hasExactKeys(group, ["total", "items", "omitted"]) &&
    isDiffCount(group.total) &&
    Array.isArray(group.items) &&
    group.items.length <= MAX_DIFF_DETAILS &&
    group.items.every(validChangedLesson) &&
    new Set(group.items.map((item) => item.id)).size === group.items.length &&
    isDiffCount(group.omitted) &&
    group.total === group.items.length + group.omitted
  );
}

function validChangedLesson(item) {
  return (
    isRecord(item) &&
    hasExactKeys(item, ["id", "semantic_fields", "metadata_fields"]) &&
    typeof item.id === "string" &&
    DIFF_LESSON_ID_PATTERN.test(item.id) &&
    isAllowedUniqueStringArray(
      item.semantic_fields,
      DIFF_SEMANTIC_FIELDS,
      DIFF_SEMANTIC_FIELDS.size,
    ) &&
    isAllowedUniqueStringArray(
      item.metadata_fields,
      DIFF_METADATA_FIELDS,
      DIFF_METADATA_FIELDS.size,
    ) &&
    item.semantic_fields.length + item.metadata_fields.length > 0
  );
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isAllowedUniqueStringArray(value, allowed, maxLength) {
  return (
    isStringArray(value) &&
    value.length <= maxLength &&
    new Set(value).size === value.length &&
    value.every((item) => allowed.has(item))
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDiffCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIFF_LESSONS;
}

function comparisonTable(rows, baselineLabel, candidateLabel) {
  const list = document.createElement("dl");
  list.className = "comparison-table";
  const heading = document.createElement("div");
  heading.className = "comparison-table-heading";
  heading.append(
    textNode("dt", "Field"),
    textNode("dd", `Baseline ${baselineLabel}`),
    textNode("dd", `Candidate ${candidateLabel}`),
  );
  list.append(heading);
  rows.forEach(([label, baseline, candidate]) => {
    const row = document.createElement("div");
    row.append(
      textNode("dt", String(label)),
      textNode("dd", String(baseline ?? "—")),
      textNode("dd", String(candidate ?? "—")),
    );
    list.append(row);
  });
  return list;
}

async function inspectRelease(packageName, version) {
  elements.releaseRecord.hidden = false;
  elements.releaseRecord.className = "release-record";
  elements.releaseRecord.textContent = "Verifying the immutable release…";
  try {
    const release = await api(`/v1/public/release?package_name=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}`);
    elements.releaseRecord.replaceChildren();
    if (release.status === "yanked") elements.releaseRecord.classList.add("is-yanked");
    const title = textNode("strong", `${release.package_name}@${release.version} · ${release.status}`);
    const integrity = textNode("code", release.artifact?.integrity ?? "Integrity unavailable");
    const command = `pitlore registry install ${release.package_name}@${release.version} --url ${window.location.origin}`;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary-button";
    copy.textContent = "Copy install command";
    copy.disabled = release.status !== "published";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
        showToast("Install command copied.");
      } catch {
        showToast("Clipboard access was denied. Copy the command manually.", true);
      }
    });
    elements.releaseRecord.append(title, integrity);
    if (release.status === "yanked" && release.yank_reason) {
      elements.releaseRecord.append(
        textNode("p", `Yank reason: ${release.yank_reason}`),
      );
    }
    elements.releaseRecord.append(copy);
  } catch (error) {
    elements.releaseRecord.textContent = error.message;
    elements.releaseRecord.classList.add("is-yanked");
  }
}

async function connectWorkspace() {
  if (state.authMode === "none") {
    elements.connectionNote.textContent = "Choose SSO or enter a deployment-issued bearer.";
    return;
  }
  const authMode = state.authMode;
  const requestId = state.workspaceRequestId + 1;
  state.workspaceRequestId = requestId;
  clearProtectedWorkspace();
  elements.connectionNote.textContent = "Verifying tenant-bound access…";
  try {
    const actor = await api(`/v1/me?org_id=${encodeURIComponent(state.orgId)}`, { auth: true });
    if (requestId !== state.workspaceRequestId) return;
    state.actor = actor;
    elements.connectionNote.textContent = state.authMode === "session"
      ? `${state.actor.kind} identity connected through the current browser session.`
      : `${state.actor.kind} identity connected for this tab. The bearer was not persisted.`;
    elements.workspaceContent.hidden = false;
    elements.auditLocked.hidden = true;
    elements.auditTimeline.hidden = false;
    renderDefinitionList(elements.actorEvidence, [
      ["Actor", state.actor.kind],
      ["Role / scopes", state.actor.role ?? (state.actor.scopes ?? []).join(", ")],
      ["Tenant", state.actor.tenant_id],
      ["Subject", state.actor.subject_id],
    ]);
    await Promise.all([
      loadPendingReleases(requestId),
      loadUsage(requestId),
      loadAudit(requestId),
    ]);
    if (requestId !== state.workspaceRequestId) return;
    syncAuthControls();
    showToast("Protected workspace connected.");
  } catch (error) {
    if (requestId !== state.workspaceRequestId) return;
    state.workspaceRequestId += 1;
    state.bearer = "";
    if (authMode !== "session") state.authMode = "none";
    clearProtectedWorkspace();
    syncAuthControls();
    elements.connectionNote.textContent = authMode === "session"
      ? `${error.message} The browser session can still be signed out.`
      : `${error.message} Check the organization UUID and deployment-issued identity.`;
    showToast(error.message, true);
  }
}

async function signOutSession() {
  // This control is session-only. A deployment bearer must never trigger a
  // cookie logout as a side effect of clearing its tab-local state.
  if (state.authMode !== "session") return;
  elements.sessionSignOut.disabled = true;
  try {
    await api("/auth/logout", { auth: true, method: "POST" });
    state.workspaceRequestId += 1;
    state.orgId = "";
    state.bearer = "";
    state.authMode = "none";
    elements.orgId.value = "";
    elements.bearer.value = "";
    clearProtectedWorkspace();
    syncAuthControls();
    elements.connectionNote.textContent = "Signed out. Choose SSO or enter a deployment-issued bearer.";
    showToast("Browser session signed out.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.sessionSignOut.disabled = false;
  }
}

function syncAuthControls() {
  const sessionConnected = state.authMode === "session";
  elements.sessionSignOut.hidden = !sessionConnected;
  elements.ssoLogin.hidden = sessionConnected;
}

function clearProtectedWorkspace() {
  state.actor = null;
  state.pendingRequestId += 1;
  state.pendingItems = [];
  state.pendingCursor = null;
  state.pendingSeenCursors = new Set();
  state.pendingPageCount = 0;
  state.pendingLoading = false;
  state.auditItems = [];
  state.auditRequestId += 1;
  state.auditCursor = null;
  state.auditSeenCursors = new Set();
  state.auditPageCount = 0;
  state.auditLoading = false;
  elements.workspaceContent.hidden = true;
  elements.actorEvidence.replaceChildren();
  elements.usageEvidence.replaceChildren();
  elements.pendingReleases.replaceChildren();
  elements.pendingCount.value = "—";
  elements.pendingEmpty.hidden = true;
  elements.pendingLoadMore.hidden = true;
  elements.auditTimeline.replaceChildren();
  elements.auditTimeline.hidden = true;
  elements.auditLocked.hidden = false;
  elements.auditLoadMore.hidden = true;
}

async function loadPendingReleases(
  requestId = state.workspaceRequestId,
  append = false,
) {
  if (append && state.pendingLoading) return;
  if (!append) {
    state.pendingRequestId += 1;
    state.pendingItems = [];
    state.pendingCursor = null;
    state.pendingSeenCursors = new Set();
    state.pendingPageCount = 0;
    elements.pendingLoadMore.hidden = true;
    setListLoading(elements.pendingReleases, "Reading pending releases…");
  }
  const loadId = state.pendingRequestId;
  const cursor = append ? state.pendingCursor : null;
  if (append && !cursor) return;
  if (
    state.pendingPageCount >= MAX_AUTH_PAGES ||
    (cursor && state.pendingSeenCursors.has(cursor))
  ) {
    elements.pendingLoadMore.hidden = true;
    showToast(new PaginationSafetyError().message, true);
    return;
  }
  state.pendingLoading = true;
  elements.pendingLoadMore.disabled = true;
  elements.pendingLoadMore.textContent = "Reading more…";
  try {
    const parameters = new URLSearchParams({ limit: String(AUTH_PAGE_SIZE) });
    if (cursor) parameters.set("cursor", cursor);
    const result = await api(
      `/v1/orgs/${encodeURIComponent(state.orgId)}/releases?${parameters}`,
      { auth: true },
    );
    if (
      requestId !== state.workspaceRequestId ||
      loadId !== state.pendingRequestId
    ) return;
    const nextCursor = checkedNextCursor(
      result?.next_cursor,
      cursor,
      state.pendingSeenCursors,
    );
    if (cursor) state.pendingSeenCursors.add(cursor);
    const page = (Array.isArray(result?.releases) ? result.releases : [])
      .filter((release) => release.status === "pending");
    const knownIds = new Set(state.pendingItems.map((release) => release.id));
    const additions = page.filter((release) => {
      if (knownIds.has(release.id)) return false;
      knownIds.add(release.id);
      return true;
    });
    state.pendingItems.push(...additions);
    state.pendingCursor = nextCursor;
    state.pendingPageCount += 1;
    if (!append) elements.pendingReleases.replaceChildren();
    additions.forEach((release) => {
      elements.pendingReleases.append(releaseEntry(release));
    });
    elements.pendingCount.value = nextCursor
      ? `${state.pendingItems.length} pending loaded`
      : `${state.pendingItems.length} pending`;
    elements.pendingEmpty.hidden =
      state.pendingItems.length !== 0 || nextCursor !== null;
    const capped = Boolean(nextCursor) && state.pendingPageCount >= MAX_AUTH_PAGES;
    elements.pendingLoadMore.hidden = !nextCursor || capped;
    if (capped) showToast("Release pagination reached its browser safety limit.", true);
  } catch (error) {
    if (
      requestId !== state.workspaceRequestId ||
      loadId !== state.pendingRequestId
    ) return;
    if (!append) {
      elements.pendingReleases.replaceChildren();
      elements.pendingCount.value = "Unavailable";
    }
    elements.pendingLoadMore.hidden = true;
    showToast(error.message, true);
  } finally {
    if (loadId === state.pendingRequestId) {
      state.pendingLoading = false;
      elements.pendingLoadMore.disabled = false;
      elements.pendingLoadMore.textContent = "Load more releases";
    }
  }
}

function releaseEntry(release) {
  const item = document.createElement("li");
  item.className = "release-entry";
  const header = document.createElement("header");
  const identity = document.createElement("div");
  identity.append(
    textNode("h3", `${release.package_name}@${release.version}`),
    textNode("p", release.artifact?.integrity ?? "No integrity metadata"),
  );
  header.append(identity, textNode("span", `${release.approvals?.length ?? 0}/2 approved`, "status-label"));
  const actions = document.createElement("div");
  actions.className = "release-actions";
  const canGovern = state.actor?.kind === "human" && ["admin", "owner"].includes(state.actor.role);
  const approve = actionButton("Approve release", "approve-button", canGovern, () => reviewRelease("approve", release));
  const reject = actionButton("Reject release", "reject-button", canGovern, () => {
    const open = reject.getAttribute("aria-expanded") !== "true";
    reject.setAttribute("aria-expanded", String(open));
    rejectPanel.hidden = !open;
    rejectPanel.classList.toggle("is-open", open);
    if (open) input.focus();
  });
  reject.setAttribute("aria-expanded", "false");
  reject.setAttribute("aria-controls", `reject-panel-${release.id}`);
  actions.append(approve, reject);
  const rejectPanel = document.createElement("div");
  rejectPanel.className = "reject-form";
  rejectPanel.id = `reject-panel-${release.id}`;
  rejectPanel.hidden = true;
  const panelBody = document.createElement("div");
  const form = document.createElement("form");
  const label = textNode("label", "Reason for rejection");
  const input = document.createElement("input");
  input.name = "reason";
  input.required = true;
  input.maxLength = 1000;
  input.placeholder = "What must change before resubmission?";
  label.htmlFor = `reject-${release.id}`;
  input.id = `reject-${release.id}`;
  const confirm = actionButton("Reject this release", "reject-button", canGovern, () => {});
  confirm.type = "submit";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await reviewRelease("reject", release, input.value.trim());
  });
  form.append(label, input, confirm);
  panelBody.append(form);
  rejectPanel.append(panelBody);
  item.append(header, actions, rejectPanel);
  return item;
}

async function reviewRelease(action, release, reason) {
  const requestId = state.workspaceRequestId;
  const body = { package_name: release.package_name, version: release.version };
  if (action === "reject") body.reason = reason;
  try {
    await api(`/v1/orgs/${encodeURIComponent(state.orgId)}/releases/${action}`, {
      auth: true,
      method: "POST",
      body,
    });
    if (requestId !== state.workspaceRequestId) return;
    showToast(action === "approve" ? "Approval recorded." : "Release rejected.");
    await Promise.all([
      loadPendingReleases(requestId),
      loadAudit(requestId),
    ]);
  } catch (error) {
    if (requestId !== state.workspaceRequestId) return;
    showToast(error.message, true);
  }
}

async function loadUsage(requestId = state.workspaceRequestId) {
  try {
    const usage = await api(`/v1/orgs/${encodeURIComponent(state.orgId)}/usage/summary`, { auth: true });
    if (requestId !== state.workspaceRequestId) return;
    renderDefinitionList(elements.usageEvidence, [
      ["Downloads", usage.downloads],
      ["Explicit installs", usage.explicit_installs],
      ["Retrieve calls", usage.retrieve_calls],
      ["Check calls", usage.check_calls],
    ]);
  } catch {
    if (requestId !== state.workspaceRequestId) return;
    renderDefinitionList(elements.usageEvidence, [["Usage", "Not permitted"]]);
  }
}

async function loadAudit(requestId = state.workspaceRequestId, append = false) {
  if (!state.actor) return;
  if (append && state.auditLoading) return;
  if (!append) {
    state.auditRequestId += 1;
    state.auditItems = [];
    state.auditCursor = null;
    state.auditSeenCursors = new Set();
    state.auditPageCount = 0;
    elements.auditLoadMore.hidden = true;
  }
  const loadId = state.auditRequestId;
  const cursor = append ? state.auditCursor : null;
  if (append && !cursor) return;
  if (
    state.auditPageCount >= MAX_AUTH_PAGES ||
    (cursor && state.auditSeenCursors.has(cursor))
  ) {
    elements.auditLoadMore.hidden = true;
    showToast(new PaginationSafetyError().message, true);
    return;
  }
  elements.auditTimeline.hidden = false;
  if (!append) setListLoading(elements.auditTimeline, "Reading the audit stream…");
  state.auditLoading = true;
  elements.auditLoadMore.disabled = true;
  elements.auditLoadMore.textContent = "Reading older events…";
  try {
    const parameters = new URLSearchParams({ limit: String(AUTH_PAGE_SIZE) });
    if (cursor) parameters.set("cursor", cursor);
    const result = await api(
      `/v1/orgs/${encodeURIComponent(state.orgId)}/audit?${parameters}`,
      { auth: true },
    );
    if (
      requestId !== state.workspaceRequestId ||
      loadId !== state.auditRequestId
    ) return;
    const nextCursor = checkedNextCursor(
      result?.next_cursor,
      cursor,
      state.auditSeenCursors,
    );
    if (cursor) state.auditSeenCursors.add(cursor);
    const knownIds = new Set(state.auditItems.map((event) => event.id));
    const additions = (Array.isArray(result?.events) ? result.events : [])
      .filter((event) => {
        if (knownIds.has(event.id)) return false;
        knownIds.add(event.id);
        return true;
      });
    state.auditItems.push(...additions);
    state.auditCursor = nextCursor;
    state.auditPageCount += 1;
    if (!append) elements.auditTimeline.replaceChildren();
    additions.forEach((event) => {
      const item = document.createElement("li");
      item.append(
        textNode("strong", event.action ?? "Unknown action"),
        textNode("code", `${event.subject_type ?? "subject"}:${event.subject_id ?? "unknown"}`),
        timeNode(event.occurred_at),
      );
      elements.auditTimeline.append(item);
    });
    if (state.auditItems.length === 0) {
      setListLoading(elements.auditTimeline, "No audit event has been recorded yet.");
    }
    const capped = Boolean(nextCursor) && state.auditPageCount >= MAX_AUTH_PAGES;
    elements.auditLoadMore.hidden = !nextCursor || capped;
    if (capped) showToast("Audit pagination reached its browser safety limit.", true);
  } catch (error) {
    if (
      requestId !== state.workspaceRequestId ||
      loadId !== state.auditRequestId
    ) return;
    if (!append) setListLoading(elements.auditTimeline, error.message);
    elements.auditLoadMore.hidden = true;
  } finally {
    if (loadId === state.auditRequestId) {
      state.auditLoading = false;
      elements.auditLoadMore.disabled = false;
      elements.auditLoadMore.textContent = "Load older events";
    }
  }
}

function switchView(target) {
  if (!target) return;
  document.querySelectorAll("[data-view]").forEach((view) => {
    const active = view.dataset.view === target;
    view.hidden = !active;
    view.classList.toggle("is-active", active);
  });
  document.querySelectorAll(".view-tab").forEach((tab) => {
    const active = tab.dataset.viewTarget === target;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  document.querySelector(`[data-view="${target}"] h1`)?.focus({ preventScroll: true });
  window.location.hash = target;
}

async function api(path, options = {}) {
  const headers = { accept: "application/json" };
  const method = options.method ?? "GET";
  if (options.auth && state.authMode === "bearer") {
    headers.authorization = `Bearer ${state.bearer}`;
  }
  if (
    options.auth &&
    state.authMode === "session" &&
    !["GET", "HEAD", "OPTIONS"].includes(method)
  ) {
    const csrfToken = cookieValue("__Host-pitlore_csrf");
    if (!csrfToken) throw new Error("The browser session CSRF token is missing. Sign in again.");
    headers["x-pitlore-csrf"] = csrfToken;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const credentials =
    options.includeSession || (options.auth && state.authMode === "session")
      ? "same-origin"
      : "omit";
  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `Registry request failed with status ${response.status}.`;
    const requestId = payload?.error?.request_id;
    throw new Error(requestId ? `${message} Request ${requestId}.` : message);
  }
  return payload?.data ?? payload;
}

function cookieValue(name) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return "";
}

function renderDefinitionList(container, entries) {
  container.replaceChildren();
  entries.forEach(([term, description]) => {
    const row = document.createElement("div");
    row.append(textNode("dt", String(term)), textNode("dd", String(description ?? "—")));
    container.append(row);
  });
}

function renderPackageEvidence(container, registryPackage, entries) {
  renderDefinitionList(container, entries);
  for (const [label, values] of [
    ["Languages", registryPackage.facets.languages],
    ["Frameworks / ecosystems", registryPackage.facets.ecosystems],
    ["Tags", registryPackage.facets.tags],
  ]) {
    const row = document.createElement("div");
    const description = document.createElement("dd");
    row.append(textNode("dt", label));
    if (!registryPackage.discovery_available) {
      description.textContent = "Unavailable";
    } else if (values.length === 0) {
      description.textContent = "None declared";
    } else {
      const list = document.createElement("span");
      list.className = "facet-list";
      values.forEach((value) => {
        list.append(textNode("span", value, "facet-chip"));
      });
      description.append(list);
    }
    row.append(description);
    container.append(row);
  }
}

function actionButton(label, className, enabled, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = !enabled;
  button.addEventListener("click", action);
  return button;
}

function textNode(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function timeNode(value) {
  const node = document.createElement("time");
  node.dateTime = value ?? "";
  node.textContent = formatDate(value);
  return node;
}

function setListLoading(container, message) {
  const item = document.createElement("li");
  item.className = "empty-state";
  item.textContent = message;
  container.replaceChildren(item);
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

let toastTimer;
function showToast(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", error);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4_500);
}
