/**
 * Environment Configuration
 * Validates and exports all environment variables with sensible defaults
 */
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import type { EnvironmentConfig, NestDeviceAPI } from '../lib/types';

if (fs.existsSync(path.resolve(process.cwd(), '.env.local'))) {
  console.log('[Config] Found .env.local file. Using this for environment setup.')
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  dotenv.config();
}

/**
 * Parse integer from environment variable with fallback
 */
function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get environment variable with fallback
 */
function getEnvString(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Get nullable environment variable
 */
function getEnvNullable(key: string): string | null {
  return process.env[key] || null;
}

/**
 * Get boolean environment variable with fallback
 */
function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Get Nest Device(s)
 */
function getNestDevices(devices: string): NestDeviceAPI[] | null {
  let nestDevicesApi: NestDeviceAPI[] = [];

  if (devices) {
    for (const device of devices.split(',')) {
      const deviceInfo: string[] = device.split(':');
      nestDevicesApi.push({ deviceIp:deviceInfo[0], deviceId:deviceInfo[1] });
    }
    return nestDevicesApi;
  }
  return null;
}

/**
 * Validated environment configuration
 */
export const environment: EnvironmentConfig = {
  API_ORIGIN: getEnvString('API_ORIGIN', 'http://backdoor.nolongerevil.com'),
  PROXY_PORT: getEnvInt('PROXY_PORT', 80),
  CONTROL_PORT: getEnvInt('CONTROL_PORT', 8081),

  CERT_DIR: getEnvNullable('CERT_DIR'),

  ENTRY_KEY_TTL_SECONDS: getEnvInt('ENTRY_KEY_TTL_SECONDS', 3600),
  WEATHER_CACHE_TTL_MS: getEnvInt('WEATHER_CACHE_TTL_MS', 10 * 60 * 1000), // 10 minutes

  SUBSCRIPTION_TIMEOUT_MS: process.env.SUBSCRIPTION_TIMEOUT_MS ? parseInt(process.env.SUBSCRIPTION_TIMEOUT_MS, 10) : 30000, // Default: 30 seconds per RFC 6202
  MAX_SUBSCRIPTIONS_PER_DEVICE: getEnvInt('MAX_SUBSCRIPTIONS_PER_DEVICE', 100),

  DEBUG_LOGGING: getEnvBoolean('DEBUG_LOGGING', false),
  DEBUG_LOGS_DIR: getEnvString('DEBUG_LOGS_DIR', './data/debug-logs'),

  SQLITE3_ENABLED: getEnvBoolean('SQLITE3_ENABLED', true),
  SQLITE3_DB_PATH: getEnvString('SQLITE3_DB_PATH', './data/database.sqlite'),

  NEST_DEVICES: getNestDevices(getEnvString('NEST_DEVICES', '')),

  MQTT_ENABLED: getEnvBoolean('MQTT_ENABLED', false),
  MQTT_SERVER_IP: getEnvString('MQTT_SERVER_IP', ''),
  MQTT_SERVER_PORT: getEnvInt('MQTT_SERVER_PORT', 0),
  MQTT_USERNAME: getEnvString('MQTT_USERNAME', ''),
  MQTT_PASSWORD: getEnvString('MQTT_PASSWORD', ''),
  MQTT_DEFAULT_ID: getEnvString('MQTT_DEFAULT_ID', 'homeassistant'),
  MQTT_CLIENT_ID: getEnvString('MQTT_CLIENT_ID', 'nolongerevil-hass'),
  MQTT_TOPIC_PREFIX: getEnvString('MQTT_TOPIC_PREFIX', 'nest'),
  MQTT_DISCOVERY_PREFIX: getEnvString('MQTT_DISCOVERY_PREFIX', 'homeassistant'),
  MQTT_HA_DISCOVERY: getEnvBoolean('MQTT_HA_DISCOVERY', false)
};

/**
 * Validate critical configuration on startup
 */
export function validateEnvironment(): void {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (environment.SQLITE3_ENABLED){
    console.log('[Config] SQLite3 storage enabled');
    if (!environment.SQLITE3_DB_PATH) {
     errors.push('SQLITE3_DB_PATH will use the default path. ./data/database.sqlite');
     environment.SQLITE3_DB_PATH = './data/database.sqlite';
    }
  }

  if (environment.PROXY_PORT < 1 || environment.PROXY_PORT > 65535) {
    errors.push(`Invalid PROXY_PORT: ${environment.PROXY_PORT} (must be 1-65535)`);
  }

  if (environment.CONTROL_PORT < 1 || environment.CONTROL_PORT > 65535) {
    errors.push(`Invalid CONTROL_PORT: ${environment.CONTROL_PORT} (must be 1-65535)`);
  }

  if (environment.MQTT_ENABLED) {
    if (!environment.NEST_DEVICES) {
      errors.push('NEST_DEVICES must be populated.');
    }
    if (!environment.MQTT_SERVER_IP) {
      errors.push('MQTT_SERVER_IP must be populated.');
    }
    if (environment.MQTT_SERVER_PORT < 1 || environment.MQTT_SERVER_PORT > 65535) {
      errors.push(`Invalid MQTT_SERVER_PORT: ${environment.MQTT_SERVER_PORT} (must be 1-65535)`);
    }
  }

  warnings.forEach(warning => {
    console.warn(`[Config Warning] ${warning}`);
  });

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }

  console.log('[Config] Environment validated successfully');
  console.log(`[Config] API Origin: ${environment.API_ORIGIN}`);
  console.log(`[Config] Proxy Port: ${environment.PROXY_PORT}`);
  console.log(`[Config] Control Port: ${environment.CONTROL_PORT}`);
  console.log(`[Config] State manager: ${environment.SQLITE3_ENABLED ? 'SQLite3' : 'Default SQLite3'}`);
  if (environment.SQLITE3_ENABLED) {
    console.log(`[Config] SQLite3 DB Path: ${environment.SQLITE3_DB_PATH}`);
  }
  console.log(`[Config] TLS Certificates: ${environment.CERT_DIR || 'Not configured (HTTP only)'}`);
  console.log(`[Config] Debug Logging: ${environment.DEBUG_LOGGING ? 'Enabled' : 'Disabled'}`);
  if (environment.DEBUG_LOGGING) {
    console.log(`[Config] Debug Logs Directory: ${environment.DEBUG_LOGS_DIR}`);
  }
}
