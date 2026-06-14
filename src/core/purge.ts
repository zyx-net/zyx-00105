import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { BatchStatus } from '../types';
import { loadBatchStatus, listBatches } from './archive';

export interface PurgeResult {
  success: boolean;
  message: string;
  deletedBatches: string[];
  deletedBackups: string[];
  skippedBatches: string[];
  errors: string[];
}

export async function purgeOldBatches(
  basePath: string,
  keepDays?: number,
  keepRecent?: number
): Promise<PurgeResult> {
  const batches = await listBatches(basePath);
  const deletedBatches: string[] = [];
  const deletedBackups: string[] = [];
  const skippedBatches: string[] = [];
  const errors: string[] = [];

  const sortedBatches = [...batches].sort((a, b) =>
    DateTime.fromISO(b.createdAt).toMillis() - DateTime.fromISO(a.createdAt).toMillis()
  );

  const cutoffDate = keepDays 
    ? DateTime.now().minus({ days: keepDays }).toISO()
    : null;

  const batchIdsToKeep = new Set<string>();

  if (keepRecent && sortedBatches.length > 0) {
    const keepCount = Math.min(keepRecent, sortedBatches.length);
    for (let i = 0; i < keepCount; i++) {
      batchIdsToKeep.add(sortedBatches[i].batchId);
    }
  }

  for (const batch of batches) {
    if (batch.status === 'running') {
      skippedBatches.push(batch.batchId);
      continue;
    }

    if (batch.lock?.locked) {
      skippedBatches.push(batch.batchId);
      continue;
    }

    if (keepRecent && !batchIdsToKeep.has(batch.batchId)) {
      await deleteBatch(batch, basePath, deletedBatches, deletedBackups, errors);
      continue;
    }

    if (cutoffDate && DateTime.fromISO(batch.createdAt) < DateTime.fromISO(cutoffDate)) {
      await deleteBatch(batch, basePath, deletedBatches, deletedBackups, errors);
    }
  }

  return {
    success: errors.length === 0,
    message: `清理完成：删除 ${deletedBatches.length} 个批次，跳过 ${skippedBatches.length} 个锁定/运行中的批次`,
    deletedBatches,
    deletedBackups,
    skippedBatches,
    errors,
  };
}

async function deleteBatch(
  batch: BatchStatus,
  basePath: string,
  deletedBatches: string[],
  deletedBackups: string[],
  errors: string[]
): Promise<void> {
  const batchDir = path.join(basePath, 'batches', batch.batchId);
  const backupDir = path.join(basePath, '.backup', batch.batchId);

  try {
    if (await fs.pathExists(batchDir)) {
      await fs.remove(batchDir);
      deletedBatches.push(batch.batchId);
    }
  } catch (error) {
    errors.push(`删除批次目录失败 ${batch.batchId}: ${(error as Error).message}`);
  }

  try {
    if (await fs.pathExists(backupDir)) {
      await fs.remove(backupDir);
      deletedBackups.push(batch.batchId);
    }
  } catch (error) {
    errors.push(`删除备份目录失败 ${batch.batchId}: ${(error as Error).message}`);
  }
}

export async function isBatchLocked(batchId: string, basePath: string): Promise<boolean> {
  const status = await loadBatchStatus(batchId, basePath);
  return status?.lock?.locked ?? false;
}