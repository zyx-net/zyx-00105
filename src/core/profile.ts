import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { ProfileConfig, PointConfig, NamingRule } from '../types';
import { listBatches } from './archive';

const PROFILES_DIR = 'profiles';
const CURRENT_PROFILE_FILE = '.current_profile';

function getProfilesDir(basePath: string): string {
  return path.join(basePath, 'config', PROFILES_DIR);
}

function getProfilePath(basePath: string, profileName: string): string {
  return path.join(getProfilesDir(basePath), `${profileName}.json`);
}

function getCurrentProfilePath(basePath: string): string {
  return path.join(basePath, 'config', CURRENT_PROFILE_FILE);
}

export async function listProfiles(basePath: string): Promise<string[]> {
  const profilesDir = getProfilesDir(basePath);
  
  if (!await fs.pathExists(profilesDir)) {
    return [];
  }
  
  const files = await fs.readdir(profilesDir);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

export async function getCurrentProfile(basePath: string): Promise<string | null> {
  const currentProfilePath = getCurrentProfilePath(basePath);
  
  if (!await fs.pathExists(currentProfilePath)) {
    return null;
  }
  
  const content = await fs.readFile(currentProfilePath, 'utf-8');
  return content.trim() || null;
}

export async function loadProfile(basePath: string, profileName: string): Promise<ProfileConfig | null> {
  const profilePath = getProfilePath(basePath, profileName);
  
  if (!await fs.pathExists(profilePath)) {
    return null;
  }
  
  const content = await fs.readFile(profilePath, 'utf-8');
  return JSON.parse(content);
}

export async function hasRunningBatch(basePath: string): Promise<boolean> {
  const batches = await listBatches(basePath);
  return batches.some(b => b.status === 'running' || b.lock?.locked);
}

export async function initProfile(
  basePath: string,
  profileName: string,
  options: {
    points: PointConfig[];
    namingRule: NamingRule;
    timeWindowMinutes: number;
  },
  dryRun: boolean = false
): Promise<{ success: boolean; message: string; profile?: ProfileConfig }> {
  const profilesDir = getProfilesDir(basePath);
  const profilePath = getProfilePath(basePath, profileName);
  
  if (await fs.pathExists(profilePath)) {
    return {
      success: false,
      message: `Profile "${profileName}" already exists`,
    };
  }
  
  const now = DateTime.now().toISO();
  const profile: ProfileConfig = {
    name: profileName,
    points: options.points,
    namingRule: options.namingRule,
    timeWindowMinutes: options.timeWindowMinutes,
    createdAt: now,
    updatedAt: now,
  };
  
  if (dryRun) {
    return {
      success: true,
      message: `[DRY-RUN] Would create profile "${profileName}"`,
      profile,
    };
  }
  
  await fs.mkdirp(profilesDir);
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));
  
  return {
    success: true,
    message: `Profile "${profileName}" created successfully`,
    profile,
  };
}

export async function switchProfile(
  basePath: string,
  profileName: string,
  dryRun: boolean = false
): Promise<{ success: boolean; message: string; profile?: ProfileConfig }> {
  const profilePath = getProfilePath(basePath, profileName);
  
  if (!await fs.pathExists(profilePath)) {
    return {
      success: false,
      message: `Profile "${profileName}" does not exist`,
    };
  }
  
  if (await hasRunningBatch(basePath)) {
    return {
      success: false,
      message: `Cannot switch profile: there are running batches. Please wait for them to complete or rollback first.`,
    };
  }
  
  const profile = await loadProfile(basePath, profileName);
  
  if (dryRun) {
    return {
      success: true,
      message: `[DRY-RUN] Would switch to profile "${profileName}"`,
      profile: profile || undefined,
    };
  }
  
  const currentProfilePath = getCurrentProfilePath(basePath);
  await fs.mkdirp(path.dirname(currentProfilePath));
  await fs.writeFile(currentProfilePath, profileName);
  
  return {
    success: true,
    message: `Switched to profile "${profileName}"`,
    profile: profile || undefined,
  };
}

export async function deleteProfile(
  basePath: string,
  profileName: string,
  dryRun: boolean = false
): Promise<{ success: boolean; message: string }> {
  const profilePath = getProfilePath(basePath, profileName);
  
  if (!await fs.pathExists(profilePath)) {
    return {
      success: false,
      message: `Profile "${profileName}" does not exist`,
    };
  }
  
  const currentProfile = await getCurrentProfile(basePath);
  if (currentProfile === profileName) {
    return {
      success: false,
      message: `Cannot delete profile "${profileName}": it is currently active. Switch to another profile first.`,
    };
  }
  
  if (dryRun) {
    return {
      success: true,
      message: `[DRY-RUN] Would delete profile "${profileName}"`,
    };
  }
  
  await fs.remove(profilePath);
  
  return {
    success: true,
    message: `Profile "${profileName}" deleted successfully`,
  };
}

export async function listProfilesWithDetails(
  basePath: string
): Promise<{ name: string; createdAt: string; pointsCount: number; isActive: boolean }[]> {
  const profiles = await listProfiles(basePath);
  const currentProfile = await getCurrentProfile(basePath);
  
  const result = [];
  for (const name of profiles) {
    const profile = await loadProfile(basePath, name);
    if (profile) {
      result.push({
        name,
        createdAt: profile.createdAt,
        pointsCount: profile.points.length,
        isActive: currentProfile === name,
      });
    }
  }
  
  return result;
}

export interface ShowProfileResult {
  name: string;
  storagePath: string;
  namingPattern: string;
  dateFormat: string;
  timeWindowMinutes: number;
  pointsCount: number;
  createdAt: string;
}

export async function showProfile(
  basePath: string
): Promise<{ success: boolean; message: string; result?: ShowProfileResult }> {
  const currentProfileName = await getCurrentProfile(basePath);
  
  if (!currentProfileName) {
    return {
      success: false,
      message: 'No active profile found',
    };
  }
  
  const profile = await loadProfile(basePath, currentProfileName);
  
  if (!profile) {
    return {
      success: false,
      message: `Profile "${currentProfileName}" not found`,
    };
  }
  
  const storagePath = getProfilePath(basePath, currentProfileName);
  
  return {
    success: true,
    message: `Current profile: ${currentProfileName}`,
    result: {
      name: profile.name,
      storagePath,
      namingPattern: profile.namingRule.pattern,
      dateFormat: profile.namingRule.dateFormat,
      timeWindowMinutes: profile.timeWindowMinutes,
      pointsCount: profile.points.length,
      createdAt: profile.createdAt,
    },
  };
}
