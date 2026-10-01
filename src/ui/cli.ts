#!/usr/bin/env node
import { LOCAL_ONLY_UI_ERROR } from './local-only.js';

// Do not import the historical UI, provider SDKs, database or browser launcher.
process.stderr.write(`${LOCAL_ONLY_UI_ERROR}\n`);
process.exitCode = 1;
