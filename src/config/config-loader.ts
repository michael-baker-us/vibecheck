import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { parse } from "yaml";

import {
  BoundaryRule,
  DEFAULT_CONFIGURATION,
  VibeCheckConfiguration,
  VerificationDefinition,
  VerificationFormat,
  VERIFICATION_FORMATS,
  GateRecommendation,
} from "../domain/configuration";
import { PACKAGE_MANAGER_IDS, PackageManagerId, isSafePackageToken } from "./package-managers";

type RawConfiguration = {
  verification?: Array<{
    name?: unknown;
    command?: unknown;
    invalidated_by?: unknown;
    category?: unknown;
    required?: unknown;
    format?: unknown;
    report_path?: unknown;
  }>;
  recommendations?: Array<{
    category?: unknown;
    reason?: unknown;
    packages?: unknown;
    manager?: unknown;
    gate?: unknown;
  }>;
  boundaries?: Array<{
    name?: unknown;
    from?: unknown;
    cannot_import?: unknown;
  }>;
  diff_expansion_threshold?: unknown;
  plans?: {
    include?: unknown;
    active?: unknown;
  };
};

export class ConfigLoader {
  public async load(repositoryRoot: string): Promise<VibeCheckConfiguration> {
    const config = await this.readYaml(path.join(repositoryRoot, ".vibecheck", "config.yaml"));
    const rules = await this.readYaml(path.join(repositoryRoot, ".vibecheck", "rules.yaml"));
    const merged: RawConfiguration = {
      ...config,
      ...rules,
      verification: config.verification ?? rules.verification,
      recommendations: config.recommendations ?? rules.recommendations,
      boundaries: rules.boundaries ?? config.boundaries,
    };

    return {
      verification: this.parseVerification(merged.verification),
      recommendations: this.parseRecommendations(merged.recommendations),
      boundaries: this.parseBoundaries(merged.boundaries),
      diffExpansionThreshold: this.positiveInteger(
        merged.diff_expansion_threshold,
        DEFAULT_CONFIGURATION.diffExpansionThreshold,
      ),
      plans: this.parsePlans(merged.plans),
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

  private parseVerification(raw: RawConfiguration["verification"], prefix = "verification"): VerificationDefinition[] {
    if (!raw) return [];
    if (!Array.isArray(raw)) throw new Error(`${prefix} must be an array.`);
    return raw.map((item, index) => {
      const at = prefix === "verification" ? `${prefix}[${index}]` : prefix;
      const name = this.nonEmptyString(item?.name, `${at}.name`);
      const command = this.nonEmptyString(item.command, `${at}.command`);
      const invalidatedBy = this.stringArray(
        item.invalidated_by,
        `${at}.invalidated_by`,
      );
      const category = this.verificationCategory(item.category, `${at}.category`);
      const required = item.required === undefined ? true : this.boolean(item.required, `${at}.required`);
      const format = this.verificationFormat(item.format, `${at}.format`);
      const reportPath = this.reportPath(item.report_path, `${at}.report_path`);
      return {
        name,
        command,
        invalidatedBy,
        ...(category ? { category } : {}),
        required,
        ...(format ? { format } : {}),
        ...(reportPath ? { reportPath } : {}),
      };
    });
  }

  /**
   * Recommendations arrive from a provider session, so every field is validated before it can
   * reach workspace state. Packages must look like packages rather than options, and the manager
   * must be one VibeCheck knows how to invoke; anything else fails the load loudly.
   */
  private parseRecommendations(raw: RawConfiguration["recommendations"]): GateRecommendation[] {
    if (!raw) return [];
    if (!Array.isArray(raw)) throw new Error("recommendations must be an array.");
    return raw.map((item, index) => {
      const field = `recommendations[${index}]`;
      const category = this.verificationCategory(item.category, `${field}.category`);
      if (!category) throw new Error(`${field}.category is required.`);
      const reason = this.nonEmptyString(item.reason, `${field}.reason`);
      const packages = this.stringArray(item.packages, `${field}.packages`);
      if (!packages.length) throw new Error(`${field}.packages must list at least one dependency.`);
      for (const token of packages) {
        if (!isSafePackageToken(token)) {
          throw new Error(`${field}.packages contains an entry that is not a plain package name: ${token}`);
        }
      }
      const manager = item.manager === undefined ? undefined : this.nonEmptyString(item.manager, `${field}.manager`);
      if (manager && !PACKAGE_MANAGER_IDS.includes(manager as PackageManagerId)) {
        throw new Error(`${field}.manager must be one of: ${PACKAGE_MANAGER_IDS.join(", ")}.`);
      }
      const [gate] = this.parseVerification([item.gate as never], `${field}.gate`);
      if (!gate) throw new Error(`${field}.gate is required.`);
      return {
        id: `${category}:${gate.name}`,
        category,
        reason,
        packages,
        ...(manager ? { manager } : {}),
        gate: { ...gate, ...(gate.category ? {} : { category }) },
      };
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

  private parsePlans(raw: RawConfiguration["plans"]): VibeCheckConfiguration["plans"] {
    if (raw === undefined) return DEFAULT_CONFIGURATION.plans;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("plans must be an object.");
    }
    const include = raw.include === undefined
      ? DEFAULT_CONFIGURATION.plans.include
      : this.stringArray(raw.include, "plans.include");
    const active = raw.active === undefined ? undefined : this.nonEmptyString(raw.active, "plans.active");
    return { include, ...(active ? { active } : {}) };
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

  private verificationFormat(value: unknown, field: string): VerificationFormat | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !VERIFICATION_FORMATS.includes(value as VerificationFormat)) {
      throw new Error(`${field} must be one of: ${VERIFICATION_FORMATS.join(", ")}.`);
    }
    return value as VerificationFormat;
  }

  /**
   * Report paths stay repository-relative. Absolute paths and parent traversal are rejected at
   * load time so a shared configuration file cannot point VibeCheck outside the repository.
   */
  private reportPath(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    const reportPath = this.nonEmptyString(value, field);
    if (path.isAbsolute(reportPath) || reportPath.split(/[\\/]/).includes("..")) {
      throw new Error(`${field} must be a repository-relative path without "..".`);
    }
    return reportPath;
  }
}
