import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { OperationLogEntry, BatchStatus } from '../types';

export interface ReportOptions {
  from?: string;
  to?: string;
  building?: string;
  json?: boolean;
}

export interface DailyStats {
  date: string;
  operations: Record<string, number>;
  totalPhotos: number;
  successPhotos: number;
  failedPhotos: number;
  batches: number;
  avgBatchSize: number;
}

export interface BuildingCoverage {
  building: string;
  floors: Record<string, number>;
  totalPoints: number;
  coveredPoints: number;
}

export interface ReportSummary {
  startDate: string;
  endDate: string;
  totalDays: number;
  totalOperations: number;
  operationBreakdown: Record<string, number>;
  totalPhotos: number;
  successRate: number;
  totalBatches: number;
  avgBatchSize: number;
  buildingCoverage: BuildingCoverage[];
  dailyStats: DailyStats[];
  warnings: string[];
  skippedLockedBatches: string[];
}

export interface ReportResult {
  summary: ReportSummary;
  details: {
    logs: OperationLogEntry[];
    batches: BatchStatus[];
  };
}

export async function generateReport(
  outputBasePath: string,
  options: ReportOptions
): Promise<ReportResult> {
  const warnings: string[] = [];
  const skippedLockedBatches: string[] = [];

  const fromDate = options.from
    ? DateTime.fromISO(options.from)
    : DateTime.fromISO('2000-01-01');
  const toDate = options.to
    ? DateTime.fromISO(options.to)
    : DateTime.now();

  const logs = await readLogsWithValidation(outputBasePath, warnings);
  const batches = await readBatchesWithValidation(outputBasePath, warnings, skippedLockedBatches);

  const filteredLogs = logs.filter(log => {
    const logTime = DateTime.fromISO(log.timestamp);
    return logTime >= fromDate && logTime <= toDate;
  });

  const filteredBatches = batches.filter(batch => {
    const batchTime = DateTime.fromISO(batch.createdAt);
    const inTimeRange = batchTime >= fromDate && batchTime <= toDate;
    if (!inTimeRange) return false;

    if (options.building) {
      const actionsMatch = batch.actions.some(action => 
        action.targetPath.includes(options.building!)
      );
      return actionsMatch;
    }
    return true;
  });

  const dailyStats = calculateDailyStats(filteredLogs, filteredBatches);
  const buildingCoverage = calculateBuildingCoverage(outputBasePath, options.building);
  
  const totalOperations = filteredLogs.length;
  const operationBreakdown = filteredLogs.reduce((acc, log) => {
    acc[log.command] = (acc[log.command] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalPhotos = filteredBatches.reduce((sum, b) => sum + b.totalPhotos, 0);
  const successPhotos = filteredBatches.reduce((sum, b) => sum + b.successCount, 0);
  const successRate = totalPhotos > 0 ? (successPhotos / totalPhotos) * 100 : 0;
  const totalBatches = filteredBatches.length;
  const avgBatchSize = totalBatches > 0 ? totalPhotos / totalBatches : 0;

  const summary: ReportSummary = {
    startDate: fromDate.toFormat('yyyy-MM-dd'),
    endDate: toDate.toFormat('yyyy-MM-dd'),
    totalDays: dailyStats.length,
    totalOperations,
    operationBreakdown,
    totalPhotos,
    successRate: Math.round(successRate * 100) / 100,
    totalBatches,
    avgBatchSize: Math.round(avgBatchSize * 100) / 100,
    buildingCoverage,
    dailyStats,
    warnings,
    skippedLockedBatches,
  };

  return {
    summary,
    details: {
      logs: filteredLogs,
      batches: filteredBatches,
    },
  };
}

async function readLogsWithValidation(
  outputBasePath: string,
  warnings: string[]
): Promise<OperationLogEntry[]> {
  const logPath = path.join(outputBasePath, 'ops.log.jsonl');
  
  if (!await fs.pathExists(logPath)) {
    return [];
  }

  const content = await fs.readFile(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  const logs: OperationLogEntry[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.timestamp && entry.command) {
        logs.push(entry);
      } else {
        warnings.push(`日志行 ${i + 1} 格式不正确，已跳过`);
      }
    } catch {
      warnings.push(`日志行 ${i + 1} 解析失败，已跳过`);
    }
  }
  
  return logs.sort((a, b) => 
    DateTime.fromISO(a.timestamp).toMillis() - DateTime.fromISO(b.timestamp).toMillis()
  );
}

async function readBatchesWithValidation(
  outputBasePath: string,
  warnings: string[],
  skippedLockedBatches: string[]
): Promise<BatchStatus[]> {
  const batchesDir = path.join(outputBasePath, 'batches');
  
  if (!await fs.pathExists(batchesDir)) {
    return [];
  }

  const batchIds = await fs.readdir(batchesDir);
  const batches: BatchStatus[] = [];

  for (const batchId of batchIds) {
    const statusPath = path.join(batchesDir, batchId, 'status.json');
    
    if (!await fs.pathExists(statusPath)) {
      warnings.push(`批次 ${batchId} 缺少 status.json，已跳过`);
      continue;
    }

    try {
      const content = await fs.readFile(statusPath, 'utf-8');
      const status = JSON.parse(content) as BatchStatus;
      
      if (status.lock?.locked) {
        skippedLockedBatches.push(batchId);
        continue;
      }

      batches.push(status);
    } catch {
      warnings.push(`批次 ${batchId} 的 status.json 解析失败，已跳过`);
    }
  }

  return batches.sort((a, b) => 
    DateTime.fromISO(a.createdAt).toMillis() - DateTime.fromISO(b.createdAt).toMillis()
  );
}

function calculateDailyStats(
  logs: OperationLogEntry[],
  batches: BatchStatus[]
): DailyStats[] {
  const dailyMap = new Map<string, DailyStats>();

  for (const log of logs) {
    const date = DateTime.fromISO(log.timestamp).toFormat('yyyy-MM-dd');
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        operations: {},
        totalPhotos: 0,
        successPhotos: 0,
        failedPhotos: 0,
        batches: 0,
        avgBatchSize: 0,
      });
    }
    const stats = dailyMap.get(date)!;
    stats.operations[log.command] = (stats.operations[log.command] || 0) + 1;
  }

  for (const batch of batches) {
    const date = DateTime.fromISO(batch.createdAt).toFormat('yyyy-MM-dd');
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        operations: {},
        totalPhotos: 0,
        successPhotos: 0,
        failedPhotos: 0,
        batches: 0,
        avgBatchSize: 0,
      });
    }
    const stats = dailyMap.get(date)!;
    stats.totalPhotos += batch.totalPhotos;
    stats.successPhotos += batch.successCount;
    stats.failedPhotos += batch.failedCount;
    stats.batches++;
  }

  const dailyStats = Array.from(dailyMap.values());
  dailyStats.forEach(stats => {
    stats.avgBatchSize = stats.batches > 0 ? stats.totalPhotos / stats.batches : 0;
    stats.avgBatchSize = Math.round(stats.avgBatchSize * 100) / 100;
  });

  return dailyStats.sort((a, b) => a.date.localeCompare(b.date));
}

function calculateBuildingCoverage(
  outputBasePath: string,
  buildingFilter?: string
): BuildingCoverage[] {
  const archiveDir = path.join(outputBasePath, 'archive');
  
  if (!fs.pathExistsSync(archiveDir)) {
    return [];
  }

  const coverage: BuildingCoverage[] = [];
  
  try {
    const buildings = fs.readdirSync(archiveDir);
    
    for (const building of buildings) {
      if (buildingFilter && !building.includes(buildingFilter)) {
        continue;
      }

      const buildingPath = path.join(archiveDir, building);
      if (!fs.statSync(buildingPath).isDirectory()) continue;

      const floors: Record<string, number> = {};
      let totalPoints = 0;
      let coveredPoints = 0;

      const floorDirs = fs.readdirSync(buildingPath);
      for (const floorDir of floorDirs) {
        const floorPath = path.join(buildingPath, floorDir);
        if (!fs.statSync(floorPath).isDirectory()) continue;

        const floorName = floorDir.split('-')[0];
        const pointDirs = fs.readdirSync(floorPath);
        const pointCount = pointDirs.filter(p => 
          fs.statSync(path.join(floorPath, p)).isDirectory()
        ).length;
        
        floors[floorName] = (floors[floorName] || 0) + pointCount;
        totalPoints += pointCount;
        coveredPoints += pointDirs.length;
      }

      coverage.push({
        building,
        floors,
        totalPoints,
        coveredPoints,
      });
    }
  } catch {
    // Ignore errors
  }

  return coverage;
}

export function formatReportSummary(summary: ReportSummary): string {
  const lines: string[] = [];

  lines.push('╔════════════════════════════════════════════════════════════════════════╗');
  lines.push('║                        巡检照片归档统计报告                            ║');
  lines.push('╚════════════════════════════════════════════════════════════════════════╝');
  
  lines.push(`\n📅 时间范围: ${summary.startDate} ~ ${summary.endDate}`);
  lines.push(`📊 统计天数: ${summary.totalDays} 天`);
  
  lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('                          操作统计                                      ');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  lines.push(`总操作次数: ${summary.totalOperations}`);
  if (Object.keys(summary.operationBreakdown).length > 0) {
    lines.push('操作类型分布:');
    for (const [cmd, count] of Object.entries(summary.operationBreakdown)) {
      lines.push(`  ${cmd.padEnd(15)}: ${count} 次`);
    }
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('                          批次统计                                      ');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  lines.push(`总批次数: ${summary.totalBatches}`);
  lines.push(`总照片数: ${summary.totalPhotos}`);
  lines.push(`平均批次规模: ${summary.avgBatchSize.toFixed(2)} 张/批`);
  lines.push(`成功率: ${summary.successRate.toFixed(2)}%`);

  if (summary.buildingCoverage.length > 0) {
    lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('                          楼栋覆盖                                      ');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    for (const bc of summary.buildingCoverage) {
      lines.push(`\n🏢 ${bc.building}`);
      for (const [floor, count] of Object.entries(bc.floors)) {
        lines.push(`  ${floor.padEnd(6)}: ${count} 个点位`);
      }
    }
  }

  if (summary.dailyStats.length > 0) {
    lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('                          每日统计                                      ');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    lines.push('┌─────────────┬────────────┬────────────┬────────────┬─────────────┐');
    lines.push('│    日期     │ 批次数     │ 照片数     │ 成功数     │ 平均规模    │');
    lines.push('├─────────────┼────────────┼────────────┼────────────┼─────────────┤');
    
    for (const day of summary.dailyStats) {
      lines.push(
        `│ ${day.date.padEnd(11)} │ ${String(day.batches).padEnd(10)} │ ${String(day.totalPhotos).padEnd(10)} │ ${String(day.successPhotos).padEnd(10)} │ ${day.avgBatchSize.toFixed(2).padEnd(11)} │`
      );
    }
    
    lines.push('└─────────────┴────────────┴────────────┴────────────┴─────────────┘');
  }

  if (summary.warnings.length > 0) {
    lines.push('\n⚠️ 警告:');
    for (const warning of summary.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  if (summary.skippedLockedBatches.length > 0) {
    lines.push('\n⏭️ 跳过的锁定批次:');
    lines.push(`  ${summary.skippedLockedBatches.join(', ')}`);
  }

  return lines.join('\n');
}

export function formatReportJson(result: ReportResult): string {
  return JSON.stringify(result, null, 2);
}