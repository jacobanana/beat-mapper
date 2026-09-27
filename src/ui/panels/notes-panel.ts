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
    // The views and their partials only matter while the spectrogram is shown.
    for (const id of ['nView', 'nHarm', 'nRange']) $(id).closest('label, select')!.toggleAttribute('hidden', !s.spec);
    $in('nHarm').disabled = s.view === 'audio';
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
