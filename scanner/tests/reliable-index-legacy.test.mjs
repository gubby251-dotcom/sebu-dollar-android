
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const legacyUrl = new URL('../reliable-index.mjs', import.meta.url);

test('reliable-index delegates to the M5 auto scanner', async () => {
  const source = await readFile(legacyUrl, 'utf8');

  assert.match(
    source,
    /import\s+["']\.\/m5-auto-scanner\.mjs["']/
  );
});

test('reliable-index contains no legacy M30/M15 signal implementation', async () => {
  const source = await readFile(legacyUrl, 'utf8');

  // Abaikan komentar agar nama timeframe di dokumentasi
  // tidak dianggap sebagai kode yang masih aktif.
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    executable,
    /\bM30\b|\bM15\b|50%\s*BODY\s*C2|evaluateM30|evaluateM15|scanTimeframe/
  );
});

test('reliable-index does not contain old setup definitions', async () => {
  const source = await readFile(legacyUrl, 'utf8');

  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    executable,
    /setupNumber|setupName|SETUP\s*[123]/
  );
});

test('reliable-index does not define another scanner loop', async () => {
  const source = await readFile(legacyUrl, 'utf8');

  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    executable,
    /\bsetInterval\b|\bwhile\s*\(|\bscanTimeframe\b/
  );
});
