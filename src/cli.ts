#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs-extra';
import * as path from 'path';
import { loadConfig } from './config/loader';
import { performDryRun, formatDryRunReport } from './core/dryRun';
import { executeArchive, listBatches, loadBatchStatus, verifyIntegrity } from './core/archive';
import { rollbackBatch, mergeRetryBatch } from './core/rollback';
import { exportBatchRecords } from './core/export';
import { purgeOldBatches } from './core/purge';
import { 
  initProfile, 
  listProfilesWithDetails, 
  switchProfile, 
  deleteProfile,
  loadProfile,
  showProfile
} from './core/profile';
import { compareBatches, exportDiffResult, formatDiffReport } from './core/diff';
import { 
  appendLog, 
  readLogs, 
  clearLogs, 
  formatLogsTable, 
  createLogEntry 
} from './core/operationLog';
import { importBatches, getImportPreview, validateExportFile } from './core/import';
import { scanWorkspace, formatScanResult, formatScanResultJson } from './core/scan';
import { 
  generateReport, 
  formatReportSummary, 
  formatReportJson,
  ReportResult 
} from './core/report';
import { validateArchive, formatValidationResult, formatValidationResultJson } from './core/validate';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import * as scheduleStorage from './core/scheduleStorage';
import * as scheduler from './core/scheduler';

const program = new Command();

program
  .name('pi-archiver')
  .description('物业巡检照片归档 CLI 工具')
  .version('1.0.0');

function sanitizeParams(options: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else {
      sanitized[key] = String(value);
    }
  }
  return sanitized;
}

async function withLogging<T>(
  outputBasePath: string | undefined,
  commandName: string,
  params: Record<string, unknown>,
  action: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();
  let exitCode = 0;
  let errorMessage: string | undefined;

  try {
    const result = await action();
    return result;
  } catch (error) {
    exitCode = 1;
    errorMessage = (error as Error).message;
    throw error;
  } finally {
    if (outputBasePath) {
      const durationMs = Date.now() - startTime;
      const entry = createLogEntry(commandName, params, exitCode, durationMs, errorMessage);
      try {
        await appendLog(outputBasePath, entry);
      } catch {
        // Ignore logging errors
      }
    }
  }
}

program
  .command('dry-run')
  .description('执行 dry-run 检测')
  .requiredOption('-i, --input <dir>', '照片输入目录')
  .requiredOption('-p, --points <file>', '点位配置文件路径')
  .requiredOption('-n, --naming <file>', '命名规则文件路径')
  .requiredOption('-l, --list <file>', '巡检清单 CSV 路径')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('-w, --window <minutes>', '时间窗口（分钟）', '60')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'dry-run', sanitizeParams(options), async () => {
        const config = await loadConfig({
          pointConfigPath: options.points,
          namingRulePath: options.naming,
          inspectionListPath: options.list,
          outputBasePath: options.output,
          timeWindowMinutes: Number(options.window),
          createOutputDir: false,
        });

        const result = await performDryRun(options.input, config);
        console.log(formatDryRunReport(result));
      });
    } catch (error) {
      console.error(`❌ 错误: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('archive')
  .description('执行归档')
  .requiredOption('-i, --input <dir>', '照片输入目录')
  .requiredOption('-p, --points <file>', '点位配置文件路径')
  .requiredOption('-n, --naming <file>', '命名规则文件路径')
  .requiredOption('-l, --list <file>', '巡检清单 CSV 路径')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('-w, --window <minutes>', '时间窗口（分钟）', '60')
  .option('-f, --format <format>', '归档格式 directory|zip', 'directory')
  .option('--confirm', '是否需要确认', true)
  .action(async (options) => {
    try {
      await withLogging(options.output, 'archive', sanitizeParams(options), async () => {
        const config = await loadConfig({
          pointConfigPath: options.points,
          namingRulePath: options.naming,
          inspectionListPath: options.list,
          outputBasePath: options.output,
          timeWindowMinutes: Number(options.window),
          archiveFormat: options.format as 'directory' | 'zip',
          createOutputDir: true,
        });

        const dryRunResult = await performDryRun(options.input, config);
        console.log(formatDryRunReport(dryRunResult));

        const hasBlockingErrors = dryRunResult.missingPoints.length > 0 ||
                                  dryRunResult.directoryConflicts.length > 0 ||
                                  dryRunResult.duplicateTargets.length > 0;

        if (hasBlockingErrors) {
          console.error('❌ 存在阻止归档的错误，终止执行');
          process.exit(1);
        }

        const confirm = String(options.confirm).toLowerCase() !== 'false';
        if (confirm) {
          console.log('\n⚠️ 即将执行归档操作，请确认 (y/N):');
          process.stdin.setEncoding('utf-8');
          await new Promise<void>((resolve) => {
            process.stdin.once('data', (data) => {
              const answer = data.toString().trim().toLowerCase();
              if (answer !== 'y' && answer !== 'yes') {
                console.log('操作已取消');
                process.exit(0);
              }
              resolve();
            });
          });
        }

        console.log('\n🚀 开始归档...');
        const status = await executeArchive(options.input, config, dryRunResult);

        console.log(`\n✅ 归档完成`);
        console.log(`批次ID: ${status.batchId}`);
        console.log(`状态: ${status.status}`);
        console.log(`成功: ${status.successCount} / 失败: ${status.failedCount}`);

        if (status.errors.length > 0) {
          console.log('\n❌ 错误列表:');
          status.errors.forEach(err => console.log(`  - ${err}`));
        }
      });
    } catch (error) {
      console.error(`❌ 归档失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('查看批次状态')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('-b, --batch <id>', '指定批次ID')
  .option('--verify', '校验备份文件完整性')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'status', sanitizeParams(options), async () => {
        if (options.batch) {
          const status = await loadBatchStatus(options.batch, options.output);
          if (!status) {
            console.log(`批次 ${options.batch} 不存在`);
            return;
          }

          const createdAt = DateTime.fromISO(status.createdAt).toFormat('yyyy-MM-dd HH:mm:ss');
          const completedAt = status.completedAt ? DateTime.fromISO(status.completedAt).toFormat('yyyy-MM-dd HH:mm:ss') : '未完成';
          
          console.log(`批次ID: ${status.batchId}`);
          console.log(`状态: ${status.status}`);
          console.log(`锁定状态: ${status.lock?.locked ? '已锁定' : '未锁定'}`);
          console.log(`创建时间: ${createdAt}`);
          console.log(`完成时间: ${completedAt}`);
          console.log(`照片数: ${status.totalPhotos} (成功: ${status.successCount}, 失败: ${status.failedCount})`);

          if (options.verify) {
            const backupPath = path.join(options.output, '.backup');
            const integrity = await verifyIntegrity(status.batchId, backupPath);
            if (integrity.errors.length > 0) {
              console.log('\n❌ 备份完整性校验失败:');
              integrity.errors.forEach(err => console.log(`  - ${err}`));
            } else {
              console.log('\n✅ 备份完整性校验通过');
            }
          }

          if (status.errors.length > 0) {
            console.log('\n错误列表:');
            status.errors.forEach(err => console.log(`  - ${err}`));
          }
        } else {
          const batches = await listBatches(options.output);
          if (batches.length === 0) {
            console.log('暂无批次记录');
            return;
          }

          console.log(`\n=== 批次列表 (共 ${batches.length} 个) ===\n`);
          for (const batch of batches) {
            const createdAt = DateTime.fromISO(batch.createdAt).toFormat('yyyy-MM-dd HH:mm:ss');
            console.log(`批次ID: ${batch.batchId}`);
            console.log(`状态: ${batch.status}`);
            console.log(`锁定状态: ${batch.lock?.locked ? '已锁定' : '未锁定'}`);
            console.log(`创建时间: ${createdAt}`);
            console.log(`照片数: ${batch.totalPhotos} (成功: ${batch.successCount}, 失败: ${batch.failedCount})`);
            console.log('---');
          }
        }
      });
    } catch (error) {
      console.error(`❌ 错误: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('rollback')
  .description('回滚批次')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-b, --batch <id>', '要回滚的批次ID')
  .option('--confirm', '是否需要确认', true)
  .action(async (options) => {
    try {
      await withLogging(options.output, 'rollback', sanitizeParams(options), async () => {
        const confirm = String(options.confirm).toLowerCase() !== 'false';
        if (confirm) {
          console.log(`⚠️ 即将回滚批次 ${options.batch}，此操作将删除归档文件，请确认 (y/N):`);
          process.stdin.setEncoding('utf-8');
          await new Promise<void>((resolve) => {
            process.stdin.once('data', (data) => {
              const answer = data.toString().trim().toLowerCase();
              if (answer !== 'y' && answer !== 'yes') {
                console.log('操作已取消');
                process.exit(0);
              }
              resolve();
            });
          });
        }

        const result = await rollbackBatch(options.batch, options.output);
        console.log(result.message);

        if (result.errors.length > 0) {
          console.log('\n❌ 错误列表:');
          result.errors.forEach(err => console.log(`  - ${err}`));
        }

        if (!result.success) {
          process.exit(1);
        }
      });
    } catch (error) {
      console.error(`❌ 回滚失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('merge')
  .description('合并补拍批次到目标批次')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-s, --source <id>', '补拍批次ID')
  .requiredOption('-t, --target <id>', '目标批次ID')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'merge', sanitizeParams(options), async () => {
        const result = await mergeRetryBatch(options.source, options.target, options.output);
        console.log(result.message);

        if (result.errors.length > 0) {
          console.log('\n❌ 错误列表:');
          result.errors.forEach(err => console.log(`  - ${err}`));
        }

        if (!result.success) {
          process.exit(1);
        }
      });
    } catch (error) {
      console.error(`❌ 合并失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('导出批次记录')
  .requiredOption('-o, --output <dir>', '输出目录')
  .requiredOption('-b, --base <dir>', '归档基础目录')
  .option('-f, --format <format>', '导出格式 json|csv', 'json')
  .option('-i, --batch <id>', '指定批次ID（不指定则导出所有）')
  .option('--verify', '校验备份文件完整性')
  .action(async (options) => {
    try {
      await withLogging(options.base, 'export', sanitizeParams(options), async () => {
        const timestamp = DateTime.now().toFormat('yyyyMMdd-HHmmss');
        const ext = options.format === 'csv' ? 'csv' : 'json';
        const fileName = options.batch 
          ? `${options.batch}.${ext}` 
          : `all_batches_${timestamp}.${ext}`;
        const outputPath = path.join(options.output, fileName);

        if (options.verify) {
          const batches = options.batch 
            ? [options.batch] 
            : (await listBatches(options.base)).map(b => b.batchId);
          
          const backupPath = path.join(options.base, '.backup');
          let allValid = true;
          
          console.log('\n=== 备份完整性校验 ===\n');
          for (const batchId of batches) {
            const integrity = await verifyIntegrity(batchId, backupPath);
            if (integrity.errors.length > 0) {
              allValid = false;
              console.log(`批次 ${batchId}: ❌ 校验失败`);
              integrity.errors.forEach(err => console.log(`  - ${err}`));
            } else {
              console.log(`批次 ${batchId}: ✅ 校验通过`);
            }
          }
          
          if (!allValid) {
            console.log('\n❌ 存在校验失败的批次');
            process.exit(1);
          }
        }

        const message = await exportBatchRecords(
          outputPath,
          options.format as 'json' | 'csv',
          options.base,
          options.batch
        );

        console.log(`✅ ${message}: ${outputPath}`);
      });
    } catch (error) {
      console.error(`❌ 导出失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('purge')
  .description('清理过期的批次和备份')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--keep-days <days>', '保留指定天数内的批次')
  .option('--keep-recent <count>', '保留最近N个批次')
  .option('--confirm', '是否需要确认', true)
  .action(async (options) => {
    try {
      await withLogging(options.output, 'purge', sanitizeParams(options), async () => {
        const keepDays = options.keepDays ? Number(options.keepDays) : undefined;
        const keepRecent = options.keepRecent ? Number(options.keepRecent) : undefined;

        if (keepDays === undefined && keepRecent === undefined) {
          console.error('❌ 必须指定 --keep-days 或 --keep-recent');
          process.exit(1);
        }

        const batches = await listBatches(options.output);
        console.log(`当前共有 ${batches.length} 个批次`);

        const confirm = String(options.confirm).toLowerCase() !== 'false';
        if (confirm) {
          console.log(`\n⚠️ 即将清理过期批次，请确认 (y/N):`);
          process.stdin.setEncoding('utf-8');
          await new Promise<void>((resolve) => {
            process.stdin.once('data', (data) => {
              const answer = data.toString().trim().toLowerCase();
              if (answer !== 'y' && answer !== 'yes') {
                console.log('操作已取消');
                process.exit(0);
              }
              resolve();
            });
          });
        }

        const result = await purgeOldBatches(options.output, keepDays, keepRecent);
        console.log(`\n${result.message}`);

        if (result.deletedBatches.length > 0) {
          console.log('\n已删除批次:');
          result.deletedBatches.forEach(id => console.log(`  - ${id}`));
        }

        if (result.skippedBatches.length > 0) {
          console.log('\n跳过的锁定/运行中批次:');
          result.skippedBatches.forEach(id => console.log(`  - ${id}`));
        }

        if (result.errors.length > 0) {
          console.log('\n❌ 错误列表:');
          result.errors.forEach(err => console.log(`  - ${err}`));
          process.exit(1);
        }
      });
    } catch (error) {
      console.error(`❌ 清理失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

const profileCommand = program
  .command('profile')
  .description('管理配置 profile');

profileCommand
  .command('init')
  .description('创建新的配置 profile')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-n, --name <name>', 'Profile 名称')
  .requiredOption('-p, --points <file>', '点位配置文件路径')
  .requiredOption('-r, --naming <file>', '命名规则文件路径')
  .option('-w, --window <minutes>', '时间窗口（分钟）', '60')
  .option('--dry-run', '预览模式，不实际创建')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'profile-init', sanitizeParams(options), async () => {
        const pointsContent = await fs.readFile(options.points, 'utf-8');
        const pointsData = JSON.parse(pointsContent);
        const points = pointsData.points || pointsData;
        
        const namingContent = await fs.readFile(options.naming, 'utf-8');
        const namingRule = JSON.parse(namingContent);
        
        const result = await initProfile(
          options.output,
          options.name,
          {
            points,
            namingRule,
            timeWindowMinutes: Number(options.window),
          },
          options.dryRun
        );
        
        if (!result.success) {
          console.error(`❌ ${result.message}`);
          process.exit(1);
        }
        
        console.log(`✅ ${result.message}`);
        if (result.profile) {
          console.log(`   点位数: ${result.profile.points.length}`);
          console.log(`   时间窗口: ${result.profile.timeWindowMinutes} 分钟`);
        }
      });
    } catch (error) {
      console.error(`❌ 创建 profile 失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

profileCommand
  .command('list')
  .description('列出所有配置 profile')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'profile-list', sanitizeParams(options), async () => {
        const profiles = await listProfilesWithDetails(options.output);
        
        if (profiles.length === 0) {
          console.log('暂无配置 profile');
          return;
        }
        
        console.log(`\n=== 配置 Profile 列表 (共 ${profiles.length} 个) ===\n`);
        for (const profile of profiles) {
          const createdAt = DateTime.fromISO(profile.createdAt).toFormat('yyyy-MM-dd HH:mm:ss');
          const activeMark = profile.isActive ? ' [当前激活]' : '';
          console.log(`名称: ${profile.name}${activeMark}`);
          console.log(`创建时间: ${createdAt}`);
          console.log(`点位数: ${profile.pointsCount}`);
          console.log('---');
        }
      });
    } catch (error) {
      console.error(`❌ 列出 profile 失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

profileCommand
  .command('switch')
  .description('切换到指定的配置 profile')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-n, --name <name>', 'Profile 名称')
  .option('--dry-run', '预览模式，不实际切换')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'profile-switch', sanitizeParams(options), async () => {
        const result = await switchProfile(options.output, options.name, options.dryRun);
        
        if (!result.success) {
          console.error(`❌ ${result.message}`);
          process.exit(1);
        }
        
        console.log(`✅ ${result.message}`);
        if (result.profile) {
          console.log(`   点位数: ${result.profile.points.length}`);
          console.log(`   时间窗口: ${result.profile.timeWindowMinutes} 分钟`);
        }
      });
    } catch (error) {
      console.error(`❌ 切换 profile 失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

profileCommand
  .command('delete')
  .description('删除指定的配置 profile')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-n, --name <name>', 'Profile 名称')
  .option('--dry-run', '预览模式，不实际删除')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'profile-delete', sanitizeParams(options), async () => {
        const result = await deleteProfile(options.output, options.name, options.dryRun);
        
        if (!result.success) {
          console.error(`❌ ${result.message}`);
          process.exit(1);
        }
        
        console.log(`✅ ${result.message}`);
      });
    } catch (error) {
      console.error(`❌ 删除 profile 失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

profileCommand
  .command('show')
  .description('显示当前激活的 profile 信息')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--json', '以 JSON 格式输出')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'profile-show', sanitizeParams(options), async () => {
        const result = await showProfile(options.output);
        
        if (!result.success) {
          console.error(`❌ ${result.message}`);
          process.exit(1);
        }
        
        if (options.json && result.result) {
          console.log(JSON.stringify(result.result, null, 2));
        } else if (result.result) {
          const createdAt = DateTime.fromISO(result.result.createdAt).toFormat('yyyy-MM-dd HH:mm:ss');
          console.log(`=== 当前激活的 Profile ===`);
          console.log(`名称: ${result.result.name}`);
          console.log(`存储位置: ${result.result.storagePath}`);
          console.log(`命名规则: ${result.result.namingPattern}`);
          console.log(`日期格式: ${result.result.dateFormat}`);
          console.log(`时间窗口: ${result.result.timeWindowMinutes} 分钟`);
          console.log(`点位数: ${result.result.pointsCount}`);
          console.log(`创建时间: ${createdAt}`);
        } else {
          console.log(result.message);
        }
      });
    } catch (error) {
      console.error(`❌ 显示 profile 失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('diff')
  .description('对比两个批次的差异')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-b1, --batch1 <id>', '第一个批次ID')
  .requiredOption('-b2, --batch2 <id>', '第二个批次ID')
  .option('-f, --format <format>', '导出格式 json|csv', 'json')
  .option('-e, --export <path>', '导出文件路径')
  .option('--dry-run', '预览模式，不保存结果')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'diff', sanitizeParams(options), async () => {
        const result = await compareBatches(
          options.output,
          options.batch1,
          options.batch2,
          options.dryRun
        );
        
        if (!result.success) {
          console.error(`❌ ${result.message}`);
          process.exit(1);
        }
        
        if (result.result) {
          console.log(formatDiffReport(result.result));
          
          if (options.export && !options.dryRun) {
            const exportMessage = await exportDiffResult(
              options.export,
              options.format as 'json' | 'csv',
              result.result
            );
            console.log(`\n✅ ${exportMessage}`);
          }
        }
      });
    } catch (error) {
      console.error(`❌ 对比失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('log')
  .description('查看操作日志')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--since <datetime>', '起始时间 (ISO格式)')
  .option('--until <datetime>', '结束时间 (ISO格式)')
  .option('-n <count>', '限制条数', '20')
  .option('--json', '以 JSON 格式输出')
  .option('--clear', '清空日志')
  .option('--task <taskId>', '按任务ID或任务名称过滤')
  .action(async (options) => {
    try {
      if (options.clear) {
        await clearLogs(options.output);
        console.log('✅ 日志已清空');
        return;
      }

      const logs = await readLogs(options.output, {
        since: options.since,
        until: options.until,
        limit: Number(options.n),
        taskId: options.task,
      });

      if (options.json) {
        console.log(JSON.stringify(logs, null, 2));
      } else {
        console.log(formatLogsTable(logs));
      }
    } catch (error) {
      console.error(`❌ 读取日志失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('import')
  .description('导入批次记录')
  .requiredOption('-i, --input <file>', '导出的 JSON 文件路径')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--conflict <strategy>', '冲突处理策略: skip|overwrite', 'skip')
  .option('--dry-run', '预览模式，不实际导入')
  .option('--verify', '导入后校验完整性')
  .action(async (options) => {
    try {
      if (options.conflict !== 'skip' && options.conflict !== 'overwrite') {
        console.error('❌ --conflict 必须是 skip 或 overwrite');
        process.exit(1);
      }

      const preview = await getImportPreview(options.input);
      
      if (!preview.valid) {
        console.error('❌ 导入文件校验失败:');
        preview.errors.forEach(err => console.error(`  - ${err}`));
        process.exit(1);
      }

      console.log(`\n=== 导入预览 ===`);
      console.log(`批次数量: ${preview.batchCount}`);
      console.log(`批次ID: ${preview.batchIds.join(', ')}`);
      if (preview.exportedAt) {
        console.log(`导出时间: ${DateTime.fromISO(preview.exportedAt).toFormat('yyyy-MM-dd HH:mm:ss')}`);
      }

      if (options.dryRun) {
        console.log(`\n[DRY-RUN] 将导入 ${preview.batchCount} 个批次`);
        return;
      }

      const result = await importBatches({
        inputPath: options.input,
        outputBasePath: options.output,
        conflictStrategy: options.conflict as 'skip' | 'overwrite',
        dryRun: false,
      });

      console.log(`\n${result.message}`);

      if (result.importedBatches.length > 0) {
        console.log('\n已导入批次:');
        result.importedBatches.forEach(id => console.log(`  - ${id}`));
      }

      if (result.skippedBatches.length > 0) {
        console.log('\n跳过的批次:');
        result.skippedBatches.forEach(id => console.log(`  - ${id}`));
      }

      if (result.errors.length > 0) {
        console.log('\n❌ 错误列表:');
        result.errors.forEach(err => console.log(`  - ${err}`));
        process.exit(1);
      }

      if (options.verify) {
        const backupPath = path.join(options.output, '.backup');
        console.log('\n=== 完整性校验 ===');
        for (const batchId of result.importedBatches) {
          if (await fs.pathExists(path.join(backupPath, batchId))) {
            const integrity = await verifyIntegrity(batchId, backupPath);
            if (integrity.errors.length > 0) {
              console.log(`批次 ${batchId}: ❌ 校验失败`);
              integrity.errors.forEach(err => console.log(`  - ${err}`));
            } else {
              console.log(`批次 ${batchId}: ✅ 校验通过`);
            }
          } else {
            console.log(`批次 ${batchId}: ⚠️ 无备份文件跳过校验`);
          }
        }
      }

    } catch (error) {
      console.error(`❌ 导入失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('scan')
  .description('工作区健康检查')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--json', '以 JSON 格式输出')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'scan', sanitizeParams(options), async () => {
        const result = await scanWorkspace(options.output);
        
        if (options.json) {
          console.log(formatScanResultJson(result));
        } else {
          console.log(formatScanResult(result));
        }

        if (result.failed > 0) {
          process.exit(1);
        }
      });
    } catch (error) {
      console.error(`❌ 扫描失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('report')
  .description('生成统计报告')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--from <date>', '起始日期 (YYYY-MM-DD)')
  .option('--to <date>', '结束日期 (YYYY-MM-DD)')
  .option('--building <name>', '按楼栋过滤')
  .option('--json', '以 JSON 格式输出')
  .option('--detail', '显示详细日志')
  .option('--no-save', '不将统计摘要写回日志')
  .action(async (options) => {
    try {
      const result = await generateReport(options.output, {
        from: options.from,
        to: options.to,
        building: options.building,
        json: options.json,
      });

      if (options.json) {
        if (options.detail) {
          console.log(formatReportJson(result));
        } else {
          console.log(JSON.stringify(result.summary, null, 2));
        }
      } else {
        console.log(formatReportSummary(result.summary));
        
        if (options.detail) {
          console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('                          详细日志                                      ');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          
          if (result.details.logs.length > 0) {
            console.log(formatLogsTable(result.details.logs));
          } else {
            console.log('暂无操作日志');
          }
        }
      }

      if (!options.noSave && result.summary.totalOperations > 0) {
        const reportSummary = {
          reportGeneratedAt: DateTime.now().toISO(),
          timeRange: {
            from: result.summary.startDate,
            to: result.summary.endDate,
          },
          totalOperations: result.summary.totalOperations,
          totalBatches: result.summary.totalBatches,
          totalPhotos: result.summary.totalPhotos,
          successRate: result.summary.successRate,
          warnings: result.summary.warnings.length,
          skippedLockedBatches: result.summary.skippedLockedBatches.length,
        };
        
        const entry = createLogEntry('report', reportSummary, 0, 0);
        await appendLog(options.output, entry);
      }
    } catch (error) {
      console.error(`❌ 生成报告失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('校验归档完整性')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--building <name>', '按楼栋过滤')
  .option('--json', '以 JSON 格式输出')
  .option('--fix', '自动清理孤立文件')
  .action(async (options) => {
    try {
      await withLogging(options.output, 'validate', sanitizeParams(options), async () => {
        const result = await validateArchive(
          options.output,
          options.building,
          options.fix
        );

        if (options.json) {
          console.log(formatValidationResultJson(result));
        } else {
          console.log(formatValidationResult(result));
        }

        if (!result.valid && !options.fix) {
          process.exit(1);
        }
      });
    } catch (error) {
      console.error(`❌ 校验失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

const scheduleCommand = program
  .command('schedule')
  .description('管理定时调度任务');

scheduleCommand
  .command('list')
  .description('列出所有调度任务')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('--json', '以 JSON 格式输出')
  .option('--next-run', '显示下次运行时间')
  .action(async (options) => {
    try {
      const tasks = await scheduleStorage.listTasks(options.output);

      if (options.json) {
        const result = await Promise.all(tasks.map(async task => ({
          ...task,
          nextRunAt: options.nextRun && task.enabled ? 
            (await scheduler.getNextRunTimeForTask(task)).toISOString() : undefined,
        })));
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (tasks.length === 0) {
          console.log('暂无调度任务');
          return;
        }

        console.log(`\n=== 调度任务列表 (共 ${tasks.length} 个) ===\n`);
        for (const task of tasks) {
          const createdAt = DateTime.fromISO(task.createdAt).toFormat('yyyy-MM-dd HH:mm:ss');
          const lastRunAt = task.lastRunAt ? DateTime.fromISO(task.lastRunAt).toFormat('yyyy-MM-dd HH:mm:ss') : '从未运行';
          const nextRunAt = options.nextRun && task.enabled ? 
            DateTime.fromJSDate(await scheduler.getNextRunTimeForTask(task)).toFormat('yyyy-MM-dd HH:mm:ss') : '-';
          
          console.log(`任务ID: ${task.id}`);
          console.log(`名称: ${task.name}`);
          console.log(`状态: ${task.enabled ? '🟢 启用' : '🔴 禁用'}`);
          console.log(`Cron表达式: ${task.cronExpression}`);
          console.log(`命令: ${task.command} ${task.args.join(' ')}`);
          console.log(`创建时间: ${createdAt}`);
          console.log(`上次运行: ${lastRunAt}`);
          if (task.lastExitCode !== undefined) {
            console.log(`上次退出码: ${task.lastExitCode}`);
            console.log(`上次耗时: ${task.lastDurationMs}ms`);
          }
          if (options.nextRun) {
            console.log(`下次运行: ${nextRunAt}`);
          }
          if (task.description) {
            console.log(`描述: ${task.description}`);
          }
          console.log('---');
        }
      }
    } catch (error) {
      console.error(`❌ 列出任务失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('add')
  .description('添加新的调度任务')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-n, --name <name>', '任务名称')
  .requiredOption('-c, --cron <expression>', 'Cron表达式')
  .requiredOption('-cmd, --command <command>', '要执行的命令')
  .option('-a, --args <args>', '命令参数（逗号分隔）')
  .option('-d, --description <desc>', '任务描述')
  .option('--disabled', '创建时禁用')
  .action(async (options) => {
    try {
      if (!scheduler.isValidCronExpression(options.cron)) {
        console.error('❌ 无效的Cron表达式');
        process.exit(1);
      }

      const args = options.args ? options.args.split(',').map((s: string) => s.trim()) : [];

      const task = await scheduleStorage.addTask(options.output, {
        id: uuidv4(),
        name: options.name,
        cronExpression: options.cron,
        command: options.command,
        args,
        enabled: !options.disabled,
        description: options.description,
      });

      console.log(`✅ 任务创建成功`);
      console.log(`任务ID: ${task.id}`);
      console.log(`名称: ${task.name}`);
      console.log(`Cron表达式: ${task.cronExpression}`);
      console.log(`状态: ${task.enabled ? '启用' : '禁用'}`);
    } catch (error) {
      console.error(`❌ 添加任务失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('remove')
  .description('删除指定调度任务')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-i, --id <taskId>', '任务ID')
  .option('--dry-run', '预览模式，不实际删除')
  .action(async (options) => {
    try {
      if (options.dryRun) {
        const task = await scheduleStorage.getTaskById(options.output, options.id);
        if (!task) {
          console.log(`任务 ${options.id} 不存在`);
          return;
        }
        console.log(`[DRY-RUN] 将删除任务: ${task.name} (${task.id})`);
        return;
      }

      const success = await scheduleStorage.removeTask(options.output, options.id);
      
      if (success) {
        console.log(`✅ 任务 ${options.id} 删除成功`);
      } else {
        console.log(`❌ 任务 ${options.id} 不存在`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`❌ 删除任务失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('enable')
  .description('启用指定调度任务')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-i, --id <taskId>', '任务ID')
  .action(async (options) => {
    try {
      const success = await scheduleStorage.enableTask(options.output, options.id);
      
      if (success) {
        console.log(`✅ 任务 ${options.id} 已启用`);
        await scheduler.rescheduleTask(options.output, options.id);
      } else {
        console.log(`❌ 任务 ${options.id} 不存在`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`❌ 启用任务失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('disable')
  .description('禁用指定调度任务')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-i, --id <taskId>', '任务ID')
  .action(async (options) => {
    try {
      const success = await scheduleStorage.disableTask(options.output, options.id);
      
      if (success) {
        console.log(`✅ 任务 ${options.id} 已禁用`);
      } else {
        console.log(`❌ 任务 ${options.id} 不存在`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`❌ 禁用任务失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('run')
  .description('立即执行指定调度任务')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .requiredOption('-i, --id <taskId>', '任务ID')
  .option('-f, --force', '强制执行（忽略冲突）')
  .action(async (options) => {
    try {
      const task = await scheduleStorage.getTaskById(options.output, options.id);
      
      if (!task) {
        console.log(`❌ 任务 ${options.id} 不存在`);
        process.exit(1);
      }

      console.log(`🚀 开始执行任务: ${task.name}`);
      
      const result = await scheduler.runTask(options.output, task, options.force);
      
      if (result.conflictDetected) {
        console.log(`⚠️ 任务被跳过 - 检测到执行冲突（其他任务正在运行）`);
      } else if (result.status === 'completed') {
        console.log(`✅ 任务执行完成，退出码: ${result.exitCode}`);
        console.log(`耗时: ${result.durationMs}ms`);
      } else if (result.status === 'failed') {
        console.log(`❌ 任务执行失败，退出码: ${result.exitCode}`);
        if (result.errorMessage) {
          console.log(`错误信息: ${result.errorMessage}`);
        }
      }

      if (result.exitCode !== undefined && result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    } catch (error) {
      console.error(`❌ 执行任务失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('start')
  .description('启动调度器')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .action(async (options) => {
    try {
      if (scheduler.isSchedulerRunning()) {
        console.log('调度器已在运行中');
        return;
      }

      await scheduler.startScheduler(options.output);
      console.log('✅ 调度器已启动');
      
      const tasks = await scheduleStorage.listTasks(options.output);
      const enabledTasks = tasks.filter(t => t.enabled);
      console.log(`已调度 ${enabledTasks.length} 个任务`);
    } catch (error) {
      console.error(`❌ 启动调度器失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('stop')
  .description('停止调度器')
  .action(async () => {
    try {
      if (!scheduler.isSchedulerRunning()) {
        console.log('调度器未运行');
        return;
      }

      scheduler.stopScheduler();
      console.log('✅ 调度器已停止');
    } catch (error) {
      console.error(`❌ 停止调度器失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('next-run')
  .description('预览任务下次触发时间')
  .requiredOption('-o, --output <dir>', '输出基础目录')
  .option('-i, --id <taskId>', '指定任务ID（不指定则显示所有）')
  .option('--json', '以 JSON 格式输出')
  .action(async (options) => {
    try {
      const tasks = options.id 
        ? [await scheduleStorage.getTaskById(options.output, options.id)].filter(Boolean)
        : await scheduleStorage.listTasks(options.output);

      if (tasks.length === 0) {
        console.log('暂无任务');
        return;
      }

      const results = await Promise.all(tasks.map(async task => {
        if (!task || !task.enabled) {
          return {
            id: task?.id,
            name: task?.name,
            cronExpression: task?.cronExpression,
            nextRunAt: null,
            reason: task?.enabled ? '未知错误' : '任务已禁用',
          };
        }
        const nextRun = await scheduler.getNextRunTimeForTask(task);
        const now = new Date();
        const diffMs = nextRun.getTime() - now.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        
        return {
          id: task.id,
          name: task.name,
          cronExpression: task.cronExpression,
          nextRunAt: nextRun.toISOString(),
          nextRunAtFormatted: DateTime.fromJSDate(nextRun).toFormat('yyyy-MM-dd HH:mm:ss'),
          timeFromNow: diffMins < 60 
            ? `${diffMins} 分钟` 
            : `${Math.floor(diffMins / 60)} 小时 ${diffMins % 60} 分钟`,
        };
      }));

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`\n=== 下次运行时间预览 ===\n`);
        for (const result of results) {
          if (!result.nextRunAt) {
            console.log(`任务: ${result.name} (${result.id})`);
            console.log(`状态: ${result.reason}`);
          } else {
            console.log(`任务: ${result.name} (${result.id})`);
            console.log(`Cron: ${result.cronExpression}`);
            console.log(`下次运行: ${result.nextRunAtFormatted}`);
            console.log(`距离现在: ${result.timeFromNow}`);
          }
          console.log('---');
        }
      }
    } catch (error) {
      console.error(`❌ 获取下次运行时间失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
