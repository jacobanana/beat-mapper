// Bootstraps BeatMapper: builds the app state and its features, binds the UI to them, and runs the
// frame loop. Everything interesting lives in app/ (state and features) and core/ (the audio logic).
import './styles.css';
import { App } from './app/app';
import { createFeatures } from './app/features';
import { isSessionFile } from './app/features/sessions';
import { createAnalyzer } from './analysis/worker-analyzer';
import { EditorRenderer } from './ui/canvas/editor-renderer';
import { $, $in } from './ui/dom';
import { bindKeyboard } from './ui/input/keyboard';
import { PointerInput } from './ui/input/pointer';
import { DomNotifier } from './ui/notifier';
import { bindBeatsPanel } from './ui/panels/beats-panel';
import { bindDetectPanel } from './ui/panels/detect-panel';
import { bindExportPanel } from './ui/panels/export-panel';
import { bindGroovePanel } from './ui/panels/groove-panel';
import { bindHeader } from './ui/panels/header';
import { bindSlicePanel } from './ui/panels/slice-panel';

const safeStorage = (() => { try { return window.localStorage; } catch { return null; } })();

const app = new App(new DomNotifier());
const f = createFeatures(app, createAnalyzer(), safeStorage);

const cv = $('cv') as HTMLCanvasElement, ov = $('ov') as HTMLCanvasElement;
const renderer = new EditorRenderer(cv, ov, app);
const pointer = new PointerInput(cv, ov, app, f, renderer);

// ---------- focus: after a button or a select, keys go back to the waveform ----------
const refocus = () => { if (app.audio) cv.focus({ preventScroll: true }); };
$('panel').addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) refocus(); });
document.querySelector('.top')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b && b.id !== 'helpBtn') refocus();
});
document.querySelectorAll('input[type=range],select').forEach((el) => el.addEventListener('change', refocus));

// ---------- help ----------
const help = $('help') as HTMLDialogElement;
const openHelp = () => { help.showModal(); help.scrollTop = 0; (document.activeElement as HTMLElement | null)?.blur(); };
$('helpClose').onclick = () => help.close();

// ---------- opening files ----------
const fileIn = $in('fileIn');
const open = (file: File) => void (isSessionFile(file) ? f.sessions.import(file) : f.loader.loadFile(file));
const onPick = (e: Event) => {
  const input = e.target as HTMLInputElement, file = input.files && input.files[0];
  if (file) open(file);
  input.value = '';
};
if (matchMedia('(pointer:fine)').matches) fileIn.accept = 'audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.aif,.aiff';
for (const id of ['openBtn', 'chooseBtn']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fileIn.click(); }
  });
}
fileIn.addEventListener('change', onPick);
fileIn.addEventListener('input', onPick);
$('demoBtn').onclick = () => void f.loader.loadDemo();
$('kitDemoBtn').onclick = () => void f.loader.loadKitDemo();
window.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
window.addEventListener('dragleave', () => $('drop').classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) open(file);
});

// ---------- panels and keys ----------
bindHeader(app, f, openHelp);
bindDetectPanel(app, f);
bindBeatsPanel(app, f, refocus);
bindExportPanel(app, f, onPick);
bindSlicePanel(app, f);
const grooveChart = bindGroovePanel(app, f);
bindKeyboard(app, f, { openHelp, openFile: () => fileIn.click(), refocus, canvas: cv });

app.bus.on('audio', () => cv.focus({ preventScroll: true }));
// The panel's height changes with the step, and the canvas with it.
app.bus.on('step', () => setTimeout(() => { renderer.resize(); grooveChart.invalidate(); }, 0));

// ---------- autosave ----------
setInterval(() => f.sessions.autosave(), 1500);
window.addEventListener('pagehide', () => f.sessions.autosave());
document.addEventListener('visibilitychange', () => { if (document.hidden) f.sessions.autosave(); });

// ---------- size, theme, frame loop ----------
new ResizeObserver(() => renderer.resize()).observe($('stage'));
new ResizeObserver(() => grooveChart.invalidate()).observe($('grooveCv'));
window.addEventListener('resize', () => renderer.resize());
const recolor = () => { renderer.recolor(); grooveChart.recolor(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor);
new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.fonts?.ready.then(() => renderer.invalidate());

function frame() {
  f.playback.tick(!pointer.busy);
  pointer.tick();
  renderer.frame();
  requestAnimationFrame(frame);
}
renderer.resize();
requestAnimationFrame(frame);
