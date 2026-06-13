import * as fs from 'fs-extra';
import * as path from 'path';
import { BatchStatus, RollbackResult } from '../types';
import { loadBatchStatus } from './archive';

export async function rollbackBatch(
  batchId: string,
  basePath: string
): Promise<RollbackResult> {
  const status = await loadBatchStatus(batchId, basePath);
  
  if (!status) {
    return {
      success: false,
      message: `批次 ${batchId} 不存在`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  if (status.status === 'rolled_back') {
    return {
      success: false,
      message: `批次 ${batchId} 已回滚`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  if (status.status !== 'completed') {
    return {
      success: false,
      message: `批次 ${batchId} 状态不是已完成，无法回滚`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  const backupDir = path.join(basePath, '.backup', batchId);
  if (!await fs.pathExists(backupDir)) {
    return {
      success: false,
      message: `批次 ${batchId} 的备份不存在，无法回滚`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  const errors: string[] = [];
  let restoredFiles = 0;
  let deletedFiles = 0;

  for (const action of status.actions) {
    if (action.status !== 'success') continue;

    try {
      const targetPath = action.targetPath;
      if (await fs.pathExists(targetPath)) {
        await fs.remove(targetPath);
        deletedFiles++;
      }
    } catch (error) {
      errors.push(`删除文件失败 ${action.targetPath}: ${(error as Error).message}`);
    }
  }

  status.status = 'rolled_back';
  const statusPath = path.join(basePath, 'batches', batchId, 'status.json');
  await fs.writeFile(statusPath, JSON.stringify(status, null, 2));

  return {
    success: errors.length === 0,
    message: errors.length === 0 
      ? `批次 ${batchId} 回滚成功，删除 ${deletedFiles} 个文件`
      : `批次 ${batchId} 回滚完成，但有 ${errors.length} 个错误`,
    restoredFiles,
    deletedFiles,
    errors,
  };
}

export async function mergeRetryBatch(
  sourceBatchId: string,
  targetBatchId: string,
  basePath: string
): Promise<RollbackResult> {
  const sourceStatus = await loadBatchStatus(sourceBatchId, basePath);
  const targetStatus = await loadBatchStatus(targetBatchId, basePath);

  if (!sourceStatus) {
    return {
      success: false,
      message: `源批次 ${sourceBatchId} 不存在`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  if (!targetStatus) {
    return {
      success: false,
      message: `目标批次 ${targetBatchId} 不存在`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  if (targetStatus.status !== 'completed') {
    return {
      success: false,
      message: `目标批次 ${targetBatchId} 状态不是已完成`,
      restoredFiles: 0,
      deletedFiles: 0,
      errors: [],
    };
  }

  const errors: string[] = [];
  let restoredFiles = 0;

  for (const action of sourceStatus.actions) {
    if (action.status !== 'success') continue;

    try {
      const pointId = action.photoInfo.pointId;
      const existingAction = targetStatus.actions.find(
        a => a.photoInfo.pointId === pointId && a.status === 'success'
      );

      if (existingAction) {
        if (await fs.pathExists(existingAction.targetPath)) {
          await fs.remove(existingAction.targetPath);
        }
      }

      const targetPath = action.targetPath.replace(sourceBatchId, targetBatchId);
      await fs.copy(action.sourcePath, targetPath);
      restoredFiles++;
    } catch (error) {
      errors.push(`合并文件失败 ${action.sourcePath}: ${(error as Error).message}`);
    }
  }

  return {
    success: errors.length === 0,
    message: errors.length === 0
      ? `合并成功，合并 ${restoredFiles} 个补拍照片`
      : `合并完成，但有 ${errors.length} 个错误`,
    restoredFiles,
    deletedFiles: 0,
    errors,
  };
}
