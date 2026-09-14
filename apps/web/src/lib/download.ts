/**
 * Hand the browser bytes to save. A synthetic `<a download>` on a blob URL is the only way a page
 * can do it without a server: there is no file-system API worth relying on across browsers, and the
 * bridge's outputs (`JobsPanel`) are plain URLs it already has.
 *
 * The blob URL is revoked on the next tick — after the click has been dispatched, before the tab
 * accumulates megabytes of them. Firefox needs the anchor to be in the document; Chrome does not.
 */
export function downloadBytes(name: string, bytes: Uint8Array, type = 'application/octet-stream'): void {
  // A fresh ArrayBuffer, because a Uint8Array over a larger buffer (a MEMFS read, a subarray) would
  // otherwise put the whole buffer into the blob.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
