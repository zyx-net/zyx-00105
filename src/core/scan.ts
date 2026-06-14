import * as fs from 'fs-extra';
import * as path from 'path';
import { BatchStatus, ScanResult, ScanIssue, IntegrityRecord } from '../types';
import { loadBatchStatus, listBatches, verifyIntegrity } from './archive';

export async function scanWorkspace(outputBasePath: string): Promise<ScanResult> {
  const issues: ScanIssue[] = [];
  const orphanFiles: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let passed = 0;
  let failed = 0;

  const batchesDir = path.join(outputBasePath, 'batches');
  const archiveDir = path.join(outputBasePath, 'archive');
  const backupDir = path.join(outputBasePath, '.backup');

  if (!await fs.pathExists(batchesDir)) {
    issues.push({ level: 'info', message: 'batches 目录不存在' });
    return { scanned, skipped, passed, failed, issues, orphanFiles };
  }

  const allBatches = await listBatches(outputBasePath);
  const activeBatchIds = new Set<string>();
  const referencedFiles = new Set<string>();

  for (const batch of allBatches) {
    const isLocked = batch.lock?.locked || false;
    const isRunning = batch.status === 'running';

    if (isLocked || isRunning) {
      skipped++;
      issues.push({
        level: 'info',
        batchId: batch.batchId,
        message: '跳过锁定/运行中的批次',
        detail: `状态: ${batch.status}, 锁定: ${isLocked}`
      });
      continue;
    }

    scanned++;
    activeBatchIds.add(batch.batchId);

    const batchIssues = await validateBatch(batch, outputBasePath);
    issues.push(...batchIssues);

    for (const action of batch.actions) {
      if (action.status === 'success' && action.targetPath) {
        referencedFiles.add(path.normalize(action.targetPath));
      }
    }

    if (batchIssues.length === 0) {
      passed++;
    } else {
      failed++;
    }
  }

  const backupIssues = await validateBackups(backupDir, activeBatchIds);
  issues.push(...backupIssues);

  if (await fs.pathExists(archiveDir)) {
    const archiveOrphans = await findOrphanFiles(archiveDir, referencedFiles);
    orphanFiles.push(...archiveOrphans);
    
    if (orphanFiles.length > 0) {
      issues.push({
        level: 'warning',
        message: `发现 ${orphanFiles.length} 个孤儿文件`,
        detail: orphanFiles.join('\n')
      });
    }
  }

  return { scanned, skipped, passed, failed, issues, orphanFiles };
}

async function validateBatch(batch: BatchStatus, outputBasePath: string): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  const archiveFiles: string[] = [];
  for (const action of batch.actions) {
    if (action.status === 'success' && action.targetPath) {
      const fullPath = path.join(outputBasePath, 'archive', path.relative(path.join(outputBasePath, 'archive'), action.targetPath));
      if (await fs.pathExists(action.targetPath)) {
        archiveFiles.push(action.targetPath);
      } else {
        issues.push({
          level: 'error',
          batchId: batch.batchId,
          message: '归档文件缺失',
          detail: action.targetPath
        });
      }
    }
  }

  if (archiveFiles.length !== batch.successCount) {
    issues.push({
      level: 'error',
      batchId: batch.batchId,
      message: '文件数量不匹配',
      detail: `status.json 记录成功数: ${batch.successCount}, archive 实际文件数: ${archiveFiles.length}`
    });
  }

  if (batch.status === 'completed' && batch.failedCount > 0 && batch.errors.length === 0) {
    issues.push({
      level: 'warning',
      batchId: batch.batchId,
      message: '存在失败记录但无错误信息'
    });
  }

  return issues;
}

async function validateBackups(backupDir: string, activeBatchIds: Set<string>): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  if (!await fs.pathExists(backupDir)) {
    return issues;
  }

  const backupBatches = await fs.readdir(backupDir);
  
  for (const batchId of backupBatches) {
    const batchBackupDir = path.join(backupDir, batchId);
    const stats = await fs.stat(batchBackupDir);
    
    if (!stats.isDirectory()) continue;

    const integrityPath = path.join(batchBackupDir, 'integrity.json');
    if (!await fs.pathExists(integrityPath)) {
      issues.push({
        level: 'warning',
        batchId,
        message: '备份目录缺少 integrity.json'
      });
      continue;
    }

    const integrityContent = await fs.readFile(integrityPath, 'utf-8');
    let integrity: IntegrityRecord;
    try {
      integrity = JSON.parse(integrityContent);
    } catch {
      issues.push({
        level: 'error',
        batchId,
        message: 'integrity.json 格式错误'
      });
      continue;
    }

    for (const entry of integrity.files) {
      const filePath = path.join(batchBackupDir, entry.fileName);
      if (!await fs.pathExists(filePath)) {
        issues.push({
          level: 'error',
          batchId,
          message: '备份文件缺失',
          detail: entry.fileName
        });
      }
    }

    if (!activeBatchIds.has(batchId)) {
      issues.push({
        level: 'warning',
        batchId,
        message: '备份文件对应的批次不存在于 batches 目录'
      });
    }
  }

  return issues;
}

async function findOrphanFiles(archiveDir: string, referencedFiles: Set<string>): Promise<string[]> {
  const orphans: string[] = [];

  async function scanDir(dir: string): Promise<void> {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        await scanDir(fullPath);
      } else if (stats.isFile()) {
        const normalizedPath = path.normalize(fullPath);
        if (!referencedFiles.has(normalizedPath)) {
          orphans.push(normalizedPath);
        }
      }
    }
  }

  await scanDir(archiveDir);
  return orphans;
}

export function formatScanResult(result: ScanResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('┌─────────────────────────────────────────────────────────────┐');
  lines.push('│                    工作区健康检查报告                       │');
  lines.push('└─────────────────────────────────────────────────────────────┘');
  lines.push('');

  lines.push('┌──────────┬──────────┬──────────┬──────────┐');
  lines.push('│ 已扫描   │ 已跳过   │ 通过     │ 失败     │');
  lines.push('├──────────┼──────────┼──────────┼──────────┤');
  lines.push(`│ ${result.scanned.toString().padStart(6)}  │ ${result.skipped.toString().padStart(6)}  │ ${result.passed.toString().padStart(6)}  │ ${result.failed.toString().padStart(6)}  │`);
  lines.push('└──────────┴──────────┴──────────┴──────────┘');

  if (result.orphanFiles.length > 0) {
    lines.push('');
    lines.push('╔═══════════════════════════════════════════════════════════╗');
    lines.push('║                     孤儿文件 (未被引用)                   ║');
    lines.push('╚═══════════════════════════════════════════════════════════╝');
    for (const orphan of result.orphanFiles) {
      lines.push(`  ├── ${orphan}`);
    }
  }

  const errorIssues = result.issues.filter(i => i.level === 'error');
  const warningIssues = result.issues.filter(i => i.level === 'warning');
  const infoIssues = result.issues.filter(i => i.level === 'info');

  if (errorIssues.length > 0) {
    lines.push('');
    lines.push('╔═══════════════════════════════════════════════════════════╗');
    lines.push('║                        错误 (ERROR)                      ║');
    lines.push('╚═══════════════════════════════════════════════════════════╝');
    for (const issue of errorIssues) {
      lines.push(`  ${issue.batchId ? `[${issue.batchId}]` : '[全局]'} ${issue.message}`);
      if (issue.detail) {
        lines.push(`       └─ ${issue.detail}`);
      }
    }
  }

  if (warningIssues.length > 0) {
    lines.push('');
    lines.push('╔═══════════════════════════════════════════════════════════╗');
    lines.push('║                      警告 (WARNING)                      ║');
    lines.push('╚═══════════════════════════════════════════════════════════╝');
    for (const issue of warningIssues) {
      lines.push(`  ${issue.batchId ? `[${issue.batchId}]` : '[全局]'} ${issue.message}`);
      if (issue.detail) {
        lines.push(`       └─ ${issue.detail}`);
      }
    }
  }

  if (infoIssues.length > 0) {
    lines.push('');
    lines.push('╔═══════════════════════════════════════════════════════════╗');
    lines.push('║                        信息 (INFO)                       ║');
    lines.push('╚═══════════════════════════════════════════════════════════╝');
    for (const issue of infoIssues) {
      lines.push(`  ${issue.batchId ? `[${issue.batchId}]` : '[全局]'} ${issue.message}`);
      if (issue.detail) {
        lines.push(`       └─ ${issue.detail}`);
      }
    }
  }

  lines.push('');
  const overallStatus = result.failed === 0 ? '✅ 检查通过' : '❌ 检查失败';
  lines.push(`结果: ${overallStatus} (扫描: ${result.scanned}, 跳过: ${result.skipped}, 通过: ${result.passed}, 失败: ${result.failed})`);
  lines.push('');

  return lines.join('\n');
}

export function formatScanResultJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}