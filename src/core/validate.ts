import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { BatchStatus, ValidationResult, ValidationIssue, ValidationIssueType } from '../types';
import { listBatches, loadBatchStatus } from './archive';
import { appendLog, createLogEntry } from './operationLog';

export async function validateArchive(
  basePath: string,
  building?: string,
  fix: boolean = false
): Promise<ValidationResult> {
  const absBasePath = path.resolve(basePath);
  const archiveDir = path.join(absBasePath, 'archive');
  const batchesDir = path.join(absBasePath, 'batches');
  const backupDir = path.join(absBasePath, '.backup');

  const issues: ValidationIssue[] = [];
  const skippedLockedBatches: string[] = [];
  const allReferencedPaths = new Map<string, string[]>();
  const actuallyExistingPaths = new Set<string>();

  if (!await fs.pathExists(archiveDir)) {
    return {
      valid: true,
      issues: [],
      skippedLockedBatches: [],
      totalBatches: 0,
      totalFiles: 0,
      fixedCount: 0,
    };
  }

  const batches = await listBatches(absBasePath);

  for (const batch of batches) {
    if (batch.lock?.locked) {
      skippedLockedBatches.push(batch.batchId);
      continue;
    }

    for (const action of batch.actions) {
      if (action.status !== 'success') continue;
      if (!action.targetPath) continue;

      let normalizedPath = path.normalize(action.targetPath);
      
      if (!path.isAbsolute(normalizedPath)) {
        normalizedPath = path.normalize(path.join(absBasePath, normalizedPath));
      }

      if (building && !normalizedPath.includes(building)) {
        continue;
      }

      if (!allReferencedPaths.has(normalizedPath)) {
        allReferencedPaths.set(normalizedPath, []);
      }
      allReferencedPaths.get(normalizedPath)!.push(batch.batchId);
    }
  }

  async function scanArchive(dir: string): Promise<void> {
    const items = await fs.readdir(dir);
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const normalizedPath = path.normalize(itemPath);
      const stats = await fs.stat(itemPath);

      if (stats.isDirectory()) {
        await scanArchive(itemPath);
      } else {
        if (building && !normalizedPath.includes(building)) {
          continue;
        }
        actuallyExistingPaths.add(normalizedPath);
      }
    }
  }

  await scanArchive(archiveDir);

  for (const [refPath, batchIds] of allReferencedPaths) {
    if (!await fs.pathExists(refPath)) {
      issues.push({
        type: 'missing_file',
        path: refPath,
        description: `引用文件缺失`,
        batchIds,
      });
    }

    if (batchIds.length > 1) {
      issues.push({
        type: 'duplicate_reference',
        path: refPath,
        description: `同一文件被多个批次引用: ${batchIds.join(', ')}`,
        batchIds,
      });
    }
  }

  for (const existingPath of actuallyExistingPaths) {
    if (!allReferencedPaths.has(existingPath)) {
      issues.push({
        type: 'orphan_file',
        path: existingPath,
        description: '孤立文件未被任何批次引用',
        batchIds: [],
      });
    }
  }

  let fixedCount = 0;

  if (fix && issues.length > 0) {
    const timestamp = DateTime.now().toFormat('yyyyMMdd-HHmmss');
    const fixBackupDir = path.join(backupDir, 'validation_fix', timestamp);
    await fs.mkdirp(fixBackupDir);

    const fixLog: string[] = [];

    for (const issue of issues) {
      if (issue.type === 'orphan_file') {
        try {
          const relPath = path.relative(archiveDir, issue.path);
          const backupPath = path.join(fixBackupDir, relPath);
          await fs.mkdirp(path.dirname(backupPath));
          await fs.move(issue.path, backupPath);
          fixedCount++;
          fixLog.push(`移动孤立文件: ${issue.path} -> ${backupPath}`);
        } catch (error) {
          fixLog.push(`移动文件失败 ${issue.path}: ${(error as Error).message}`);
        }
      }
    }

    if (fixLog.length > 0) {
      await appendLog(basePath, createLogEntry(
        'validate-fix',
        { timestamp, fixedCount, totalIssues: issues.length },
        0,
        0
      ));
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    skippedLockedBatches,
    totalBatches: batches.length - skippedLockedBatches.length,
    totalFiles: actuallyExistingPaths.size,
    fixedCount,
  };
}

export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push('=== 归档完整性校验报告 ===');
  lines.push(`\n扫描批次数: ${result.totalBatches}`);
  lines.push(`扫描文件数: ${result.totalFiles}`);

  if (result.skippedLockedBatches.length > 0) {
    lines.push(`跳过锁定批次: ${result.skippedLockedBatches.length}`);
  }

  if (result.valid) {
    lines.push('\n✅ 校验通过 - 归档数据完整一致');
    return lines.join('\n');
  }

  const missingIssues = result.issues.filter(i => i.type === 'missing_file');
  const orphanIssues = result.issues.filter(i => i.type === 'orphan_file');
  const duplicateIssues = result.issues.filter(i => i.type === 'duplicate_reference');

  lines.push('\n❌ 发现不一致:');

  if (missingIssues.length > 0) {
    lines.push(`\n--- 引用文件缺失 (${missingIssues.length}) ---`);
    for (const issue of missingIssues) {
      lines.push(`  - ${issue.path}`);
      lines.push(`    ${issue.description}`);
    }
  }

  if (orphanIssues.length > 0) {
    lines.push(`\n--- 孤立文件 (${orphanIssues.length}) ---`);
    for (const issue of orphanIssues) {
      lines.push(`  - ${issue.path}`);
    }
  }

  if (duplicateIssues.length > 0) {
    lines.push(`\n--- 重复引用 (${duplicateIssues.length}) ---`);
    for (const issue of duplicateIssues) {
      lines.push(`  - ${issue.path}`);
      lines.push(`    ${issue.description}`);
    }
  }

  if (result.fixedCount > 0) {
    lines.push(`\n✅ 已修复 ${result.fixedCount} 个问题`);
    lines.push(`   备份位置: .backup/validation_fix/<timestamp>/`);
  }

  return lines.join('\n');
}

export function formatValidationResultJson(result: ValidationResult): string {
  return JSON.stringify(result, null, 2);
}