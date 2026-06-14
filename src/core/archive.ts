import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { Config, PhotoInfo, BatchStatus, BatchAction, DryRunResult, IntegrityRecord } from '../types';
import { scanPhotos } from '../utils/photoParser';
import { performDryRun } from './dryRun';

export async function executeArchive(
  inputDir: string,
  config: Config,
  dryRunResult?: DryRunResult
): Promise<BatchStatus> {
  if (!dryRunResult) {
    dryRunResult = await performDryRun(inputDir, config);
  }

  if (dryRunResult.missingPoints.length > 0) {
    throw new Error(`缺少必拍点位，无法执行归档:\n${dryRunResult.missingPoints.join('\n')}`);
  }

  if (dryRunResult.directoryConflicts.length > 0) {
    throw new Error(`输出目录冲突，无法执行归档:\n${dryRunResult.directoryConflicts.join('\n')}`);
  }

  const batchId = uuidv4();
  const batchDir = path.join(config.outputBasePath, 'batches', batchId);
  await fs.mkdirp(batchDir);

  const backupDir = path.join(config.backupPath, batchId);
  if (config.backupEnabled) {
    await fs.mkdirp(backupDir);
  }

  const status: BatchStatus = {
    batchId,
    status: 'running',
    createdAt: DateTime.now().toISO(),
    totalPhotos: dryRunResult.totalPhotos,
    successCount: 0,
    failedCount: 0,
    errors: [],
    actions: [],
    lock: {
      locked: true,
      lockedAt: DateTime.now().toISO(),
      lockedBy: 'archive',
    },
  };

  await saveBatchStatus(status, config.outputBasePath);

  const photos = await scanPhotos(inputDir, config);
  const integrityFiles: IntegrityRecord['files'] = [];

  for (const photo of photos) {
    if (photo.pointId === 'unknown') continue;

    const action: BatchAction = {
      id: uuidv4(),
      type: 'copy',
      sourcePath: photo.filePath,
      targetPath: '',
      photoInfo: photo,
      timestamp: DateTime.now().toISO(),
      status: 'pending',
    };

    try {
      const point = config.points.find(p => p.id === photo.pointId);
      if (!point) {
        action.status = 'failed';
        action.error = '点位不存在';
        status.errors.push(`点位 ${photo.pointId} 不存在`);
        status.failedCount++;
        continue;
      }

      const buildingDir = path.join(config.outputBasePath, 'archive', point.building);
      const pointDir = path.join(buildingDir, `${point.floor}-${point.position}`);
      const targetPath = path.join(pointDir, photo.targetName);

      await fs.mkdirp(pointDir);
      await fs.copy(photo.filePath, targetPath);

      if (config.backupEnabled) {
        const backupFilePath = path.join(backupDir, path.basename(photo.filePath));
        await fs.copy(photo.filePath, backupFilePath);
        
        const sha256 = await calculateSHA256(backupFilePath);
        const stats = await fs.stat(backupFilePath);
        integrityFiles.push({
          fileName: path.basename(backupFilePath),
          sha256,
          size: stats.size,
        });
      }

      action.targetPath = targetPath;
      action.status = 'success';
      status.successCount++;

    } catch (error) {
      action.status = 'failed';
      action.error = (error as Error).message;
      status.errors.push(`文件 ${photo.fileName} 处理失败: ${(error as Error).message}`);
      status.failedCount++;
    }

    status.actions.push(action);
  }

  if (config.archiveFormat === 'zip') {
    const zipPath = path.join(config.outputBasePath, `${batchId}.zip`);
    await createZipArchive(config.outputBasePath, 'archive', zipPath);
  }

  if (config.backupEnabled && integrityFiles.length > 0) {
    const integrity: IntegrityRecord = {
      batchId,
      createdAt: DateTime.now().toISO(),
      files: integrityFiles,
    };
    const integrityPath = path.join(backupDir, 'integrity.json');
    await fs.writeFile(integrityPath, JSON.stringify(integrity, null, 2));
  }

  status.status = status.failedCount === 0 ? 'completed' : 'failed';
  status.completedAt = DateTime.now().toISO();
  status.lock = {
    locked: false,
    lockedAt: undefined,
    lockedBy: undefined,
  };

  await saveBatchStatus(status, config.outputBasePath);

  return status;
}

export async function calculateSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function verifyIntegrity(batchId: string, backupPath: string): Promise<{ valid: boolean; errors: string[] }> {
  const backupDir = path.join(backupPath, batchId);
  const integrityPath = path.join(backupDir, 'integrity.json');
  
  if (!await fs.pathExists(integrityPath)) {
    return { valid: true, errors: [] };
  }

  const integrityContent = await fs.readFile(integrityPath, 'utf-8');
  const integrity: IntegrityRecord = JSON.parse(integrityContent);
  const errors: string[] = [];

  for (const entry of integrity.files) {
    const filePath = path.join(backupDir, entry.fileName);
    if (!await fs.pathExists(filePath)) {
      errors.push(`备份文件缺失: ${entry.fileName}`);
      continue;
    }

    const actualHash = await calculateSHA256(filePath);
    if (actualHash !== entry.sha256) {
      errors.push(`哈希校验失败: ${entry.fileName} (期望: ${entry.sha256}, 实际: ${actualHash})`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function createZipArchive(sourceDir: string, folderName: string, outputPath: string): Promise<void> {
  const zip = new JSZip();
  const folder = zip.folder(folderName)!;

  async function addFiles(dir: string, parentFolder: JSZip) {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        const subFolder = parentFolder.folder(file)!;
        await addFiles(filePath, subFolder);
      } else {
        const content = await fs.readFile(filePath);
        parentFolder.file(file, content);
      }
    }
  }

  await addFiles(path.join(sourceDir, folderName), folder);
  const content = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outputPath, content);
}

export async function saveBatchStatus(status: BatchStatus, basePath: string): Promise<void> {
  const statusDir = path.join(basePath, 'batches', status.batchId);
  await fs.mkdirp(statusDir);
  await fs.writeFile(path.join(statusDir, 'status.json'), JSON.stringify(status, null, 2));
}

export async function loadBatchStatus(batchId: string, basePath: string): Promise<BatchStatus | null> {
  const statusPath = path.join(basePath, 'batches', batchId, 'status.json');
  if (!await fs.pathExists(statusPath)) {
    return null;
  }
  const content = await fs.readFile(statusPath, 'utf-8');
  return JSON.parse(content);
}

export async function listBatches(basePath: string): Promise<BatchStatus[]> {
  const batchesDir = path.join(basePath, 'batches');
  if (!await fs.pathExists(batchesDir)) {
    return [];
  }

  const batchIds = await fs.readdir(batchesDir);
  const statuses: BatchStatus[] = [];

  for (const id of batchIds) {
    const status = await loadBatchStatus(id, basePath);
    if (status) {
      statuses.push(status);
    }
  }

  return statuses.sort((a, b) => 
    DateTime.fromISO(b.createdAt).toMillis() - DateTime.fromISO(a.createdAt).toMillis()
  );
}
