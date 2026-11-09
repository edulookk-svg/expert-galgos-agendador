import { appendFileSync } from 'node:fs';

const zone = 'America/Bahia';
const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: zone,
  dateStyle: 'short',
  timeStyle: 'medium',
  hourCycle: 'h23',
});

function completeManifest(manifest, release, date) {
  if (manifest?.format !== 'expert-galgos-data/v1' || manifest.date !== date ||
      release.tag_name !== `galgos-${date}-${manifest.revision}`) return false;

  const { counts, coverage, files, shards } = manifest;
  if (!Number.isSafeInteger(counts?.races) || counts.races <= 0 ||
      !Number.isSafeInteger(counts?.dogs) || counts.dogs <= 0 ||
      coverage?.individual_endpoint !== counts.dogs || !files?.['index.json'] || !shards) return false;

  const paths = Object.keys(files);
  if (paths.filter(path => /^races\/\d+\.json$/.test(path)).length !== counts.races ||
      paths.filter(path => /^dogs\/\d+\.json$/.test(path)).length !== counts.dogs ||
      paths.length !== counts.races + counts.dogs + 1) return false;

  const assets = new Map(release.assets.filter(asset => asset.state === 'uploaded').map(asset => [asset.name, asset.id]));
  return Object.values(files).every(name => {
    const shard = shards[name];
    return /^part-\d+\.json$/.test(name) && Number.isSafeInteger(shard?.asset_id) &&
      assets.get(name) === shard.asset_id && /^[a-f0-9]{64}$/.test(shard.sha256 || '');
  });
}

async function check() {
  const { PRIVATE_REPO, PRIVATE_TOKEN, REQUESTED_DATE, GITHUB_STEP_SUMMARY } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(PRIVATE_REPO || '') || !PRIVATE_TOKEN) throw new Error('Configuração ausente');
  const date = REQUESTED_DATE || clock.format(new Date()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Data inválida');
  const root = 'https://api.github.com/repos/' + PRIVATE_REPO;

  async function request(path, asset = false) {
    const options = { redirect: 'manual', signal: AbortSignal.timeout(25_000) };
    let response = await fetch(root + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + PRIVATE_TOKEN,
        Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
        'User-Agent': 'ExpertGalgos-Readiness',
      },
    });
    if (asset && response.status === 302) {
      const url = new URL(response.headers.get('location'));
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.githubusercontent.com') || url.username || url.password || url.port) throw new Error('Redirecionamento inválido');
      response = await fetch(url, options);
    }
    if (!response.ok) throw new Error('Publicação indisponível');
    return response.json();
  }

  if ((await request('')).private !== true) throw new Error('Repositório deve ser privado');
  const releases = await request('/releases?per_page=30');
  for (const release of releases) {
    if (release.draft || release.body !== 'expert-galgos-data/v1' ||
        !new RegExp(`^galgos-${date}-[a-f0-9-]{36}$`).test(release.tag_name || '') ||
        !Number.isFinite(Date.parse(release.published_at)) ||
        clock.format(new Date(release.published_at)) > `${date} 07:00:00`) continue;
    const asset = release.assets.find(item => item.name === 'manifest.json' && item.state === 'uploaded');
    if (!Number.isSafeInteger(asset?.id)) continue;
    if (completeManifest(await request('/releases/assets/' + asset.id, true), release, date)) {
      appendFileSync(GITHUB_STEP_SUMMARY, 'Programação completa publicada dentro do prazo das 7h da Bahia.\n');
      return;
    }
  }

  appendFileSync(GITHUB_STEP_SUMMARY, 'Programação completa ainda não confirmada para o prazo das 7h da Bahia.\n');
  process.exitCode = 1;
}

check().catch(() => {
  console.error('O agendador não conseguiu conferir a publicação privada.');
  process.exitCode = 1;
});
