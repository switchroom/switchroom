#!/usr/bin/env bun
/**
 * Print the quota-bar block (telegram-plugin/quota-bar-format.ts) for the
 * current fleet, using the same cached `last_quota` data
 * `switchroom auth list --json` exposes. No live quota probe — this is the
 * cheap/cached render path, matching `buildSnapshotsFromCachedState`.
 *
 * Usage:
 *   bun scripts/print-quota-bar.ts
 *
 * Minimal by design — this is a manual/dev entrypoint for eyeballing the
 * block's current output, not a scheduler or a live-refreshing Telegram
 * sender. Wiring this to an actually-refreshing pinned message is a
 * follow-up once the format above is confirmed stable in real chats.
 */

import { execFileSync } from 'node:child_process';
import type { ListStateData } from '../src/auth/broker/client.js';
import { renderQuotaBarBlockFromListState } from '../telegram-plugin/quota-bar-format.js';

function loadListState(): ListStateData {
  const raw = execFileSync('switchroom', ['auth', 'list', '--json'], {
    encoding: 'utf-8',
  });
  return JSON.parse(raw) as ListStateData;
}

const state = loadListState();
process.stdout.write(renderQuotaBarBlockFromListState(state) + '\n');
