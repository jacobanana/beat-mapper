// Step 6 – Notes: whether the piano roll takes the waveform's place, what the audio is played as (a line, chords, or by hand), how much is let through,
// the spectrogram under the piano roll and how it is shown, how long notes are held, the synth voice,
// the pencil, and the piano roll. The MIDI is saved from the Export window.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import type { SpecView } from '../../core/notes/spectrogram';
import type { NoteInstrument, NoteMode } from '../../core/notes/types';
import { STEP } from '../../state/steps';
import { PianoRoll } from '../canvas/piano-roll';
import { $, $btn, $in, $sel, setPressed, setText, setValue } from '../dom';

export function bindNotesPanel(app: App, f: Features): PianoRoll {
  const nt = f.notes;
  $sel('nMode').onchange = (e) => void nt.setMode((e.target as HTMLSelectElement).value as NoteMode);
  $sel('nInst').onchange = (e) => void nt.setInstrument((e.target as HTMLSelectElement).value as NoteInstrument);
  $in('nSens').oninput = (e) => nt.setSensitivity(+(e.target as HTMLInputElement).value);
  $('nMainWave').onclick = () => nt.setMain('wave');
  $('nMainRoll').onclick = () => nt.setMain('roll');
  $('nSpec').onclick = () => nt.toggleSpectrogram();
  $sel('nView').onchange = (e) => nt.setView((e.target as HTMLSelectElement).value as SpecView);
  $in('nHarm').oninput = (e) => nt.setHarmonics(+(e.target as HTMLInputElement).value);
  $in('nRange').oninput = (e) => nt.setRange(+(e.target as HTMLInputElement).value);
  $('nShow').onclick = () => nt.toggleNotes();
  // The filters run over the whole take, a moment's work each: the number follows the finger and the
  // picture is redrawn where the slider is let go.
  const labels = { nSteady: (v: number) => (v ? String(v) : 'off'), nFloor: (v: number) => (v ? v + ' dB' : 'off'), nMinLen: (v: number) => (v ? v + ' ms' : 'off'), nVoices: String };
  const keys = { nSteady: 'steady', nFloor: 'floor', nMinLen: 'minLen', nVoices: 'voices' } as const;
  for (const id of Object.keys(keys) as (keyof typeof keys)[]) {
    $in(id).oninput = (e) => setText($(id + 'O'), labels[id](+(e.target as HTMLInputElement).value));
    $in(id).onchange = (e) => nt.setFilter({ [keys[id]]: +(e.target as HTMLInputElement).value });
  }
  $('nEven').onclick = () => nt.setFilter({ even: !app.notes.filter.even });
  $('nPeaks').onclick = () => nt.setFilter({ peaks: !app.notes.filter.peaks });
  $('nSnap').onclick = () => nt.setFilter({ snap: !app.notes.filter.snap });
  $('nFilterReset').onclick = () => nt.resetFilter();
  $('nLegato').onclick = () => nt.toggleLegato();
  $('nSynth').onclick = () => nt.toggleSynth();
  $('nDraw').onclick = () => nt.toggleDraw();
  $('nDel').onclick = () => nt.removeSelected();

  const cv = $('notesCv') as HTMLCanvasElement, slot = cv.parentElement!;
  const roll = new PianoRoll(cv, app, f);
  // The roll is one canvas, moved rather than drawn twice: into the stage over the waveform, which
  // keeps its size underneath so the view's width and zoom stay what they were, or back beside the
  // controls. Only in this step: the others keep the waveform.
  const place = () => {
    const big = app.step === STEP.notes && app.notes.main === 'roll';
    $('stage').classList.toggle('roll', big);
    slot.hidden = big;
    if (big !== (cv.parentElement !== slot)) {
      if (big) $('cv').after(cv); else slot.append(cv);
      roll.invalidate();
    }
  };
  const sync = () => {
    const s = app.notes;
    setValue($sel('nMode'), s.mode);
    setValue($sel('nInst'), s.instrument);
    // The instrument only shapes how chords are found.
    $sel('nInst').hidden = s.mode !== 'chords';
    setValue($in('nSens'), s.sens);
    // By hand, nothing is found for the sensitivity to pick among.
    ($in('nSens').parentElement as HTMLElement).hidden = s.mode === 'draw';
    setPressed($('nMainWave'), s.main === 'wave');
    setPressed($('nMainRoll'), s.main === 'roll');
    place();
    setPressed($('nSpec'), s.spec);
    setValue($sel('nView'), s.view);
    setValue($in('nHarm'), s.harmonics);
    setText($('nHarmO'), String(s.harmonics));
    setValue($in('nRange'), s.range);
    setText($('nRangeO'), s.range + ' dB');
    setPressed($('nShow'), s.showNotes);
    const f = s.filter;
    for (const id of Object.keys(keys) as (keyof typeof keys)[]) {
      setValue($in(id), f[keys[id]]);
      setText($(id + 'O'), labels[id](f[keys[id]]));
    }
    setPressed($('nEven'), f.even);
    setPressed($('nPeaks'), f.peaks);
    setPressed($('nSnap'), f.snap);
    // The views, their partials and the filters only matter while the spectrogram is shown.
    for (const id of ['nView', 'nHarm', 'nRange']) $(id).closest('label, select')!.toggleAttribute('hidden', !s.spec);
    $('nLab').hidden = !s.spec;
    $in('nHarm').disabled = s.view === 'audio';
    ($in('nVoices').parentElement as HTMLElement).hidden = s.view !== 'notes';
    setPressed($('nLegato'), s.legato);
    setPressed($('nDraw'), s.draw);
    $('notesCv').classList.toggle('draw', s.draw);
  };
  const synth = () => setPressed($('nSynth'), !app.mute.notes);
  const edits = () => { $btn('nDel').disabled = !app.selectedNote(); };
  const counts = () => {
    setText($('nN'), app.transcript ? String(app.pickedNotes.length) : '');
    setText($('nSum'), nt.summary());
  };
  app.bus.on('notes', sync);
  app.bus.on('step', place);
  app.bus.on('mute', synth);
  app.bus.on(['doc', 'selection', 'transcript', 'notes'], edits);
  app.bus.on(['notes', 'transcript', 'doc', 'audio'], counts);
  sync();
  synth();
  edits();
  return roll;
}
