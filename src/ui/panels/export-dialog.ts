// The Export window: every file BeatMapper saves, one format at a time, each showing only the options
// that change it and what the file will hold. It opens on the format that fits the step you are in.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtBpm, fmtTime, plural } from '../../core/format';
import { VOICES } from '../../core/drums/voices';
import type { Step } from '../../io/session';
import { buildMidi } from '../../io/formats/midi';
import { $, $btn, $in, $sel, setText, setValue } from '../dom';

export const FORMATS = ['midi', 'rpp', 'slices', 'slicesRpp', 'sliceWav', 'loopWav', 'drumsMidi', 'groove', 'session'] as const;
export type ExportFormat = (typeof FORMATS)[number];

interface Format {
  desc: string;
  /** What the save button says. */
  save: string;
  /** What the file will hold, and whether there is anything to save yet. */
  info(): { text: string; ok: boolean };
  run(): Promise<void>;
}

const OPEN_FIRST = { text: 'Open an audio file first.', ok: false };
const kb = (b: number) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

export function bindExportDialog(app: App, f: Features, onPick: (e: Event) => void): (fmt?: ExportFormat) => void {
  const dlg = $('exportDlg') as HTMLDialogElement;

  // How much tempo map there is, and where to put the audio in the DAW.
  const mapInfo = () => {
    if (!app.audio) return OPEN_FIRST;
    if (!app.hasMap) return { text: 'Set bar 1 and at least a tempo in step 2 first.', ok: false };
    try {
      const o = f.exports.options(), { info, bytes } = buildMidi(o), { num, den } = app.doc.meter;
      let s = `${plural(info.count, 'tempo change')}, ${info.minB.toFixed(1)}–${info.maxB.toFixed(1)} BPM, ${num}/${den}, ${(bytes.length / 1024).toFixed(1)} KB. `;
      if (o.trimmed) s += `Trim the audio so it starts at ${fmtTime(info.t0)} and put it on bar 1.`;
      else if (info.leadBpm) {
        s += `Put the audio at the very start of the project; the first downbeat lands on bar ${info.leadBars + 1}.`;
        if (info.leadBpm > info.songBpm * 2.4) s += ` The lead-in is only ${(info.t0 * 1000).toFixed(0)} ms, so its tempo is ${info.leadBpm.toFixed(0)} BPM – trimming may be cleaner.`;
      } else s += 'Put the audio at bar 1.';
      return { text: s, ok: true };
    } catch {
      return { text: 'Set bar 1 and at least a tempo in step 2 first.', ok: false };
    }
  };
  const slicesInfo = () => {
    if (!app.audio) return OPEN_FIRST;
    const S = app.slices, on = S.filter((x) => !x.off).length, L = app.loopInfo;
    if (!S.length) return { text: 'No slices yet – add transients in step 1.', ok: false };
    if (!on) return { text: 'Every slice is dropped – keep some in step 4.', ok: false };
    return {
      text: `${on} of ${plural(S.length, 'slice')} · zip about ${kb(f.slicer.zipEstimate())}`
        + (L ? ` · loop only: ${plural(L.bars, 'bar')} at ${fmtBpm(L.bpm)} BPM` : ''),
      ok: true,
    };
  };
  const drumsInfo = (what: () => string) => {
    if (!app.audio) return OPEN_FIRST;
    if (!app.drums) return { text: 'Open the Groove step (5) to find the drums first.', ok: false };
    const g = app.pocket;
    if (!g || !g.hits.length) return { text: 'No drums measured yet – map the beats in step 2.', ok: false };
    return { text: what(), ok: true };
  };

  const formats: Record<ExportFormat, Format> = {
    midi: {
      desc: 'The tempo map as a MIDI file, for any DAW that reads tempo from MIDI.',
      save: 'Save .mid', info: mapInfo, run: () => f.exports.saveMidi(),
    },
    rpp: {
      desc: 'A REAPER project with the tempo map and the audio in place.',
      save: 'Save REAPER project', info: mapInfo, run: () => f.exports.saveRpp(),
    },
    slices: {
      desc: 'Every kept slice as a .wav, in one .zip.',
      save: 'Save .zip', info: slicesInfo, run: () => f.slicer.exportZip(false),
    },
    slicesRpp: {
      desc: 'Every kept slice as a .wav, with a REAPER project holding each one where it was cut from.',
      save: 'Save .zip', info: slicesInfo, run: () => f.slicer.exportZip(true),
    },
    sliceWav: {
      desc: 'The selected slice on its own.',
      save: 'Save .wav',
      info: () => {
        if (!app.audio) return OPEN_FIRST;
        const S = app.slices, i = app.sliceIndex ?? 0, sl = S[i];
        if (!sl) return { text: 'No slices yet – add transients in step 1.', ok: false };
        return { text: `Slice ${i + 1} of ${S.length} · ${fmtTime(sl.t0)} · ${Math.round((sl.t1 - sl.t0) * 1000)} ms`, ok: true };
      },
      run: () => f.slicer.saveSelectedWav(),
    },
    loopWav: {
      desc: 'The loop as one .wav, named with its bars and BPM. No fades, so it loops seamlessly.',
      save: 'Save .wav',
      info: () => {
        if (!app.audio) return OPEN_FIRST;
        const L = app.loopInfo;
        if (!L) return { text: 'Switch the loop on first – drag in the top strip to draw one.', ok: false };
        return { text: `${plural(L.bars, 'bar')} at ${fmtBpm(L.bpm)} BPM · ${fmtTime(L.a)}–${fmtTime(L.b)}`, ok: true };
      },
      run: () => f.slicer.saveLoopWav(),
    },
    drumsMidi: {
      desc: 'The kick, snare and hats as MIDI: every hit where it was played, on the tempo map.',
      save: 'Save .mid',
      info: () => drumsInfo(() => {
        const h = app.pocket!.hits;
        return plural(h.length, 'note') + ' · ' + VOICES.map((v) => `${v} ${h.filter((x) => x.voice === v).length}`).join(', ');
      }),
      run: () => f.groove.saveMidi(),
    },
    groove: {
      desc: 'The typical bar as a Pocket Science groove file.',
      save: 'Save .json', info: () => drumsInfo(() => f.groove.summary()), run: () => f.groove.saveGroove(),
    },
    session: {
      desc: 'Markers, pins and settings, without the audio. Open it, then the same audio, to carry the work to another device.',
      save: 'Save session',
      info: () => (app.audio ? { text: 'For ' + app.audio.name, ok: true } : { text: 'Open an audio file to save its session. A session file can be opened any time.', ok: false }),
      run: () => f.sessions.export(),
    },
  };

  // The format each step opens on, until you pick another there.
  const byStep: Partial<Record<Step, ExportFormat>> = { 1: 'midi', 2: 'midi', 4: 'slices', 5: 'drumsMidi' };
  let fmt: ExportFormat = 'midi';

  const render = () => {
    if (!dlg.open) return;
    const F = formats[fmt], i = F.info();
    dlg.querySelectorAll<HTMLButtonElement>('.fmts button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === fmt)));
    dlg.querySelectorAll<HTMLElement>('.fld').forEach((el) => { el.hidden = !el.dataset.for!.split(' ').includes(fmt); });
    setText($('expDesc'), F.desc);
    setText($('expInfo'), i.text);
    setText($('expSaveL'), F.save);
    $btn('expSave').disabled = !i.ok;
  };
  const choose = (next: ExportFormat) => {
    fmt = next;
    byStep[app.step] = next;
    render();
  };
  dlg.querySelectorAll<HTMLButtonElement>('.fmts button').forEach((b) => { b.onclick = () => choose(b.dataset.fmt as ExportFormat); });

  // The window closes first, so the toast and progress the save shows aren't hidden behind it.
  $('expSave').onclick = () => {
    if (!formats[fmt].info().ok) return;
    dlg.close();
    void formats[fmt].run();
  };
  $('expClose').onclick = () => dlg.close();
  $('expCancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  // The tempo map's options; the slicer's are bound with the Slice step's (data-slicer).
  $sel('lead').onchange = (e) => app.set('export', { lead: (e.target as HTMLSelectElement).value === 'trim' ? 'trim' : 'full' });
  $sel('res').onchange = (e) => app.set('export', { res: (e.target as HTMLSelectElement).value as 'pins' | 'bar' | 'beat' });
  $in('clicks').onchange = (e) => app.set('export', { clicks: (e.target as HTMLInputElement).checked });
  $in('rppAudio').onchange = (e) => app.set('export', { rppAudio: (e.target as HTMLInputElement).checked });
  const sync = () => {
    const s = app.exportSettings;
    setValue($sel('lead'), s.lead);
    setValue($sel('res'), s.res);
    $in('clicks').checked = s.clicks;
    $in('rppAudio').checked = s.rppAudio;
  };

  $in('sessIn').addEventListener('change', (e) => { dlg.close(); onPick(e); });
  if (matchMedia('(pointer:fine)').matches) $in('sessIn').accept = '.json,application/json';
  $('sessOpen').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); $in('sessIn').click(); }
  });

  app.bus.on('export', sync);
  app.bus.on(['export', 'slicer', 'slices', 'doc', 'drums', 'groove', 'transport', 'audio', 'candidates', 'selection'], render);
  sync();

  return (next?: ExportFormat) => {
    // The tempo map needs bar 1, as the Export step did; it starts on the first transient.
    if (app.audio) f.beats.ensureDownbeat();
    fmt = next ?? byStep[app.step] ?? 'midi';
    if (!dlg.open) dlg.showModal();
    render();
    (dlg.querySelector('.fmts button[aria-pressed="true"]') as HTMLElement | null)?.focus();
  };
}
