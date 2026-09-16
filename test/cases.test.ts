import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenCase, reviewStart, notificationText, retryDelay, isCaseId } from '../src/case-policy.ts';
import { moderatorOnlyChannel } from '../src/case-access.ts';
import { loadConfig } from '../src/config.ts';
import { analyze } from '../src/analyzer.ts';
import { monitorTick } from '../src/monitor.ts';
import type { MonitorHooks, MonitorStore } from '../src/monitor.ts';
import type { ReviewInput } from '../src/types.ts';
const guildId = '100000000000000001'; const authorId = '100000000000000002';
function config() {
  return loadConfig({ DISCORD_TOKEN:'synthetic',DISCORD_APPLICATION_ID:guildId,DISCORD_GUILD_ID:guildId,
    MODERATOR_CHANNEL_ID:'100000000000000099',DATABASE_URL:'postgresql://localhost/claw',
    COLLECTION_ENABLED:'true',CONTENT_SIGNALS_ENABLED:'true',POLICY_REVIEW_ACKNOWLEDGED:'true',
    OBSERVED_CHANNEL_IDS:'100000000000000010',FINGERPRINT_SECRET:'synthetic-test-only-secret-key-12345' });
}
function sample(now = Date.now(), subject = authorId): ReviewInput {
  return { guildId,authorId:subject,startAt:now-86400000,endAt:now,truncated:false,
    messages:Array.from({length:24},(_,i) => ({ guildId,authorId:subject,channelId:`channel-${i%3}`,messageId:`m-${i}`,
      createdAt:now-3600000+i*120000,replyToId:null,replyLatencyMs:null,contentLength:400,fingerprint:'same-text',
      artifacts:['execution-marker'] })) };
}
test('automatic review defaults ON once collection and content signals are configured', () => {
  assert.equal(config().autoReviewEnabled,true);
  assert.equal(config().autoReviewIntervalSeconds,300); assert.equal(config().autoCaseThreshold,60);
});
test('automatic review refuses metadata-only or disabled collection configuration', () => {
  assert.throws(() => loadConfig({AUTO_REVIEW_ENABLED:'true'}), /collection and content/);
});
test('threshold gate needs sufficient evidence and at least two score families', () => {
  const report = analyze(sample());
  assert.equal(shouldOpenCase(report,60),true); assert.equal(shouldOpenCase(report,90),false);
  assert.equal(shouldOpenCase({...report,priority:'insufficient-evidence'},60),false);
  assert.equal(shouldOpenCase({...report,heuristicScore:null},60),false);
  assert.equal(shouldOpenCase({...report,heuristicScore:NaN},60),false);
  assert.equal(shouldOpenCase({...report,familyScores:{timing:35}},60),false);
  assert.equal(shouldOpenCase({...report,sample:{...report.sample,truncated:true}},60),false);
});
test('new cases exclude pre-resolution evidence and known monitoring gaps', () => {
  assert.equal(reviewStart(100000,1,40000,60000),60001);
  assert.equal(reviewStart(100000,1,70000,60000),70000);
  assert.equal(reviewStart(100000000,1,0,null),13600000);
});
test('case identifiers reject malformed and overflowing bigint values', () => {
  for (const id of ['0','-1','x','1;drop','9999999999999999999','01']) assert.equal(isCaseId(id),false);
  assert.equal(isCaseId('123'),true); assert.equal(isCaseId('9223372036854775807'),true);
});
test('shared notification contains only an opaque case reference and static guidance', () => {
  const body = notificationText('42'); assert.match(body,/case:42/);
  assert.ok(!body.includes(authorId)); assert.ok(!body.includes('https://discord.com/channels'));
  assert.throws(() => notificationText('@everyone'));
});
test('notification backoff is bounded', () => {
  assert.equal(retryDelay(0),30000); assert.ok(retryDelay(5)>retryDelay(1)); assert.equal(retryDelay(100),3600000);
});
test('privacy gate requires an explicit everyone denial and moderator-only role grants', () => {
  const everyone = {id:guildId,type:0,allow:0n,deny:1024n};
  const mod = {id:'mod',type:0,allow:1024n,deny:0n};
  assert.equal(moderatorOnlyChannel(guildId,'bot',[everyone,mod],new Map([['mod',32n]])),true);
  assert.equal(moderatorOnlyChannel(guildId,'bot',[mod],new Map([['mod',32n]])),false);
  assert.equal(moderatorOnlyChannel(guildId,'bot',[everyone,mod],new Map([['mod',1024n]])),false);
  assert.equal(moderatorOnlyChannel(guildId,'bot',[everyone,{...mod,type:1,id:'ordinary-member'}],new Map()),false);
  assert.equal(moderatorOnlyChannel(guildId,'bot',[everyone,{...mod,type:1,id:'bot'}],new Map()),true);
});
function rig(now = Date.now()) {
  const input = sample(now);
  const saved: string[] = []; const errors: string[] = [];
  const postponed: number[] = []; const windows: number[] = [];
  let clean = now-86400000;
  const store: MonitorStore = {
    review: async (_g,_a,_c,start) => { windows.push(start); return {messages:input.messages.filter(m=>m.createdAt>=start),truncated:false}; },
    cases:{
      due:async()=>[{authorId,revision:'1'}], latestClosed:async()=>null,
      postpone:async(_g,_a,until)=>{postponed.push(until);},
      save:async(_g,_job,report)=>{saved.push(report.priority);return 'created';},
      pendingNotices:async()=>[],beginNotice:async()=>true,delivered:async()=>{},
    },
  };
  const hooks: MonitorHooks = { cleanSince:()=>clean, channels:async()=>['channel-0','channel-1','channel-2'],
    review:async x=>analyze(x),notify:async()=> 'sent',error:k=>{errors.push(k);} };
  return {store,hooks,saved,errors,postponed,windows,setClean:(v:number)=>{clean=v;}};
}
test('scheduler automatically evaluates dirty members without a slash command', async () => {
  const now=Date.now();const r=rig(now);await monitorTick(r.store,config(),r.hooks,()=>now);
  assert.deepEqual(r.saved,['review-recommended']);
});
test('resolved cases are suppressed throughout their cooldown', async () => {
  const now=Date.now();const r=rig(now);r.store.cases.latestClosed=async()=>now-1000;
  await monitorTick(r.store,config(),r.hooks,()=>now);assert.equal(r.saved.length,0);
  assert.deepEqual(r.postponed,[now-1000+86400000]);
});
test('a changed collector health boundary discards in-flight results', async () => {
  const now=Date.now();const r=rig(now);r.hooks.review=async x=>{r.setClean(now);return analyze(x);};
  await monitorTick(r.store,config(),r.hooks,()=>now);assert.equal(r.saved.length,0);
});
test('failed analysis remains retryable instead of being marked completed', async () => {
  const now=Date.now();const r=rig(now);r.hooks.review=async()=>{throw new Error('synthetic');};
  await monitorTick(r.store,config(),r.hooks,()=>now);assert.deepEqual(r.errors,['review']);assert.equal(r.saved.length,0);
  assert.deepEqual(r.postponed,[now+60000]);
});
test('notifications use persisted attempts and mark delivery only after success', async () => {
  const now=Date.now();const r=rig(now);r.store.cases.due=async()=>[];
  r.store.cases.pendingNotices=async()=>[{id:'9',attempts:2}];
  const delivered:string[]=[];r.store.cases.delivered=async(_g,id,message)=>{delivered.push(`${id}:${message}`);};
  r.hooks.notify=async(id,retry)=>{assert.equal(id,'9');assert.equal(retry,true);return 'message';};
  await monitorTick(r.store,config(),r.hooks,()=>now);assert.deepEqual(delivered,['9:message']);
  r.hooks.notify=async()=>{throw new Error('synthetic network failure');};
  await monitorTick(r.store,config(),r.hooks,()=>now);assert.equal(delivered.length,1);assert.deepEqual(r.errors,['notification']);
});
test('cancelled or closed outbox claims are not delivered', async () => {
  const now=Date.now();const r=rig(now);r.store.cases.due=async()=>[];
  r.store.cases.pendingNotices=async()=>[{id:'9',attempts:0}];r.store.cases.beginNotice=async()=>false;
  r.hooks.notify=async()=>{assert.fail('must not send');};await monitorTick(r.store,config(),r.hooks,()=>now);
});
test('PostgreSQL cases: durable queue, replay, stale results, deduplication, resolution, cooldown, erasure', {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const {Store} = await import('../src/store.ts');
  const store = new Store(process.env.TEST_DATABASE_URL!);
  const now=Date.now();const g=`cases-${now}`;const a='subject';
  const input=sample(now,a);input.guildId=g;input.messages.forEach(m=>{m.guildId=g;});
  const report=analyze(input);const opts={now,intervalMs:60000,threshold:60,retentionDays:7};
  try {
    await store.migrate();await store.migrate();
    await store.insert(input.messages[0]!);
    const first=(await store.cases.due(g,Date.now()+1000,25))[0]!;
    await store.insert(input.messages[0]!);
    assert.deepEqual((await store.cases.due(g,Date.now()+1000,25))[0],first,'replayed events do not requeue');
    for (const row of input.messages.slice(1)) await store.insert(row);
    assert.equal(await store.cases.save(g,first,report,opts),'stale');
    const current=(await store.cases.due(g,Date.now()+1000,25))[0]!;
    assert.equal(await store.cases.save(g,current,report,opts),'created');
    const cases=await store.cases.list(g,null);assert.equal(cases.length,1);const id=cases[0]!.id;
    assert.equal((await store.cases.get(g,id))!.authorId,a);assert.equal(await store.cases.get('other',id),null);
    assert.equal((await store.cases.due(g,Date.now()+1000,25)).length,0);
    assert.equal(await store.cases.save(g,current,report,opts),'updated');
    assert.equal((await store.cases.list(g,null)).length,1);
    const notices=await store.cases.pendingNotices(g,Date.now()+1000);assert.equal(notices.length,1);
    assert.equal(await store.cases.beginNotice(g,notices[0]!,now),true);
    assert.equal(await store.cases.beginNotice(g,notices[0]!,now),false);
    await store.cases.delivered(g,id,'discord-message');
    assert.equal((await store.cases.pendingNotices(g,Date.now()+86400000)).length,0);
    assert.equal(await store.cases.resolve(g,id,'moderator','dismissed',now,86400000,7),true);
    assert.equal(await store.cases.resolve(g,id,'moderator','dismissed',now,86400000,7),false);
    assert.equal(await store.cases.save(g,current,report,opts),'stale');
    assert.equal((await store.cases.get(g,id))!.status,'dismissed');
    const fresh=sample(now+7200000,a);fresh.guildId=g;fresh.messages.forEach((m,i)=>{m.guildId=g;m.messageId=`new-${i}`;});
    for (const row of fresh.messages) await store.insert(row);
    const cfg={...config(),guildId:g};
    const hooks:MonitorHooks={cleanSince:()=>now-86400000,channels:async()=>['channel-0','channel-1','channel-2'],
      review:async x=>analyze(x),notify:async()=> 'new-notice',error:()=>assert.fail('unexpected pipeline error')};
    await monitorTick(store,cfg,hooks,()=>now+3600000);
    assert.equal((await store.cases.list(g,null)).length,1,'no new case during cooldown');
    await monitorTick(store,cfg,hooks,()=>now+86400001);
    assert.equal((await store.cases.list(g,null)).length,2,'fresh evidence after cooldown opens a new case');
    assert.equal((await store.cases.stats(g)).open,1);
    await store.forget(g,a);
    assert.equal((await store.cases.list(g,null)).length,0);
    assert.equal((await store.cases.pendingNotices(g,now+100000000)).length,0);
    assert.equal((await store.cases.due(g,now+100000000,25)).length,0);
  } finally {await store.forget(g,a);await store.prune(g,Date.now()+86400000);await store.close();}
});
test('PostgreSQL collector lock permits only one process per guild', {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const {Store} = await import('../src/store.ts');const a=new Store(process.env.TEST_DATABASE_URL!);const b=new Store(process.env.TEST_DATABASE_URL!);
  const g=`lock-${Date.now()}`;
  try {await a.acquireCollectorLock(g,()=>{});await assert.rejects(b.acquireCollectorLock(g,()=>{}),/Another collector/);}
  finally {await a.close();await b.close();}
});
