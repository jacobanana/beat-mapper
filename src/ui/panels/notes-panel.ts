// Step 6 – Notes: what the audio is played as (a line or chords), how much is let through, how long
// notes are held, the synth voice, and the piano roll. The MIDI is saved from the Export window.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import type { NoteInstrument, NoteMode } from '../../core/notes/types';
import { PianoRoll } from '../canvas/piano-roll';
import { $, $btn, $in, $sel, setPressed, setText, setValue } from '../dom';

export function bindNotesPanel(app: App, f: Features): PianoRoll {
  const nt = f.notes;
  $sel('nMode').onchange = (e) => void nt.setMode((e.target as HTMLSelectElement).value as NoteMode);
  $sel('nInst').onchange = (e) => void nt.setInstrument((e.target as HTMLSelectElement).value as NoteInstrument);
  $in('nSens').oninput = (e) => nt.setSensitivity(+(e.target as HTMLInputElement).value);
  $('nLegato').onclick = () => nt.toggleLegato();
  $('nSynth').onclick = () => nt.toggleSynth();
  $('nDel').onclick = () => nt.removeSelected();

  const roll = new PianoRoll($('notesCv') as HTMLCanvasElement, app, f);
  const sync = () => {
    const s = app.notes;
    setValue($sel('nMode'), s.mode);
    setValue($sel('nInst'), s.instrument);
    // The instrument only shapes how chords are found.
    $sel('nInst').hidden = s.mode !== 'chords';
    setValue($in('nSens'), s.sens);
    setPressed($('nLegato'), s.legato);
  };
  const synth = () => setPressed($('nSynth'), !app.mute.notes);
  const edits = () => { $btn('nDel').disabled = !app.selectedNote(); };
  const counts = () => {
    setText($('nN'), app.transcript ? String(app.pickedNotes.length) : '');
    setText($('nSum'), nt.summary());
  };
  app.bus.on('notes', sync);
  app.bus.on('mute', synth);
  app.bus.on(['doc', 'selection', 'transcript', 'notes'], edits);
  app.bus.on(['notes', 'transcript', 'doc', 'audio'], counts);
  sync();
  synth();
  edits();
  return roll;
}
