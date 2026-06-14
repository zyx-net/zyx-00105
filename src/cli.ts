#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs-extra';
import * as path from 'path';
import { loadConfig } from './config/loader';
import { performDryRun, formatDryRunReport } from './core/dryRun';
import { executeArchive, listBatches, loadBatchStatus } from './core/archive';
import { rollbackBatch, mergeRetryBatch } from './core/rollback';
import { exportBatchRecords } from './core/export';
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
  .action(async (options) => {
    try {
      if (options.batch) {
        const status = await loadBatchStatus(options.batch, options.output);
        if (!status) {
          console.log(`批次 ${options.batch} 不存在`);
          return;
        }
        console.log(JSON.stringify(status, null, 2));
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
  .action(async (options) => {
    try {
      const timestamp = DateTime.now().toFormat('yyyyMMdd-HHmmss');
      const ext = options.format === 'csv' ? 'csv' : 'json';
      const fileName = options.batch 
        ? `${options.batch}.${ext}` 
        : `all_batches_${timestamp}.${ext}`;
      const outputPath = path.join(options.output, fileName);

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

program.parse();
