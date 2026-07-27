import { z } from "zod";
import type { VerifiedPack } from "./pack.js";

const FACET_DIMENSIONS = ["languages", "ecosystems", "tags"] as const;
const MAX_FACET_VALUE_LENGTH = 64;
const MAX_FILTER_VALUES_PER_DIMENSION = 4;
const MAX_DOCUMENT_VALUES_PER_DIMENSION = 64;
const MAX_DESCRIPTION_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

type FacetDimension = (typeof FACET_DIMENSIONS)[number];

export interface PublicPackDiscoveryFilterInput {
  languages?: readonly string[];
  ecosystems?: readonly string[];
  tags?: readonly string[];
}

export interface PublicPackDiscoveryFilter {
  languages: string[];
  ecosystems: string[];
  tags: string[];
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Canonicalize one public discovery facet value. Facets remain free-form so
 * common ecosystem spellings such as C#, C++, and .NET are preserved.
 */
export function normalizePublicPackDiscoveryFacet(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Discovery facet value must be a string");
  }
  const normalized = value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  if (normalized.length === 0) {
    throw new Error("Discovery facet value must not be empty");
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new Error("Discovery facet value must not contain control characters");
  }
  if (unicodeLength(normalized) > MAX_FACET_VALUE_LENGTH) {
    throw new Error(
      `Discovery facet value must be at most ${MAX_FACET_VALUE_LENGTH} characters`,
    );
  }
  return normalized;
}

const CanonicalDiscoveryFacetSchema = z
  .string()
  .superRefine((value, context) => {
    try {
      const canonical = normalizePublicPackDiscoveryFacet(value);
      if (canonical !== value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "discovery facet value must use canonical normalized form",
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const CanonicalDiscoveryFacetArraySchema = z
  .array(CanonicalDiscoveryFacetSchema)
  .max(MAX_DOCUMENT_VALUES_PER_DIMENSION)
  .superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      if (compareCanonicalText(values[index - 1], values[index]) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "discovery facets must be sorted and unique",
        });
        return;
      }
    }
  });

const DiscoveryDescriptionSchema = z.string().transform((value, context) => {
  const trimmed = value.trim();
  if (CONTROL_CHARACTERS.test(trimmed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "discovery description must not contain control characters",
    });
    return z.NEVER;
  }
  if (unicodeLength(trimmed) > MAX_DESCRIPTION_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `discovery description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    });
    return z.NEVER;
  }
  return trimmed;
});

export const PublicPackDiscoveryDocumentSchema = z
  .object({
    version: z.literal(1),
    description: DiscoveryDescriptionSchema,
    languages: CanonicalDiscoveryFacetArraySchema,
    ecosystems: CanonicalDiscoveryFacetArraySchema,
    tags: CanonicalDiscoveryFacetArraySchema,
    lesson_count: z.number().int().min(0).max(1_000),
  })
  .strict();

export type PublicPackDiscoveryDocument = z.infer<
  typeof PublicPackDiscoveryDocumentSchema
>;

export const EMPTY_PUBLIC_PACK_DISCOVERY_DOCUMENT = Object.freeze({
  version: 1 as const,
  description: "",
  languages: Object.freeze([]),
  ecosystems: Object.freeze([]),
  tags: Object.freeze([]),
  lesson_count: 0,
});

export function emptyPublicPackDiscoveryDocument(): PublicPackDiscoveryDocument {
  return PublicPackDiscoveryDocumentSchema.parse(
    EMPTY_PUBLIC_PACK_DISCOVERY_DOCUMENT,
  );
}

function normalizeFilterDimension(
  value: readonly string[] | undefined,
  dimension: FacetDimension,
): string[] {
  const input = value === undefined ? [] : value;
  if (!Array.isArray(input)) {
    throw new Error(`Discovery filter ${dimension} must be an array`);
  }
  if (input.length > MAX_FILTER_VALUES_PER_DIMENSION) {
    throw new Error(
      `Discovery filter ${dimension} must contain at most ${MAX_FILTER_VALUES_PER_DIMENSION} values`,
    );
  }
  return [...new Set(input.map(normalizePublicPackDiscoveryFacet))].sort(
    compareCanonicalText,
  );
}

export function normalizePublicPackDiscoveryFilter(
  input: PublicPackDiscoveryFilterInput = {},
): PublicPackDiscoveryFilter {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Discovery filter must be an object");
  }
  const unknownKeys = Object.keys(input).filter(
    (key) => !FACET_DIMENSIONS.includes(key as FacetDimension),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown discovery filter field: ${unknownKeys[0]}`);
  }
  return {
    languages: normalizeFilterDimension(input.languages, "languages"),
    ecosystems: normalizeFilterDimension(input.ecosystems, "ecosystems"),
    tags: normalizeFilterDimension(input.tags, "tags"),
  };
}

function canonicalFacetSet(
  values: readonly string[],
  dimension: FacetDimension,
): string[] {
  const canonical = [
    ...new Set(values.map(normalizePublicPackDiscoveryFacet)),
  ].sort(compareCanonicalText);
  if (canonical.length > MAX_DOCUMENT_VALUES_PER_DIMENSION) {
    throw new Error(
      `Discovery document ${dimension} exceeds ${MAX_DOCUMENT_VALUES_PER_DIMENSION} unique values`,
    );
  }
  return canonical;
}

/** Build the active, public-searchable metadata projection of a verified Pack. */
export function buildPublicPackDiscoveryDocument(
  pack: VerifiedPack,
): PublicPackDiscoveryDocument {
  if (pack.store.loadErrors.length > 0) {
    throw new Error(
      "Cannot build discovery metadata from a Pack with load errors",
    );
  }

  const activeLessons = pack.store.lessons.filter(
    (lesson) => lesson.status === "approved",
  );
  const rawFacets: Record<FacetDimension, string[]> = {
    languages: [],
    ecosystems: [],
    tags: [],
  };
  for (const lesson of activeLessons) {
    rawFacets.languages.push(...lesson.languages);
    rawFacets.ecosystems.push(...lesson.ecosystems);
    rawFacets.tags.push(...lesson.tags);
  }

  return PublicPackDiscoveryDocumentSchema.parse({
    version: 1,
    description: pack.store.manifest.description,
    languages: canonicalFacetSet(rawFacets.languages, "languages"),
    ecosystems: canonicalFacetSet(rawFacets.ecosystems, "ecosystems"),
    tags: canonicalFacetSet(rawFacets.tags, "tags"),
    lesson_count: activeLessons.length,
  });
}

/** Same-dimension filters are OR; constraints across dimensions are AND. */
export function matchesPublicPackDiscoveryFilter(
  document: PublicPackDiscoveryDocument,
  input: PublicPackDiscoveryFilterInput = {},
): boolean {
  const parsed = PublicPackDiscoveryDocumentSchema.parse(document);
  const filter = normalizePublicPackDiscoveryFilter(input);

  return FACET_DIMENSIONS.every((dimension) => {
    if (filter[dimension].length === 0) return true;
    const available = new Set(parsed[dimension]);
    return filter[dimension].some((value) => available.has(value));
  });
}
