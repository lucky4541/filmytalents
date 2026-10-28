import pino from 'pino';
import { isTest } from '../config/env';

export const logger = pino({ level: isTest ? 'silent' : process.env.LOG_LEVEL ?? 'info' });
