import * as fs from 'fs-extra';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { PointConfig, NamingRule, InspectionItem, Config } from '../types';

export async function loadPointConfig(configPath: string): Promise<PointConfig[]> {
  if (!await fs.pathExists(configPath)) {
    throw new Error(`点位配置文件不存在: ${configPath}`);
  }
  const content = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(content);
  if (!Array.isArray(config.points)) {
    throw new Error('点位配置文件格式错误: 缺少 points 数组');
  }
  return config.points.map((p: any) => ({
    id: String(p.id),
    name: String(p.name),
    building: String(p.building),
    floor: String(p.floor),
    position: String(p.position),
    required: Boolean(p.required),
    description: p.description ? String(p.description) : undefined,
  }));
}

export async function loadNamingRule(configPath: string): Promise<NamingRule> {
  if (!await fs.pathExists(configPath)) {
    throw new Error(`命名规则文件不存在: ${configPath}`);
  }
  const content = await fs.readFile(configPath, 'utf-8');
  const rule = JSON.parse(content);
  return {
    pattern: String(rule.pattern || '{building}-{floor}-{position}-{round}-{date}'),
    dateFormat: String(rule.dateFormat || 'yyyyMMdd-HHmmss'),
    allowedExtensions: Array.isArray(rule.allowedExtensions) 
      ? rule.allowedExtensions.map(String) 
      : ['.jpg', '.jpeg', '.png', '.gif'],
    maxFileNameLength: Number(rule.maxFileNameLength || 100),
  };
}

export async function loadInspectionList(csvPath: string): Promise<InspectionItem[]> {
  if (!await fs.pathExists(csvPath)) {
    throw new Error(`巡检清单文件不存在: ${csvPath}`);
  }
  const content = await fs.readFile(csvPath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  });
  return records.map((r: any) => ({
    id: String(r.id || r.Id || r.ID),
    pointId: String(r.pointId || r.point_id || r.PointID || r.PointId),
    batchId: String(r.batchId || r.batch_id || r.BatchID || r.BatchId),
    round: Number(r.round || r.Round || 1),
    scheduledTime: String(r.scheduledTime || r.scheduled_time || r.ScheduledTime),
    status: (r.status || r.Status || 'pending') as 'pending' | 'completed' | 'rejected' | 'retry',
    rejectReason: r.rejectReason || r.reject_reason || r.RejectReason || undefined,
    retryCount: Number(r.retryCount || r.retry_count || r.RetryCount || 0),
  }));
}

export async function loadConfig(options: {
  pointConfigPath: string;
  namingRulePath: string;
  inspectionListPath: string;
  outputBasePath: string;
  archiveFormat?: 'directory' | 'zip';
  timeWindowMinutes?: number;
  createOutputDir?: boolean;
}): Promise<Config> {
  const [points, namingRule, inspectionList] = await Promise.all([
    loadPointConfig(options.pointConfigPath),
    loadNamingRule(options.namingRulePath),
    loadInspectionList(options.inspectionListPath),
  ]);

  const outputBasePath = path.resolve(options.outputBasePath);
  
  if (options.createOutputDir !== false && !await fs.pathExists(outputBasePath)) {
    await fs.mkdirp(outputBasePath);
  }

  return {
    points,
    namingRule,
    inspectionList,
    outputBasePath,
    archiveFormat: options.archiveFormat || 'directory',
    timeWindowMinutes: options.timeWindowMinutes || 60,
    backupEnabled: true,
    backupPath: path.join(outputBasePath, '.backup'),
  };
}
