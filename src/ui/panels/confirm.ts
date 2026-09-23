// Asking before something that can't be fully taken back. An in-page dialog rather than the browser's
// confirm(), which a host page can block.
import { $ } from '../dom';

/** Shows the question; resolves true on the confirming button, false on Cancel, Escape or the backdrop. */
export function confirmAction(title: string, text: string): Promise<boolean> {
  const dlg = $('confirmDlg') as HTMLDialogElement;
  $('cfTitle').textContent = title;
  $('cfText').textContent = text;
  return new Promise((resolve) => {
    // Answered at the click, not on the close event, which comes a task later; Escape only closes.
    const done = (yes: boolean) => { resolve(yes); dlg.close(); };
    $('cfYes').onclick = () => done(true);
    $('cfNo').onclick = () => done(false);
    dlg.onclick = (e) => { if (e.target === dlg) done(false); };
    dlg.onclose = () => resolve(false);
    dlg.showModal();
    $('cfNo').focus();
  });
}
