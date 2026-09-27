// Getting a print out of the browser: a PNG file, the share sheet, or real paper.

/** Save the strip (×4, whole pixels) as a file. */
export function download(png: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(png);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The system share sheet (iPhone, Android, Safari, Edge); a download where files can't be shared. */
export async function share(png: Blob, name: string, title: string) {
  const file = new File([png], name, { type: 'image/png' });
  if (!navigator.canShare?.({ files: [file] })) { download(png, name); return; }
  try { await navigator.share({ files: [file], title }); } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) download(png, name);
  }
}

/** Print the strip on real paper: a print-only sheet over the page, removed once the dialog closes. */
export function printOut(png: Blob, caption: string) {
  document.getElementById('pt-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.id = 'pt-sheet';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(png);
  img.alt = caption;
  const p = document.createElement('p');
  p.textContent = caption;
  sheet.append(img, p);
  document.body.append(sheet);
  const done = () => { sheet.remove(); URL.revokeObjectURL(img.src); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  img.decode().catch(() => {}).then(() => window.print());
}

/** A stored 1× print scaled up by whole pixels (nearest neighbour), as a PNG. */
export async function upscale(png: Blob, scale: number): Promise<Blob> {
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bmp.width * scale; c.height = bmp.height * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('PNG encoding failed'))), 'image/png'));
}
