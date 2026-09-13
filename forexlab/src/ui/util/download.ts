/** One place for saving generated text files to disk (drawings, trades, sessions). */

export function downloadText(fileName: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a picked file as text; returns null when the read fails or it is empty. */
export async function readTextFile(file: File): Promise<string | null> {
  try {
    const text = await file.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
