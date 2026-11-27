export function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function trialStatus(run) {
  if (!run) return null;
  if (typeof run.is_trial === 'boolean') return run.is_trial;
  const flag = String(run.trial_flag ?? '').trim().toUpperCase();
  if (flag === 'NT') return false;
  return /^T\d*$/.test(flag) ? true : null;
}

export function recentStarts(race, history) {
  const used = new Set();
  const starts = [];
  const ordered = [...history].sort((a, b) =>
    String(b.datetime_source ?? '').localeCompare(String(a.datetime_source ?? '')));
  for (const run of ordered) {
    if (run.race_id != null && String(run.race_id) === String(race.id)) continue;
    if (run.datetime_source && race.scheduled_source && run.datetime_source >= race.scheduled_source) continue;
    const result = String(run.position_text ?? '').trim();
    if (Number(run.position) === 18 || /^(?:n\.?\s*r\.?|non[- ]?runner|wd|w\/d|withdrawn|dns|reserve|void|no race)$/i.test(result)) continue;
    const hasOutcome = Boolean(result || positive(run.position) || positive(run.calculated_time_s) || positive(run.sectional_s));
    if (!hasOutcome && trialStatus(run) !== true) continue;
    // The source sometimes repeats the same performance in two form rows.
    const key = run.race_id != null ? String(run.race_id) : (run.datetime_source && run.track_id && run.datetime_source + '/' + run.track_id);
    if (key && used.has(key)) continue;
    if (key) used.add(key);
    starts.push(run);
  }
  return starts;
}
