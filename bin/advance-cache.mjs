import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const ref = 'codex/advance-cards';
const shaOf = text => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
const encode = (date, rows) => JSON.stringify({date, gzip:gzipSync(JSON.stringify(rows)).toString('base64')});
const decode = (date, content) => {
  const stored = JSON.parse(content);
  return stored.date === date ? JSON.parse(gunzipSync(Buffer.from(stored.gzip,'base64'))) : {};
};

async function record(file) {
  const [s, text] = await Promise.all([fs.stat(file), fs.readFile(file,'utf8')]);
  return {at:Math.floor(s.mtimeMs), data:JSON.parse(text)};
}

export async function readCheckpoint(work, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date+'T12:00Z').toISOString().slice(0,10) !== date) throw Error('Invalid date');
  const folder = path.join(work,'data',date,'raw');
  const index = await record(path.join(folder,'meetings.json'));
  const sessions = index.data.list?.items;
  if (!sessions?.length || !sessions.every(m => Array.isArray(m.races) && m.races.every(r => String(r.raceDate).startsWith(date)))) throw Error('Invalid meeting list');
  const files = new Map([['index',index]]);
  for (const session of sessions) {
    for (const race of session.races) {
      const id = String(race.raceId), track = String(race.trackId || session.track_id);
      if (!/^\d+$/.test(id) || !/^\d+$/.test(track)) continue;
      let card;
      try { card = await record(path.join(folder,'race-'+id+'.json')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!card.data['card-title'] || !Array.isArray(card.data.card?.dogs) || !Array.isArray(card.data.form?.dogs)) continue;
      const name = 'track-'+track;
      if (!files.has(name)) files.set(name,{});
      files.get(name)[id] = card;
    }
  }
  return files;
}

// Merge a checkpoint with the previously saved cards for this track. Parallel
// bootstraps and resumed jobs may have received different races from the source.
export function mergeCheckpoint(date, name, fresh, previousText) {
  if (previousText && JSON.parse(previousText).date > date) return previousText;
  const prior = previousText ? decode(date,previousText) : {};
  if (name === 'index') return encode(date, prior.at > fresh.at ? prior : fresh);
  const cards = {...prior};
  for (const [id, record] of Object.entries(fresh)) {
    if (!cards[id] || record.at >= cards[id].at) cards[id] = record;
  }
  return encode(date,cards);
}

export async function publishCheckpoint({repo,token,work,date,fetcher=fetch}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !token) throw Error('Missing private feed configuration');
  async function api(suffix,method='GET',body) {
    const response = await fetcher('https://api.github.com/repos/'+repo+suffix,{
      method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ExpertGalgos-Collector'},
      body:body ? JSON.stringify(body) : undefined,redirect:'error',signal:AbortSignal.timeout(25000)
    });
    if (!response.ok) throw Error('Private checkpoint HTTP '+response.status+' '+method);
    return response.json();
  }
  if ((await api('')).private !== true) throw Error('Private checkpoint repository required');
  let files;
  try { files = await readCheckpoint(work,date); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const slot = new Date(date+'T12:00Z').getUTCDay();
  const head = (await api('/git/ref/heads/'+ref)).object.sha;
  const commit = await api('/git/commits/'+head);
  const base = await api('/git/trees/'+commit.tree.sha+'?recursive=1');
  if (base.truncated) throw Error('Incomplete checkpoint tree');
  const prior = new Map(base.tree.map(e=>[e.path,e.sha]));
  const changes = [];
  for (const [name, value] of files) {
    const target = 'advance/'+slot+'/'+name+'.json', before = prior.get(target);
    let content = mergeCheckpoint(date,name,value,null);
    if (shaOf(content) === before) continue;
    if (before) {
      const blob = await api('/git/blobs/'+before);
      content = mergeCheckpoint(date,name,value,Buffer.from(blob.content,'base64').toString('utf8'));
      if (shaOf(content) === before) continue;
    }
    changes.push({path:target,mode:'100644',type:'blob',content});
  }
  if (!changes.length) return 0;
  const tree = await api('/git/trees','POST',{base_tree:commit.tree.sha,tree:changes});
  const next = await api('/git/commits','POST',{message:'Atualiza prévia de '+date,tree:tree.sha,parents:[head]});
  await api('/git/refs/heads/'+ref,'PATCH',{sha:next.sha,force:false});
  return changes.length;
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const count=await publishCheckpoint({repo:process.env.PRIVATE_REPO,token:process.env.PRIVATE_TOKEN,work:process.env.GALGOS_WORK,date:process.env.TARGET_DATE});
  console.log(count+' arquivos de prévia atualizados.');
}
