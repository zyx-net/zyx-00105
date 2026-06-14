import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { OperationLogEntry, LogQueryOptions } from '../types';

const LOG_FILE = 'ops.log.jsonl';

export async function appendLog(
  outputBasePath: string,
  entry: OperationLogEntry
): Promise<void> {
  const logPath = path.join(outputBasePath, LOG_FILE);
  await fs.ensureDir(path.dirname(logPath));
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(logPath, line, 'utf-8');
}

export async function readLogs(
  outputBasePath: string,
  options: LogQueryOptions = {}
): Promise<OperationLogEntry[]> {
  const logPath = path.join(outputBasePath, LOG_FILE);
  
  if (!await fs.pathExists(logPath)) {
    return [];
  }

  const content = await fs.readFile(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  let entries: OperationLogEntry[] = lines.map(line => JSON.parse(line));

  if (options.since) {
    const sinceTime = DateTime.fromISO(options.since);
    if (sinceTime.isValid) {
      entries = entries.filter(e => 
        DateTime.fromISO(e.timestamp) >= sinceTime
      );
    }
  }

  if (options.until) {
    const untilTime = DateTime.fromISO(options.until);
    if (untilTime.isValid) {
      entries = entries.filter(e => 
        DateTime.fromISO(e.timestamp) <= untilTime
      );
    }
  }

  entries.sort((a, b) => 
    DateTime.fromISO(b.timestamp).toMillis() - DateTime.fromISO(a.timestamp).toMillis()
  );

  if (options.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}

export async function clearLogs(outputBasePath: string): Promise<void> {
  const logPath = path.join(outputBasePath, LOG_FILE);
  if (await fs.pathExists(logPath)) {
    await fs.unlink(logPath);
  }
}

export function formatLogsTable(entries: OperationLogEntry[]): string {
  if (entries.length === 0) {
    return '暂无操作记录';
  }

  const lines: string[] = [];
  lines.push('┌─────────────────────────────┬──────────────┬──────────────────────────────────┬────────┬──────────┬──────────────────┐');
  lines.push('│ 时间                        │ 命令         │ 参数摘要                         │ 退出码 │ 耗时(ms) │ 错误信息         │');
  lines.push('├─────────────────────────────┼──────────────┼──────────────────────────────────┼────────┼──────────┼──────────────────┤');

  for (const entry of entries) {
    const time = DateTime.fromISO(entry.timestamp).toFormat('yyyy-MM-dd HH:mm:ss');
    const cmd = entry.command.padEnd(12).slice(0, 12);
    
    const paramsSummary = formatParamsSummary(entry.params);
    const exitCode = entry.exitCode === 0 ? '✓ 0' : `✗ ${entry.exitCode}`;
    const duration = entry.durationMs.toString();
    const error = entry.error ? entry.error.slice(0, 16) : '-';

    lines.push(`│ ${time} │ ${cmd} │ ${paramsSummary} │ ${exitCode.padEnd(6)} │ ${duration.padEnd(8)} │ ${error.padEnd(16)} │`);
  }

  lines.push('└─────────────────────────────┴──────────────┴──────────────────────────────────┴────────┴──────────┴──────────────────┘');
  
  return lines.join('\n');
}

function formatParamsSummary(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return '-'.padEnd(32);
  
  const summary = keys.slice(0, 3).map(k => {
    const v = params[k];
    if (typeof v === 'string') {
      return `${k}=${v.length > 10 ? v.slice(0, 10) + '...' : v}`;
    }
    return `${k}=${String(v)}`;
  }).join(', ');

  return summary.padEnd(32).slice(0, 32);
}

export function createLogEntry(
  command: string,
  params: Record<string, unknown>,
  exitCode: number,
  durationMs: number,
  error?: string
): OperationLogEntry {
  return {
    timestamp: DateTime.now().toISO(),
    command,
    params,
    exitCode,
    durationMs,
    error,
  };
}
