import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { BatchStatus, ImportOptions, ImportResult, ExportData } from '../types';
import { saveBatchStatus, loadBatchStatus, verifyIntegrity } from './archive';

const REQUIRED_BATCH_FIELDS = [
  'batchId', 'status', 'createdAt', 'totalPhotos', 
  'successCount', 'failedCount', 'errors', 'actions'
];

const REQUIRED_ACTION_FIELDS = [
  'id', 'type', 'sourcePath', 'targetPath', 'photoInfo', 'timestamp', 'status'
];

const REQUIRED_PHOTO_INFO_FIELDS = [
  'filePath', 'fileName', 'targetName', 'pointId', 
  'batchId', 'round', 'capturedTime', 'size'
];

export async function validateExportFile(inputPath: string): Promise<{ 
  valid: boolean; 
  errors: string[]; 
  data?: ExportData 
}> {
  const errors: string[] = [];

  if (!await fs.pathExists(inputPath)) {
    return { valid: false, errors: [`文件不存在: ${inputPath}`] };
  }

  let content: string;
  try {
    content = await fs.readFile(inputPath, 'utf-8');
  } catch (err) {
    return { valid: false, errors: [`无法读取文件: ${(err as Error).message}`] };
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return { valid: false, errors: [`JSON 解析失败: ${(err as Error).message}`] };
  }

  let batches: unknown[];

  if (Array.isArray(data)) {
    batches = data;
  } else if (typeof data === 'object' && data !== null) {
    const objData = data as Record<string, unknown>;
    if (Array.isArray(objData.batches)) {
      batches = objData.batches;
    } else {
      return { valid: false, errors: ['缺少 batches 字段或格式不正确'] };
    }
  } else {
    return { valid: false, errors: ['JSON 根节点必须是对象或数组'] };
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i] as Record<string, unknown>;
    const batchErrors = validateBatchStructure(batch, i);
    errors.push(...batchErrors);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const exportData: ExportData = Array.isArray(data) 
    ? { version: '1.0.0', exportedAt: DateTime.now().toISO(), batches: data as BatchStatus[] }
    : (data as ExportData);

  return { 
    valid: true, 
    errors: [],
    data: exportData
  };
}

function validateBatchStructure(batch: Record<string, unknown>, index: number): string[] {
  const errors: string[] = [];
  const prefix = `批次[${index}]`;

  for (const field of REQUIRED_BATCH_FIELDS) {
    if (!(field in batch)) {
      errors.push(`${prefix} 缺少必要字段: ${field}`);
    }
  }

  if (batch.batchId && typeof batch.batchId !== 'string') {
    errors.push(`${prefix} batchId 必须是字符串`);
  }

  if (batch.status && !['pending', 'running', 'completed', 'failed', 'rolled_back'].includes(batch.status as string)) {
    errors.push(`${prefix} status 值无效: ${batch.status}`);
  }

  if (Array.isArray(batch.actions)) {
    for (let j = 0; j < batch.actions.length; j++) {
      const action = batch.actions[j] as Record<string, unknown>;
      const actionPrefix = `${prefix}.actions[${j}]`;

      for (const field of REQUIRED_ACTION_FIELDS) {
        if (!(field in action)) {
          errors.push(`${actionPrefix} 缺少必要字段: ${field}`);
        }
      }

      if (action.photoInfo && typeof action.photoInfo === 'object') {
        const photoInfo = action.photoInfo as Record<string, unknown>;
        for (const field of REQUIRED_PHOTO_INFO_FIELDS) {
          if (!(field in photoInfo)) {
            errors.push(`${actionPrefix}.photoInfo 缺少必要字段: ${field}`);
          }
        }
      }
    }
  }

  return errors;
}

export async function importBatches(options: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = {
    success: false,
    message: '',
    importedBatches: [],
    skippedBatches: [],
    errors: [],
  };

  const validation = await validateExportFile(options.inputPath);
  if (!validation.valid) {
    result.errors = validation.errors;
    result.message = '导入文件校验失败';
    return result;
  }

  if (!validation.data) {
    result.errors.push('无法解析导出数据');
    result.message = '导入失败';
    return result;
  }

  const batches = validation.data.batches;

  if (options.dryRun) {
    result.success = true;
    result.message = `[DRY-RUN] 将导入 ${batches.length} 个批次`;
    result.importedBatches = batches.map(b => b.batchId);
    return result;
  }

  for (const batch of batches) {
    const existingBatch = await loadBatchStatus(batch.batchId, options.outputBasePath);

    if (existingBatch) {
      if (options.conflictStrategy === 'skip') {
        result.skippedBatches.push(batch.batchId);
        continue;
      }
    }

    await saveBatchStatus(batch, options.outputBasePath);
    result.importedBatches.push(batch.batchId);
  }

  const integrityErrors: string[] = [];
  const backupPath = path.join(options.outputBasePath, '.backup');

  for (const batchId of result.importedBatches) {
    if (await fs.pathExists(path.join(backupPath, batchId))) {
      const integrity = await verifyIntegrity(batchId, backupPath);
      if (!integrity.valid) {
        integrityErrors.push(...integrity.errors);
      }
    }
  }

  if (integrityErrors.length > 0) {
    result.errors.push(...integrityErrors);
    result.message = `导入完成但完整性校验发现 ${integrityErrors.length} 个问题`;
  } else {
    result.success = true;
    result.message = `成功导入 ${result.importedBatches.length} 个批次，跳过 ${result.skippedBatches.length} 个`;
  }

  return result;
}

export async function getImportPreview(inputPath: string): Promise<{
  valid: boolean;
  batchCount: number;
  batchIds: string[];
  exportedAt?: string;
  errors: string[];
}> {
  const validation = await validateExportFile(inputPath);
  
  if (!validation.valid) {
    return {
      valid: false,
      batchCount: 0,
      batchIds: [],
      errors: validation.errors,
    };
  }

  const data = validation.data!;
  return {
    valid: true,
    batchCount: data.batches.length,
    batchIds: data.batches.map(b => b.batchId),
    exportedAt: data.exportedAt,
    errors: [],
  };
}
