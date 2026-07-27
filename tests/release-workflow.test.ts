import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  env?: Record<string, unknown>;
  run?: unknown;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

describe("npm release workflow", () => {
  it("publishes an explicit local tarball in both gated jobs", () => {
    const workflow = fs.readFileSync(
      fileURLToPath(
        new URL("../.github/workflows/npm-publish.yml", import.meta.url),
      ),
      "utf8",
    );
    const document = yaml.load(workflow) as {
      jobs?: Record<string, WorkflowJob>;
    };

    for (const jobName of ["release-candidate", "publish-npm"]) {
      const publishSteps = (document.jobs?.[jobName]?.steps ?? []).filter(
        (step) =>
          typeof step.run === "string" &&
          step.run.startsWith('npm publish "$PITLORE_RELEASE_ARCHIVE"'),
      );
      expect(publishSteps, `${jobName} must publish exactly once`).toHaveLength(
        1,
      );
      const archive = publishSteps[0]?.env?.PITLORE_RELEASE_ARCHIVE;
      expect(archive).toBeTypeOf("string");
      expect(archive).toMatch(/^\.\/package-artifact\/pitlore-/u);
      expect(archive).toMatch(/\.tgz$/u);
    }
  });
});
