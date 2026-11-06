import 'dotenv/config';
import { readEnv } from '../config/env.js';
import { createAuth } from './auth.js';

export const auth = createAuth(readEnv());
