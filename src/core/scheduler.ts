import { ScheduledTask, TaskRunLog, ScheduleManagerState } from '../types';
import * as storage from './scheduleStorage';
import * as opLog from './operationLog';
import { spawn } from 'child_process';
import { DateTime } from 'luxon';

const state: ScheduleManagerState = {
  isRunning: false,
  runningTasks: [],
  scheduledTimers: new Map(),
};

export function parseCronExpression(expression: string): {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
} {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Invalid cron expression: expected 5 fields');
  }

  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') {
      return Array.from({ length: max - min + 1 }, (_, i) => i + min);
    }

    const values: number[] = [];
    const fieldParts = field.split(',');
    
    for (const part of fieldParts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (isNaN(start) || isNaN(end)) {
          throw new Error(`Invalid range: ${part}`);
        }
        if (start < min || end > max) {
          throw new Error(`Range out of bounds: ${part} (valid range: ${min}-${max})`);
        }
        for (let i = start; i <= end; i++) {
          values.push(i);
        }
      } else if (part.includes('/')) {
        const parts = part.split('/');
        const baseStr = parts[0];
        const step = Number(parts[1]);
        if (isNaN(step) || step <= 0) {
          throw new Error(`Invalid step value: ${parts[1]}`);
        }
        const baseValues = baseStr === '*' 
          ? Array.from({ length: max - min + 1 }, (_, i) => i + min)
          : [Number(baseStr)];
        for (let i = 0; i < baseValues.length; i += step) {
          values.push(baseValues[i]);
        }
      } else {
        const num = Number(part);
        if (isNaN(num)) {
          throw new Error(`Invalid number: ${part}`);
        }
        if (num < min || num > max) {
          throw new Error(`Value out of bounds: ${num} (valid range: ${min}-${max})`);
        }
        values.push(num);
      }
    }

    if (values.length === 0) {
      throw new Error(`No valid values in field: ${field}`);
    }

    return [...new Set(values)].sort((a, b) => a - b);
  };

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function getNextRunTime(expression: string, fromTime: Date = new Date()): Date {
  const cron = parseCronExpression(expression);
  let current = DateTime.fromJSDate(fromTime).startOf('minute');
  
  const startOfDay = current.startOf('day');
  
  for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
    const date = startOfDay.plus({ days: dayOffset });
    
    if (!cron.month.includes(date.month)) continue;
    if (!cron.dayOfMonth.includes(date.day)) continue;
    if (!cron.dayOfWeek.includes(date.weekday % 7)) continue;
    
    for (const hour of cron.hour) {
      for (const minute of cron.minute) {
        const candidate = date.set({ hour, minute, second: 0, millisecond: 0 });
        if (candidate > current) {
          return candidate.toJSDate();
        }
      }
    }
  }
  
  throw new Error('Could not find next run time within one year');
}

export async function getNextRunTimeForTask(task: ScheduledTask): Promise<Date> {
  const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : new Date(0);
  return getNextRunTime(task.cronExpression, lastRun);
}

export function hasConflictingTask(runningTasks: string[], taskId: string): boolean {
  return runningTasks.length > 0 && !runningTasks.includes(taskId);
}

export async function runTask(
  outputBasePath: string,
  task: ScheduledTask,
  force: boolean = false
): Promise<TaskRunLog> {
  const startTime = Date.now();
  
  if (hasConflictingTask(state.runningTasks, task.id) && !force) {
    const log: TaskRunLog = {
      timestamp: new Date().toISOString(),
      taskId: task.id,
      taskName: task.name,
      status: 'skipped',
      conflictDetected: true,
      forced: false,
      command: `${task.command} ${task.args.join(' ')}`,
    };
    
    await appendTaskRunLog(outputBasePath, log);
    return log;
  }

  state.runningTasks.push(task.id);
  
  const hasConflict = hasConflictingTask(state.runningTasks.filter(t => t !== task.id), task.id);
  
  const log: TaskRunLog = {
    timestamp: new Date().toISOString(),
    taskId: task.id,
    taskName: task.name,
    status: 'running',
    forced: force,
    conflictDetected: hasConflict && !force,
    command: `${task.command} ${task.args.join(' ')}`,
  };

  try {
    const result = await new Promise<{ exitCode: number; error?: string }>((resolve) => {
      const process = spawn(task.command, task.args, {
        stdio: 'inherit',
        shell: true,
      });

      process.on('close', (code) => {
        resolve({ exitCode: code ?? 1 });
      });

      process.on('error', (err) => {
        resolve({ exitCode: 1, error: err.message });
      });
    });

    const durationMs = Date.now() - startTime;
    
    await storage.updateTaskLastRun(outputBasePath, task.id, result.exitCode, durationMs);

    const finalLog: TaskRunLog = {
      ...log,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      exitCode: result.exitCode,
      durationMs,
      errorMessage: result.error,
    };

    await appendTaskRunLog(outputBasePath, finalLog);
    return finalLog;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const finalLog: TaskRunLog = {
      ...log,
      status: 'failed',
      exitCode: 1,
      durationMs,
      errorMessage: (error as Error).message,
    };

    await appendTaskRunLog(outputBasePath, finalLog);
    return finalLog;
  } finally {
    const index = state.runningTasks.indexOf(task.id);
    if (index !== -1) {
      state.runningTasks.splice(index, 1);
    }
  }
}

export async function appendTaskRunLog(outputBasePath: string, log: TaskRunLog): Promise<void> {
  const entry = opLog.createLogEntry('schedule-run', {
    taskId: log.taskId,
    taskName: log.taskName,
    status: log.status,
    exitCode: log.exitCode,
    durationMs: log.durationMs,
    errorMessage: log.errorMessage,
    conflictDetected: log.conflictDetected,
    forced: log.forced,
    command: log.command,
  }, log.exitCode ?? 0, log.durationMs ?? 0, log.errorMessage);
  
  await opLog.appendLog(outputBasePath, entry);
}

export async function startScheduler(outputBasePath: string): Promise<void> {
  if (state.isRunning) {
    return;
  }

  state.isRunning = true;
  
  const tasks = await storage.listTasks(outputBasePath);
  
  for (const task of tasks) {
    if (task.enabled) {
      scheduleTask(outputBasePath, task);
    }
  }
}

export function scheduleTask(outputBasePath: string, task: ScheduledTask): void {
  if (!task.enabled) {
    return;
  }

  try {
    const nextRun = getNextRunTime(task.cronExpression);
    const delay = nextRun.getTime() - Date.now();

    if (delay > 0) {
      const timer = setTimeout(async () => {
        await runTask(outputBasePath, task, false);
        scheduleTask(outputBasePath, task);
      }, delay);

      state.scheduledTimers.set(task.id, timer);
    }
  } catch (error) {
    console.error(`Failed to schedule task ${task.id}: ${(error as Error).message}`);
  }
}

export function stopScheduler(): void {
  state.isRunning = false;
  
  for (const timer of state.scheduledTimers.values()) {
    clearTimeout(timer);
  }
  state.scheduledTimers.clear();
  state.runningTasks = [];
}

export function rescheduleTask(outputBasePath: string, taskId: string): void {
  const existingTimer = state.scheduledTimers.get(taskId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    state.scheduledTimers.delete(taskId);
  }
  
  storage.getTaskById(outputBasePath, taskId).then(task => {
    if (task && task.enabled) {
      scheduleTask(outputBasePath, task);
    }
  });
}

export function getRunningTasks(): string[] {
  return [...state.runningTasks];
}

export function isSchedulerRunning(): boolean {
  return state.isRunning;
}