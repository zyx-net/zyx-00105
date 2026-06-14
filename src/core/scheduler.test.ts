import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import * as scheduleStorage from './scheduleStorage';
import * as scheduler from './scheduler';

const SLEEP_CMD = process.platform === 'win32' ? 'timeout' : 'sleep';
const SLEEP_ARG = process.platform === 'win32' ? '/t' : '';

describe('Scheduler Tests', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    scheduler.stopScheduler();
  });

  describe('Cron Expression Validation', () => {
    it('should validate valid cron expressions', () => {
      expect(scheduler.isValidCronExpression('0 0 * * *')).toBe(true);
      expect(scheduler.isValidCronExpression('*/5 * * * *')).toBe(true);
      expect(scheduler.isValidCronExpression('0 12 * * 1-5')).toBe(true);
      expect(scheduler.isValidCronExpression('30 8,18 * * *')).toBe(true);
    });

    it('should reject invalid cron expressions', () => {
      expect(scheduler.isValidCronExpression('0 * * *')).toBe(false);
      expect(scheduler.isValidCronExpression('0 25 * * *')).toBe(false);
      expect(scheduler.isValidCronExpression('60 * * * *')).toBe(false);
      expect(scheduler.isValidCronExpression('* * 32 * *')).toBe(false);
    });
  });

  describe('Next Run Time Calculation', () => {
    it('should calculate next run time correctly', () => {
      const nextRun = scheduler.getNextRunTime('0 0 * * *');
      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    });

    it('should calculate next run time for complex expressions', () => {
      const nextRun = scheduler.getNextRunTime('*/5 * * * *');
      expect(nextRun).toBeInstanceOf(Date);
      const diffMinutes = Math.floor((nextRun.getTime() - Date.now()) / 60000);
      expect(diffMinutes).toBeGreaterThanOrEqual(0);
      expect(diffMinutes).toBeLessThan(5);
    });
  });

  describe('Configuration Persistence', () => {
    it('should persist tasks to schedule.json', async () => {
      const task = await scheduleStorage.addTask(tempDir, {
        id: 'test-task-1',
        name: 'Test Task',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: ['hello'],
        enabled: true,
      });

      expect(task.id).toBe('test-task-1');
      expect(task.name).toBe('Test Task');
      expect(task.enabled).toBe(true);

      const schedulePath = path.join(tempDir, 'config', 'schedule.json');
      expect(await fs.pathExists(schedulePath)).toBe(true);

      const content = await fs.readFile(schedulePath, 'utf-8');
      const config = JSON.parse(content);
      expect(config.version).toBe('1.0.0');
      expect(config.tasks.length).toBe(1);
      expect(config.tasks[0].id).toBe('test-task-1');
    });

    it('should restore tasks after reload', async () => {
      await scheduleStorage.addTask(tempDir, {
        id: 'test-task-2',
        name: 'Test Task 2',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: [],
        enabled: false,
      });

      const tasks = await scheduleStorage.listTasks(tempDir);
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('test-task-2');
      expect(tasks[0].enabled).toBe(false);

      const reloadedTasks = await scheduleStorage.listTasks(tempDir);
      expect(reloadedTasks.length).toBe(1);
      expect(reloadedTasks[0].id).toBe('test-task-2');
    });
  });

  describe('Task Management', () => {
    it('should add and remove tasks', async () => {
      const task = await scheduleStorage.addTask(tempDir, {
        id: 'test-task-3',
        name: 'Test Task 3',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: [],
        enabled: true,
      });

      let tasks = await scheduleStorage.listTasks(tempDir);
      expect(tasks.length).toBe(1);

      const success = await scheduleStorage.removeTask(tempDir, 'test-task-3');
      expect(success).toBe(true);

      tasks = await scheduleStorage.listTasks(tempDir);
      expect(tasks.length).toBe(0);
    });

    it('should enable and disable tasks', async () => {
      const task = await scheduleStorage.addTask(tempDir, {
        id: 'test-task-4',
        name: 'Test Task 4',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: [],
        enabled: true,
      });

      await scheduleStorage.disableTask(tempDir, 'test-task-4');
      let updatedTask = await scheduleStorage.getTaskById(tempDir, 'test-task-4');
      expect(updatedTask?.enabled).toBe(false);

      await scheduleStorage.enableTask(tempDir, 'test-task-4');
      updatedTask = await scheduleStorage.getTaskById(tempDir, 'test-task-4');
      expect(updatedTask?.enabled).toBe(true);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect running task conflicts', () => {
      const runningTasks = ['task-1', 'task-2'];
      expect(scheduler.hasConflictingTask(runningTasks, 'task-3')).toBe(true);
      expect(scheduler.hasConflictingTask(runningTasks, 'task-1')).toBe(false);
      expect(scheduler.hasConflictingTask([], 'task-1')).toBe(false);
    });
  });

  describe('Task Execution', () => {
    it('should execute a simple task', async () => {
      const task = await scheduleStorage.addTask(tempDir, {
        id: 'exec-test-1',
        name: 'Exec Test',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: ['test'],
        enabled: true,
      });

      const result = await scheduler.runTask(tempDir, task, true);
      expect(result.taskId).toBe('exec-test-1');
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);

      const updatedTask = await scheduleStorage.getTaskById(tempDir, 'exec-test-1');
      expect(updatedTask?.lastRunAt).toBeDefined();
      expect(updatedTask?.lastExitCode).toBe(0);
    });

    it('should skip task when conflict detected', async () => {
      const task1 = await scheduleStorage.addTask(tempDir, {
        id: 'conflict-task-1',
        name: 'Conflict Task 1',
        cronExpression: '0 * * * *',
        command: SLEEP_CMD,
        args: SLEEP_ARG ? [SLEEP_ARG, '1'] : ['1'],
        enabled: true,
      });

      const task2 = await scheduleStorage.addTask(tempDir, {
        id: 'conflict-task-2',
        name: 'Conflict Task 2',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: ['test'],
        enabled: true,
      });

      const promise1 = scheduler.runTask(tempDir, task1, true);
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const result2 = await scheduler.runTask(tempDir, task2, false);
      expect(result2.conflictDetected).toBe(true);
      expect(result2.status).toBe('skipped');

      await promise1;
    });

    it('should force run task despite conflict', async () => {
      const task1 = await scheduleStorage.addTask(tempDir, {
        id: 'force-task-1',
        name: 'Force Task 1',
        cronExpression: '0 * * * *',
        command: SLEEP_CMD,
        args: SLEEP_ARG ? [SLEEP_ARG, '1'] : ['1'],
        enabled: true,
      });

      const task2 = await scheduleStorage.addTask(tempDir, {
        id: 'force-task-2',
        name: 'Force Task 2',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: ['force'],
        enabled: true,
      });

      const promise1 = scheduler.runTask(tempDir, task1, true);
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const result2 = await scheduler.runTask(tempDir, task2, true);
      expect(result2.conflictDetected).toBe(false);
      expect(result2.forced).toBe(true);
      expect(result2.status).toBe('completed');

      await promise1;
    });
  });

  describe('Next Run Preview', () => {
    it('should preview next run time for tasks', async () => {
      const task = await scheduleStorage.addTask(tempDir, {
        id: 'preview-task',
        name: 'Preview Task',
        cronExpression: '0 0 * * *',
        command: 'echo',
        args: [],
        enabled: true,
      });

      const nextRun = await scheduler.getNextRunTimeForTask(task);
      expect(nextRun).toBeInstanceOf(Date);
    });

    it('should handle disabled tasks', async () => {
      const task = await scheduleStorage.addTask(tempDir, {
        id: 'disabled-task',
        name: 'Disabled Task',
        cronExpression: '0 * * * *',
        command: 'echo',
        args: [],
        enabled: false,
      });

      await expect(scheduler.getNextRunTimeForTask(task)).resolves.toBeInstanceOf(Date);
    });
  });
});