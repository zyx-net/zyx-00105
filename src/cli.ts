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
  loadProfile 
} from './core/profile';
import { compareBatches, exportDiffResult, formatDiffReport } from './core/diff';
import { DateTime } from 'luxon';

const program = new Command();

program
  .name('pi-archiver')
  .description('物业巡检照片归档 CLI 工具')
  .version('1.0.0');

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
      const result = await mergeRetryBatch(options.source, options.target, options.output);
      console.log(result.message);

      if (result.errors.length > 0) {
        console.log('\n❌ 错误列表:');
        result.errors.forEach(err => console.log(`  - ${err}`));
      }

      if (!result.success) {
        process.exit(1);
      }

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
      const result = await deleteProfile(options.output, options.name, options.dryRun);
      
      if (!result.success) {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      
      console.log(`✅ ${result.message}`);
    } catch (error) {
      console.error(`❌ 删除 profile 失败: ${(error as Error).message}`);
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
    } catch (error) {
      console.error(`❌ 对比失败: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
