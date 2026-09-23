// Saving a file from the page. Inside a host that offers a downloads bridge (window.claude, when the
// app runs as a claude.ai artifact) that is used; everywhere else a plain download link.

interface DownloadBridge { save(o: { filename: string; data: Blob | Uint8Array | string }): Promise<void> }
type Host = { claude?: { use?: (name: string) => Promise<DownloadBridge> } };

let bridge: Promise<DownloadBridge | null> | null = null;
function downloadBridge(): Promise<DownloadBridge | null> {
  if (!bridge) {
    const host = (typeof window !== 'undefined' ? window : {}) as Host;
    bridge = host.claude && typeof host.claude.use === 'function' ? host.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  }
  // Don't hang on a bridge that never answers.
  return Promise.race([bridge, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
}

export type SaveResult = { ok: true; bridged: boolean } | { ok: false; code: 'declined' | 'too_large' | 'failed' };

/** Whether saves go through a host bridge (which may want a different packaging). */
export async function hasBridge(): Promise<boolean> {
  return (await downloadBridge()) != null;
}

export async function saveFile(filename: string, data: BlobPart, mime: string): Promise<SaveResult> {
  const dl = await downloadBridge();
  const blob = new Blob([data], { type: mime });
  if (dl) {
    try {
      await dl.save({ filename, data: blob });
      return { ok: true, bridged: true };
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      return { ok: false, code: code === 'declined' ? 'declined' : code === 'too_large' ? 'too_large' : 'failed' };
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  return { ok: true, bridged: false };
}

/** The user-facing message for a failed save. */
export function saveError(code: 'declined' | 'too_large' | 'failed', tooLarge: string): string {
  return code === 'declined' ? 'Save cancelled.' : code === 'too_large' ? tooLarge : "This viewer couldn't save the file.";
}
