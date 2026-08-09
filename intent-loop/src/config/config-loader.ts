import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { parse } from "yaml";

import {
  BoundaryRule,
  DEFAULT_CONFIGURATION,
  IntentLoopConfiguration,
  VerificationDefinition,
} from "../domain/configuration";

type RawConfiguration = {
  verification?: Array<{
    name?: unknown;
    command?: unknown;
    invalidated_by?: unknown;
    category?: unknown;
    required?: unknown;
  }>;
  boundaries?: Array<{
    name?: unknown;
    from?: unknown;
    cannot_import?: unknown;
  }>;
  diff_expansion_threshold?: unknown;
};

export class ConfigLoader {
  public async load(repositoryRoot: string): Promise<IntentLoopConfiguration> {
    const config = await this.readYaml(path.join(repositoryRoot, ".intent-loop", "config.yaml"));
    const rules = await this.readYaml(path.join(repositoryRoot, ".intent-loop", "rules.yaml"));
    const merged: RawConfiguration = {
      ...config,
      ...rules,
      verification: config.verification ?? rules.verification,
      boundaries: rules.boundaries ?? config.boundaries,
    };

    return {
      verification: this.parseVerification(merged.verification),
      boundaries: this.parseBoundaries(merged.boundaries),
      diffExpansionThreshold: this.positiveInteger(
        merged.diff_expansion_threshold,
        DEFAULT_CONFIGURATION.diffExpansionThreshold,
      ),
    };
  }

  private async readYaml(filePath: string): Promise<RawConfiguration> {
    try {
      const value = parse(await readFile(filePath, "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${filePath} must contain a YAML object.`);
      }
      return value as RawConfiguration;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private parseVerification(raw: RawConfiguration["verification"]): VerificationDefinition[] {
    if (!raw) return [];
    if (!Array.isArray(raw)) throw new Error("verification must be an array.");
    return raw.map((item, index) => {
      const name = this.nonEmptyString(item.name, `verification[${index}].name`);
      const command = this.nonEmptyString(item.command, `verification[${index}].command`);
      const invalidatedBy = this.stringArray(
        item.invalidated_by,
        `verification[${index}].invalidated_by`,
      );
      const category = this.verificationCategory(item.category, `verification[${index}].category`);
      const required = item.required === undefined ? true : this.boolean(item.required, `verification[${index}].required`);
      return { name, command, invalidatedBy, ...(category ? { category } : {}), required };
    });
  }

  private parseBoundaries(raw: RawConfiguration["boundaries"]): BoundaryRule[] {
    if (!raw) return [];
    if (!Array.isArray(raw)) throw new Error("boundaries must be an array.");
    return raw.map((item, index) => ({
      name: this.nonEmptyString(item.name, `boundaries[${index}].name`),
      from: this.nonEmptyString(item.from, `boundaries[${index}].from`),
      cannotImport: this.stringArray(item.cannot_import, `boundaries[${index}].cannot_import`),
    }));
  }

  private nonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${field} must be a non-empty string.`);
    }
    return value.trim();
  }

  private stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${field} must be an array of non-empty strings.`);
    }
    return value.map((item) => (item as string).trim());
  }

  private positiveInteger(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
    return value;
  }

  private verificationCategory(
    value: unknown,
    field: string,
  ): VerificationDefinition["category"] {
    if (value === undefined) return undefined;
    const allowed = ["tests", "coverage", "security", "quality", "build", "other"] as const;
    if (typeof value !== "string" || !allowed.includes(value as (typeof allowed)[number])) {
      throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
    }
    return value as VerificationDefinition["category"];
  }
}
