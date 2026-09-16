import test from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../src/types.ts';
import { makeSketch } from '../src/similarity.ts';

// Never fall back to DATABASE_URL. Integration tests require a dedicated disposable DB.
test('PostgreSQL migration, scope, reply joins, replay, erasure, and retention', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Store } = await import('../src/store.ts');
  const store = new Store(process.env.TEST_DATABASE_URL!);
  const guildId = `synthetic-${Date.now()}`;
  const createdAt = Date.now();
  const row: Observation = { guildId, messageId: 'reply', authorId: 'member', channelId: 'channel',
    createdAt, replyToId: 'parent', contentLength: null, fingerprint: null, artifacts: [],
    similarity: makeSketch(Array.from({length: 40}, (_, i) => `syntheticword${i}`).join(' '),
      'synthetic-test-only-secret-key-12345', guildId, 'member') };
  try {
    await store.migrate(); await store.migrate();
    await store.insert({ ...row, messageId: 'parent', authorId: 'other', createdAt: createdAt - 5000, replyToId: null });
    await store.insert(row); await store.insert(row);
    const result = await store.review(guildId, 'member', ['channel'], createdAt - 10000, createdAt + 10000, 20);
    assert.equal(result.messages.length, 1); assert.equal(result.messages[0]!.replyLatencyMs, 5000);
    assert.deepEqual(result.messages[0]!.similarity, row.similarity);
    await store.insert({ ...row, messageId: 'legacy', similarity: null });
    const legacy = await store.review(guildId, 'member', ['channel'], createdAt - 10000, createdAt + 10000, 20);
    assert.equal(legacy.messages.find(r => r.messageId === 'legacy')!.similarity, null);
    await store.remove(guildId, ['legacy']);
    assert.equal((await store.review(guildId, 'member', [], createdAt - 10000, createdAt + 10000, 20)).messages.length, 0);
    assert.equal((await store.review('other-guild', 'member', ['channel'], createdAt - 10000, createdAt + 10000, 20)).messages.length, 0);
    await store.remove(guildId, ['reply']); await store.insert(row);
    assert.equal((await store.review(guildId, 'member', ['channel'], createdAt - 10000, createdAt + 10000, 20)).messages.length, 0);
    await store.insert({ ...row, messageId: 'fresh' });
    assert.equal(await store.forget(guildId, 'member'), 1);
    await store.insert({ ...row, messageId: 'fresh' });
    assert.equal((await store.review(guildId, 'member', ['channel'], createdAt - 10000, createdAt + 10000, 20)).messages.length, 0);
    await store.prune(guildId, createdAt + 60000);
    assert.equal((await store.review(guildId, 'other', ['channel'], createdAt - 10000, createdAt + 10000, 20)).messages.length, 0);
  } finally { await store.prune(guildId, Date.now() + 86400000); await store.close(); }
});
