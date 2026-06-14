import * as fs from 'fs-extra';
import * as path from 'path';
import { ScheduleConfig, ScheduledTask } from '../types';

const SCHEDULE_FILE_NAME = 'schedule.json';
const SCHEDULE_VERSION = '1.0.0';

export async function getScheduleFilePath(outputBasePath: string): Promise<string> {
  return path.join(outputBasePath, SCHEDULE_FILE_NAME);
}

export async function loadScheduleConfig(outputBasePath: string): Promise<ScheduleConfig> {
  const filePath = await getScheduleFilePath(outputBasePath);
  
  if (await fs.pathExists(filePath)) {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }
  
  return {
    version: SCHEDULE_VERSION,
    tasks: [],
    lastModified: new Date().toISOString(),
  };
}

export async function saveScheduleConfig(outputBasePath: string, config: ScheduleConfig): Promise<void> {
  const filePath = await getScheduleFilePath(outputBasePath);
  config.lastModified = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(config, null, 2));
}

export async function addTask(outputBasePath: string, task: Omit<ScheduledTask, 'createdAt'>): Promise<ScheduledTask> {
  const config = await loadScheduleConfig(outputBasePath);
  
  const newTask: ScheduledTask = {
    ...task,
    createdAt: new Date().toISOString(),
  };
  
  config.tasks.push(newTask);
  await saveScheduleConfig(outputBasePath, config);
  
  return newTask;
}

export async function removeTask(outputBasePath: string, taskId: string): Promise<boolean> {
  const config = await loadScheduleConfig(outputBasePath);
  const initialLength = config.tasks.length;
  
  config.tasks = config.tasks.filter(t => t.id !== taskId);
  
  if (config.tasks.length !== initialLength) {
    await saveScheduleConfig(outputBasePath, config);
    return true;
  }
  
  return false;
}

export async function updateTask(outputBasePath: string, taskId: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
  const config = await loadScheduleConfig(outputBasePath);
  const taskIndex = config.tasks.findIndex(t => t.id === taskId);
  
  if (taskIndex === -1) {
    return null;
  }
  
  config.tasks[taskIndex] = { ...config.tasks[taskIndex], ...updates };
  await saveScheduleConfig(outputBasePath, config);
  
  return config.tasks[taskIndex];
}

export async function enableTask(outputBasePath: string, taskId: string): Promise<boolean> {
  const result = await updateTask(outputBasePath, taskId, { enabled: true });
  return result !== null;
}

export async function disableTask(outputBasePath: string, taskId: string): Promise<boolean> {
  const result = await updateTask(outputBasePath, taskId, { enabled: false });
  return result !== null;
}

export async function getTaskById(outputBasePath: string, taskId: string): Promise<ScheduledTask | undefined> {
  const config = await loadScheduleConfig(outputBasePath);
  return config.tasks.find(t => t.id === taskId);
}

export async function listTasks(outputBasePath: string): Promise<ScheduledTask[]> {
  const config = await loadScheduleConfig(outputBasePath);
  return config.tasks;
}

export async function updateTaskLastRun(
  outputBasePath: string,
  taskId: string,
  exitCode: number,
  durationMs: number
): Promise<void> {
  await updateTask(outputBasePath, taskId, {
    lastRunAt: new Date().toISOString(),
    lastExitCode: exitCode,
    lastDurationMs: durationMs,
  });
}