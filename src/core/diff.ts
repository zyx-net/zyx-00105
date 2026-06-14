import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { stringify } from 'csv-stringify/sync';
import { 
  BatchStatus, 
  BatchAction, 
  DiffResult, 
  DiffEntry, 
  DiffChangeEntry,
  DiffSummary 
} from '../types';
import { loadBatchStatus } from './archive';

function formatTimeDiff(ms1: string, ms2: string): string {
  const dt1 = DateTime.fromISO(ms1);
  const dt2 = DateTime.fromISO(ms2);
  const diff = dt2.diff(dt1);
  
  const hours = Math.abs(diff.hours);
  const minutes = Math.abs(diff.minutes % 60);
  const seconds = Math.abs(diff.seconds % 60);
  
  const sign = diff.milliseconds >= 0 ? '+' : '-';
  return `${sign}${hours}h${minutes}m${seconds}s`;
}

function actionToDiffEntry(action: BatchAction): DiffEntry {
  return {
    pointId: action.photoInfo.pointId,
    fileName: action.photoInfo.fileName,
    targetPath: action.targetPath,
    size: action.photoInfo.size,
    capturedTime: action.photoInfo.capturedTime,
  };
}

function validateBatchForDiff(status: BatchStatus): { valid: boolean; error?: string } {
  if (status.status === 'rolled_back') {
    return {
      valid: false,
      error: `Batch ${status.batchId} has been rolled back`,
    };
  }
  
  if (status.status === 'running') {
    return {
      valid: false,
      error: `Batch ${status.batchId} is still running`,
    };
  }
  
  if (status.status !== 'completed') {
    return {
      valid: false,
      error: `Batch ${status.batchId} is not completed (status: ${status.status})`,
    };
  }
  
  return { valid: true };
}

export async function compareBatches(
  basePath: string,
  batchId1: string,
  batchId2: string,
  dryRun: boolean = false
): Promise<{ success: boolean; message: string; result?: DiffResult }> {
  const status1 = await loadBatchStatus(batchId1, basePath);
  const status2 = await loadBatchStatus(batchId2, basePath);
  
  if (!status1) {
    return {
      success: false,
      message: `Batch ${batchId1} does not exist`,
    };
  }
  
  if (!status2) {
    return {
      success: false,
      message: `Batch ${batchId2} does not exist`,
    };
  }
  
  const validation1 = validateBatchForDiff(status1);
  if (!validation1.valid) {
    return {
      success: false,
      message: validation1.error!,
    };
  }
  
  const validation2 = validateBatchForDiff(status2);
  if (!validation2.valid) {
    return {
      success: false,
      message: validation2.error!,
    };
  }
  
  const actions1 = status1.actions.filter(a => a.status === 'success');
  const actions2 = status2.actions.filter(a => a.status === 'success');
  
  const map1 = new Map<string, BatchAction>();
  const map2 = new Map<string, BatchAction>();
  
  for (const action of actions1) {
    map1.set(action.photoInfo.pointId, action);
  }
  
  for (const action of actions2) {
    map2.set(action.photoInfo.pointId, action);
  }
  
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffChangeEntry[] = [];
  let unchanged = 0;
  
  for (const [pointId, action] of map2) {
    if (!map1.has(pointId)) {
      added.push(actionToDiffEntry(action));
    }
  }
  
  for (const [pointId, action1] of map1) {
    if (!map2.has(pointId)) {
      removed.push(actionToDiffEntry(action1));
    } else {
      const action2 = map2.get(pointId)!;
      
      if (action1.photoInfo.size !== action2.photoInfo.size ||
          action1.photoInfo.capturedTime !== action2.photoInfo.capturedTime) {
        changed.push({
          pointId,
          fileName: action2.photoInfo.fileName,
          targetPath: action2.targetPath,
          size: action2.photoInfo.size,
          capturedTime: action2.photoInfo.capturedTime,
          oldSize: action1.photoInfo.size,
          newSize: action2.photoInfo.size,
          sizeDiff: action2.photoInfo.size - action1.photoInfo.size,
          oldCapturedTime: action1.photoInfo.capturedTime,
          newCapturedTime: action2.photoInfo.capturedTime,
          timeDiff: formatTimeDiff(action1.photoInfo.capturedTime, action2.photoInfo.capturedTime),
        });
      } else {
        unchanged++;
      }
    }
  }
  
  const summary: DiffSummary = {
    totalAdded: added.length,
    totalRemoved: removed.length,
    totalChanged: changed.length,
    totalUnchanged: unchanged,
  };
  
  const result: DiffResult = {
    batchId1,
    batchId2,
    comparedAt: DateTime.now().toISO(),
    added,
    removed,
    changed,
    summary,
  };
  
  if (dryRun) {
    return {
      success: true,
      message: `[DRY-RUN] Would compare batches ${batchId1} and ${batchId2}`,
      result,
    };
  }
  
  const diffDir = path.join(basePath, 'batches', batchId2, 'diffs');
  await fs.mkdirp(diffDir);
  
  const diffFileName = `diff_${batchId1}_vs_${batchId2}.json`;
  const diffPath = path.join(diffDir, diffFileName);
  await fs.writeFile(diffPath, JSON.stringify(result, null, 2));
  
  return {
    success: true,
    message: `Comparison completed. Results saved to ${diffPath}`,
    result,
  };
}

export async function exportDiffResult(
  outputPath: string,
  format: 'json' | 'csv',
  result: DiffResult
): Promise<string> {
  if (format === 'json') {
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
    return `Diff result exported to JSON: ${outputPath}`;
  }
  
  const records: any[] = [];
  
  for (const entry of result.added) {
    records.push({
      type: 'added',
      pointId: entry.pointId,
      fileName: entry.fileName,
      targetPath: entry.targetPath,
      size: entry.size,
      capturedTime: entry.capturedTime,
      sizeDiff: '',
      timeDiff: '',
    });
  }
  
  for (const entry of result.removed) {
    records.push({
      type: 'removed',
      pointId: entry.pointId,
      fileName: entry.fileName,
      targetPath: entry.targetPath,
      size: entry.size,
      capturedTime: entry.capturedTime,
      sizeDiff: '',
      timeDiff: '',
    });
  }
  
  for (const entry of result.changed) {
    records.push({
      type: 'changed',
      pointId: entry.pointId,
      fileName: entry.fileName,
      targetPath: entry.targetPath,
      size: entry.newSize,
      capturedTime: entry.newCapturedTime,
      sizeDiff: entry.sizeDiff,
      timeDiff: entry.timeDiff,
    });
  }
  
  const headers = ['type', 'pointId', 'fileName', 'targetPath', 'size', 'capturedTime', 'sizeDiff', 'timeDiff'];
  const csvContent = stringify(records, { header: true, columns: headers });
  await fs.writeFile(outputPath, csvContent);
  
  return `Diff result exported to CSV: ${outputPath}`;
}

export function formatDiffReport(result: DiffResult): string {
  const lines: string[] = [];
  
  lines.push('=== Batch Comparison Report ===');
  lines.push(`Batch 1: ${result.batchId1}`);
  lines.push(`Batch 2: ${result.batchId2}`);
  lines.push(`Compared at: ${DateTime.fromISO(result.comparedAt).toFormat('yyyy-MM-dd HH:mm:ss')}`);
  lines.push('');
  lines.push('--- Summary ---');
  lines.push(`Added: ${result.summary.totalAdded}`);
  lines.push(`Removed: ${result.summary.totalRemoved}`);
  lines.push(`Changed: ${result.summary.totalChanged}`);
  lines.push(`Unchanged: ${result.summary.totalUnchanged}`);
  
  if (result.added.length > 0) {
    lines.push('');
    lines.push('--- Added Photos ---');
    for (const entry of result.added) {
      lines.push(`  [${entry.pointId}] ${entry.fileName} (${entry.size} bytes)`);
    }
  }
  
  if (result.removed.length > 0) {
    lines.push('');
    lines.push('--- Removed Photos ---');
    for (const entry of result.removed) {
      lines.push(`  [${entry.pointId}] ${entry.fileName} (${entry.size} bytes)`);
    }
  }
  
  if (result.changed.length > 0) {
    lines.push('');
    lines.push('--- Changed Photos ---');
    for (const entry of result.changed) {
      const sizeDiffStr = entry.sizeDiff >= 0 ? `+${entry.sizeDiff}` : `${entry.sizeDiff}`;
      lines.push(`  [${entry.pointId}] ${entry.fileName}`);
      lines.push(`    Size: ${entry.oldSize} -> ${entry.newSize} (${sizeDiffStr} bytes)`);
      lines.push(`    Time: ${entry.timeDiff}`);
    }
  }
  
  return lines.join('\n');
}
