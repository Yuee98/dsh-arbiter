/** Offline reads for original-side and common-reference evaluations. */
import { resolve } from 'node:path';
import { canonicalJson } from '../data/hash.js';
import { buildReport, datasetSourceOf } from '../metrics/index.js';
import { observeRun, datasetPathOf } from '../metrics/observe.js';
import type { Observation } from '../metrics/observe.js';
import type { ReportSettings } from '../metrics/types.js';
import { versionComparison } from '../metrics/version-comparison.js';
import { versionConditions } from '../metrics/version-conditions.js';
import type { ReportCommand } from './command.js';
import { publishReport } from './publication.js';
import { comparisonEvidence } from './compare-evidence.js';

async function observed(
  directory: string,
  settings: ReportSettings,
): Promise<Observation> {
  const read = await observeRun({
    directory,
    root: settings.root,
    dataset: settings.dataset,
    references: settings.references ?? [],
  });
  if (!read.ok) throw new Error('comparison saved run could not be read');
  return read.observation;
}
export async function prepareComparison(parts: {
  readonly command: ReportCommand;
  readonly settings: ReportSettings;
  readonly current: Observation;
}) {
  const { command, settings, current } = parts;
  if (command.compare === undefined) return null;
  const directory = resolve(settings.root, command.compare);
  const originalSettings = {
    ...settings,
    dataset: datasetSourceOf(command.baselineDataset ?? null),
    references: command.baselineReferences ?? [],
  };
  const baseline = await observed(directory, originalSettings);
  // Keep each side's actual source. Only legacy labels come from the selected current dataset.
  const commonSettings = {
    ...settings,
    dataset:
      baseline.artifact.plan.workflow === undefined
        ? settings.dataset.kind === 'recorded'
          ? datasetSourceOf(current.artifact.index.plan.datasetPath)
          : settings.dataset
        : originalSettings.dataset,
  };
  const common = await observed(directory, commonSettings);
  if (
    canonicalJson(baseline.artifact.plan) !==
      canonicalJson(common.artifact.plan) ||
    canonicalJson(baseline.artifact.index) !==
      canonicalJson(common.artifact.index) ||
    baseline.artifact.records.length !== common.artifact.records.length ||
    baseline.artifact.records.some(
      (record, index) =>
        canonicalJson(record) !== canonicalJson(common.artifact.records[index]),
    )
  )
    throw new Error('baseline evidence changed between evaluations');
  const baselineReport = publishReport({
    report: buildReport({ observation: baseline, settings: originalSettings }),
    observation: baseline,
    directory,
    settings: originalSettings,
  });
  const currentReport = publishReport({
    report: buildReport({ observation: current, settings }),
    observation: current,
    directory: resolve(settings.root, command.directory),
    settings,
  });
  return {
    protectedEvidence: [
      ...(await comparisonEvidence(directory, settings.root, baseline)),
      ...(await comparisonEvidence(
        resolve(settings.root, command.directory),
        settings.root,
        current,
      )),
    ],
    directory,
    baseline,
    originalSettings,
    commonSettings,
    comparison: versionComparison(
      {
        conditions: await versionConditions(directory, settings.root, baseline),
        datasetInput: datasetPathOf(
          originalSettings.dataset,
          baseline.artifact,
        ),
        commonDatasetInput: datasetPathOf(
          commonSettings.dataset,
          baseline.artifact,
        ),
        original: baseline,
        common,
        report: baselineReport,
        referenceInputs: originalSettings.references,
        commonReferenceInputs: settings.references ?? [],
      },
      {
        conditions: await versionConditions(
          resolve(settings.root, command.directory),
          settings.root,
          current,
        ),
        datasetInput: datasetPathOf(settings.dataset, current.artifact),
        commonDatasetInput: datasetPathOf(settings.dataset, current.artifact),
        original: current,
        common: current,
        report: currentReport,
        referenceInputs: settings.references ?? [],
        commonReferenceInputs: settings.references ?? [],
      },
    ),
  };
}
