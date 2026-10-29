import { getDocumentFile, loadLibrary } from './library.mjs';

const frame = document.querySelector('#document-frame');
const status = document.querySelector('#reader-status');
const fullscreen = document.querySelector('#document-fullscreen');

try {
  const id = new URLSearchParams(location.search).get('document');
  const file = await getDocumentFile(id);
  const entry = (await loadLibrary()).find(document => document.id === id);
  document.querySelector('#document-title').textContent = entry.title;
  document.title = `${entry.title} / Kirill Gelvan`;
  document.querySelector('#document-source').href = entry.source_url;
  document.querySelector('#document-open').href = file;
  document.querySelector('#document-download').href = file;
  document.querySelector('#document-download').download = `${entry.id}.pdf`;
  document.querySelector('.reader-header nav').hidden = false;
  frame.title = entry.title;
  const viewer = new URL('./vendor/pdfjs/web/viewer.html', import.meta.url);
  viewer.searchParams.set('document', id);
  viewer.hash = entry.kind === 'talk' ? 'zoom=page-fit' : 'zoom=page-width';
  frame.src = viewer.href;
  frame.hidden = false;
  status.hidden = true;
  fullscreen.hidden = !document.fullscreenEnabled;
} catch (error) {
  status.textContent = `${error.message} Return to Work to choose one.`;
}

fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    status.textContent = 'Fullscreen is unavailable here. You can open the PDF in its own tab.';
    status.hidden = false;
  }
});

document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});
