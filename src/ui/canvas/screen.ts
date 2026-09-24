// Where things are on the editor, in pixels: the viewport turns the timeline's axis into x. The
// renderer and the pointer both place things through here, so a click lands on what is drawn.
import type { App } from '../../app/app';

export interface Screen {
  /** Where the audio at source time t is drawn: transients, the playhead, the loop. */
  xOf(t: number): number;
  /** The source time of the audio drawn at x. */
  tOf(x: number): number;
  /** Where musical position q is drawn: grid lines, bars, pins. */
  xAtPos(q: number): number;
  /** The musical position drawn at x. */
  posOf(x: number): number;
}

/** The editor as it is now. Take a new one after anything changes what is heard or the view. */
export function screen(app: App): Screen {
  const v = app.view, tl = app.timeline;
  return {
    xOf: (t) => v.xOf(tl.axisAt(t)),
    tOf: (x) => tl.sourceAt(v.tOf(x)),
    xAtPos: (q) => v.xOf(tl.axisOfPos(q)),
    posOf: (x) => tl.posAtAxis(v.tOf(x)),
  };
}
