// The Export window: what the step you are in makes, one format at a time, each showing only the options
// that change it and what the file will hold. Transients makes nothing of its own, so there it is off;
// the session, wanted from every step, is beside Open instead (session-panel.ts).
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtBpm, fmtTime, plural } from '../../core/format';
import { VOICES } from '../../core/drums/voices';
import { WARP_MODES, WARP_MODE_INFO, type WarpMode } from '../../core/warp/modes';
import type { Step } from '../../io/session';
import { buildMidi } from '../../io/formats/midi';
import { $, $btn, $in, $sel, setText, setValue } from '../dom';

export const FORMATS = ['midi', 'rpp', 'warpWav', 'slices', 'slicesRpp', 'sliceWav', 'loopWav', 'drumsMidi', 'groove'] as const;
export type ExportFormat = (typeof FORMATS)[number];

/** What each step makes, in the order the window lists it. */
export const STEP_FORMATS: Record<Step, readonly ExportFormat[]> = {
  1: [],
  2: ['midi', 'rpp'],
  3: ['warpWav'],
  4: ['slices', 'slicesRpp', 'sliceWav', 'loopWav'],
  5: ['drumsMidi', 'groove'],
};

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

export function bindExportDialog(app: App, f: Features): (fmt?: ExportFormat) => void {
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
  // What the warp will do: the material's method, the lengths, and how far anything is stretched.
  const warpInfo = () => {
    if (!app.audio) return OPEN_FIRST;
    const p = f.warp.plan();
    if (!p) return { text: app.hasMap ? 'Switch the loop on to warp just the loop.' : 'Set bar 1 and at least a tempo in step 2 first.', ok: false };
    const pct = (r: number) => Math.round(r * 100) + ' %', [lo, hi] = p.ratios;
    let s = WARP_MODE_INFO[app.warp.mode].desc + ' ';
    s += `${p.loop ? 'The loop' : 'The file'}, ${fmtTime(p.srcDur)} → ${fmtTime(p.outDur)} at ${fmtBpm(p.bpm)} BPM, `;
    s += Math.abs(hi - lo) < 0.005 ? `stretched to ${pct(lo)}.` : `stretched ${pct(lo)}–${pct(hi)}.`;
    if (lo < 0.75 || hi > 1.33) s += ' That is a lot of stretch: check the grid tempo, or halve or double the map in step 2.';
    return { text: s, ok: true };
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
    warpWav: {
      desc: 'The audio warped so the tempo map becomes a straight grid: every bar the same length, ready for a DAW at one tempo. The whole file, or just the loop, as the Warp step says.',
      save: 'Save .wav', info: warpInfo, run: () => f.warp.save(),
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
  };

  // The format each step opens on, until you pick another there: its first.
  const byStep: Partial<Record<Step, ExportFormat>> = {};

  // Only this step's formats are listed, and a heading only when something under it is.
  const showStep = (step: Step) => {
    const mine = STEP_FORMATS[step];
    let heading: HTMLElement | null = null, any = false;
    const close = () => { if (heading) heading.hidden = !any; };
    for (const el of Array.from(list.children) as HTMLElement[]) {
      if (el.tagName === 'H3') { close(); heading = el; any = false; continue; }
      const on = mine.includes(el.dataset.fmt as ExportFormat);
      el.hidden = !on;
      any ||= on;
    }
    close();
  };
  let fmt: ExportFormat = 'midi';

  // On a phone the list of formats drops down from a button showing the chosen one.
  const pick = $btn('fmtPick'), list = $('fmtList');
  const listOpen = () => list.classList.contains('open');
  const setList = (open: boolean) => {
    list.classList.toggle('open', open);
    pick.setAttribute('aria-expanded', String(open));
    if (open) {
      // Under the button, and no taller than the window has room for, so the list scrolls inside itself.
      const top = pick.offsetTop + pick.offsetHeight + 4, body = list.parentElement!;
      list.style.top = top + 'px';
      list.style.maxHeight = Math.max(200, body.clientHeight - top - 12) + 'px';
      (list.querySelector('button[aria-pressed="true"]') as HTMLElement | null)?.focus();
    }
  };
  pick.onclick = () => setList(!listOpen());
  // Escape and a press outside close the list before they close the window.
  dlg.addEventListener('cancel', (e) => {
    if (!listOpen()) return;
    e.preventDefault();
    setList(false);
    pick.focus();
  });
  dlg.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (listOpen() && !list.contains(t) && !pick.contains(t)) setList(false);
  });

  const render = () => {
    if (!dlg.open) return;
    const F = formats[fmt], i = F.info();
    dlg.querySelectorAll<HTMLButtonElement>('.fmts button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === fmt)));
    const cur = list.querySelector<HTMLElement>(`button[data-fmt="${fmt}"]`)!;
    setText($('fmtPickNm'), cur.querySelector('.nm')!.textContent!);
    setText($('fmtPickExt'), cur.querySelector('small')!.textContent!);
    setText($('fmtPickSub'), cur.querySelector('.sub')!.textContent!);
    dlg.querySelectorAll<HTMLElement>('.fld').forEach((el) => { el.hidden = !el.dataset.for!.split(' ').includes(fmt); });
    setText($('expDesc'), F.desc);
    setText($('expInfo'), i.text);
    setText($('expSaveL'), F.save);
    $btn('expSave').disabled = !i.ok;
  };
  const choose = (next: ExportFormat) => {
    fmt = next;
    byStep[app.step] = next;
    if (listOpen()) { setList(false); pick.focus(); }
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
  const warpMode = $sel('warpMode'), warpBpm = $in('warpBpm');
  warpMode.onchange = () => f.warp.update({ mode: warpMode.value as WarpMode });
  // An empty tempo follows the audio; anything else is taken if it is a tempo at all.
  warpBpm.onchange = () => {
    const v = warpBpm.value.trim() === '' ? null : +warpBpm.value;
    f.warp.update({ bpm: v != null && Number.isFinite(v) && v >= 20 && v <= 400 ? v : null });
  };
  const syncWarp = () => {
    if ((WARP_MODES as readonly string[]).includes(app.warp.mode)) setValue(warpMode, app.warp.mode);
    const p = f.warp.plan(), auto = p ? Math.round(p.avgBpm) : null;
    if (document.activeElement !== warpBpm) warpBpm.value = app.warp.bpm == null ? '' : String(app.warp.bpm);
    warpBpm.placeholder = auto != null ? String(auto) : '';
    setText($('warpAvg'), p ? `averages ${fmtBpm(p.avgBpm)}` : '');
  };

  const sync = () => {
    const s = app.exportSettings;
    setValue($sel('lead'), s.lead);
    setValue($sel('res'), s.res);
    $in('clicks').checked = s.clicks;
    $in('rppAudio').checked = s.rppAudio;
  };


  app.bus.on('export', sync);
  app.bus.on(['warp', 'doc', 'transport', 'audio', 'export'], syncWarp);
  app.bus.on(['export', 'warp', 'slicer', 'slices', 'doc', 'drums', 'groove', 'transport', 'audio', 'candidates', 'selection'], render);
  sync();
  syncWarp();

  return (next?: ExportFormat) => {
    const mine = STEP_FORMATS[app.step];
    if (!mine.length) return app.notify.toast('Nothing to export from this step. Beats, Slice and Groove each export what they make.');
    // The tempo map needs bar 1, as the Export step did; it starts on the first transient.
    if (app.audio) f.beats.ensureDownbeat();
    fmt = next && mine.includes(next) ? next : byStep[app.step] ?? mine[0];
    showStep(app.step);
    if (!dlg.open) dlg.showModal();
    setList(false);
    render();
    // The chosen format takes the focus: in the list, or on the dropdown's button on a phone.
    const cur = dlg.querySelector('.fmts button[aria-pressed="true"]') as HTMLElement | null;
    if (cur?.offsetParent) cur.focus(); else pick.focus();
  };
}
