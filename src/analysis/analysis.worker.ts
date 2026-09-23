import { InlineAnalyzer } from './analyzer';
import type { Request, Response } from './protocol';

const analyzer = new InlineAnalyzer(false);
const post = (r: Response) => (self as unknown as { postMessage(r: Response): void }).postMessage(r);

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    if (req.type === 'analyze') {
      const analysis = await analyzer.analyze(req.x, req.sr, (fraction) => post({ id: req.id, type: 'progress', fraction }));
      post({ id: req.id, type: 'analysis', analysis });
    } else if (req.type === 'drums') {
      const drums = await analyzer.drums(req.source, (fraction) => post({ id: req.id, type: 'progress', fraction }));
      post({ id: req.id, type: 'drums', drums });
    } else if (req.type === 'warp') {
      const chans = await analyzer.warp(req.job, (fraction) => post({ id: req.id, type: 'progress', fraction }));
      (self as unknown as { postMessage(r: Response, t: Transferable[]): void }).postMessage({ id: req.id, type: 'warp', chans }, chans.map((c) => c.buffer));
    } else {
      post({ id: req.id, type: 'candidates', candidates: await analyzer.candidates(req.band, req.algo) });
    }
  } catch (err) {
    post({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
