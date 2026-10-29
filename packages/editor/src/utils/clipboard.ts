/** Copies text to the clipboard; false when the browser refuses (no permission, insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** How long a downloaded file's blob URL is kept before it is freed. */
export const BLOB_URL_LIFETIME_MS = 5_000;

/** Saves `text` as a file the user downloads (e.g. recovery codes as `.txt`). */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Freed a while after the click: some browsers (Safari, older Firefox) start reading the file only
  // after the click handler, so revoking at once could cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
}
