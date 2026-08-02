import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverSource = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('默认榜单每 2 小时刷新一次', () => {
  assert.match(serverSource, /const REFRESH_INTERVAL_MS = 2 \* 60 \* 60 \* 1000;/);
  assert.match(serverSource, /setInterval\(refreshDefaultBoards, REFRESH_INTERVAL_MS\);/);
});
