import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {recentStarts,positive,trialStatus} from '../public/vendor/recent-starts.js';

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

const textKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^0+/,'');
const formLines = dog => (dog.forms || []).map(f => ({
  date:f.raceTime, track:String(f.trackId), trap:String(f.trap), race:f.raceId ? String(f.raceId) : null
}));
const identity = dog => [dog.dogId,dog.dogName,dog.dateOfBirth,dog.sire,dog.dam].map(textKey);
const profileContext = dog => createHash('sha256').update(JSON.stringify([identity(dog),formLines(dog)])).digest('hex');

function performance(row, dogId) {
  return {
    dog_id:dogId, race_id:row.rInstId || null, datetime_source:row.raceTime, track_id:row.trackId || null,
    track_short_name:row.trackShortName, distance_m:positive(row.distMetre), grade:row.rGradeCde || null,
    trap:positive(row.trapNum), trial_flag:row.trialFlag, is_trial:row.trialFlag ? row.trialFlag.startsWith('T') : null,
    position:positive(row.rOutcomeId), position_text:row.rOutcomeDesc, sectional_s:positive(row.secTimeS),
    calculated_time_s:positive(row.calcRTimeS), winner_time_s:positive(row.winnersTimeS), weight_kg:positive(row.dWeightKgs),
    bend_positions:row.bndPos, margin_source:row.rpDistDesc, going:row.goingType,
    remarks:row.closeUpCmnt || row.remarks || null, handicap_m:row.handicapMetre,
    winner_or_second:row.otherDTxt || row.otherDogName, winner_or_second_handicap:row.otherDHandicapMetre,
    date_label:row.resultDate || row.shortDate
  };
}

export function recentProfile(race,dog,raw,metadata) {
  const info=raw?.details?.dogInfo, forms=raw?.details?.forms;
  if (!info || !Array.isArray(forms) || !metadata?.current_forms || metadata.context_validation?.identity !== 'id_name_birth_sire_dam') return null;
  const expected=identity(dog);
  const actual=[info.dogId,info.dogName,info.dateOfBirth,info.sireName,info.damName].map(textKey);
  if (expected.some((v,i)=>v!==actual[i]) || JSON.stringify(formLines(dog))!==JSON.stringify(metadata.current_forms)) return null;
  const at=Date.parse(metadata.fetched_at);
  if (!Number.isFinite(at)) return null;
  const starts=recentStarts({id:String(race.raceId),scheduled_source:race.raceDate},forms
    .filter(row=>typeof row?.raceTime==='string')
    .map(row=>performance(row,String(dog.dogId))));
  const history=starts.slice(0,10);
  const previous=starts.find(row=>trialStatus(row)===false);
  const profile={context:profileContext(dog),at,history_scope:'individual_endpoint_window',history};
  if (previous && !history.includes(previous)) profile.previousOfficial=previous;
  return profile;
}

async function readProfile(folder,race,dog) {
  const file=path.join(folder,'dog-'+dog.dogId+'.json');
  try {
    const [source,metadata]=await Promise.all([fs.readFile(file,'utf8'),fs.readFile(file+'.meta.json','utf8')]);
    return recentProfile(race,dog,JSON.parse(source),JSON.parse(metadata));
  } catch (error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
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
      const profiles = {};
      await Promise.all(card.data.form.dogs.filter(dog=>/^[1-9]\d*$/.test(String(dog.dogId))).map(async dog=>{
        const profile=await readProfile(folder,race,dog);
        if (profile) profiles[dog.dogId]=profile;
      }));
      if (Object.keys(profiles).length) card.profiles=profiles;
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
    const old=cards[id];
    if (!old) { cards[id]=record; continue; }
    const selected=record.at >= old.at ? record : old;
    const merged={...selected};
    delete merged.profiles;
    const profiles={};
    for (const dog of selected.data.form?.dogs || []) {
      const candidates=[old.profiles?.[dog.dogId],record.profiles?.[dog.dogId]].filter(Boolean);
      if (!candidates.length) continue;
      const context=profileContext(dog);
      const profile=candidates.filter(p=>p.context===context).sort((a,b)=>b.at-a.at)[0];
      if (profile) profiles[dog.dogId]=profile;
    }
    if (Object.keys(profiles).length) merged.profiles=profiles;
    cards[id]=merged;
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
