// Hidden page that reads a PDF's page count and page size with pdf.js, for preflight.
import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

window.probe.onRequest(async ({ token, data, thumbWidth }) => {
  try {
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    let thumb = null;
    if (thumbWidth) {
      // First page as a small JPEG, for the cue buttons.
      const tvp = page.getViewport({ scale: thumbWidth / vp.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(tvp.width);
      canvas.height = Math.round(tvp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: tvp, background: '#ffffff' }).promise;
      thumb = canvas.toDataURL('image/jpeg', 0.8);
    }
    window.probe.reply({ token, pages: doc.numPages, width: vp.width, height: vp.height, thumb });
    doc.destroy();
  } catch (e) {
    window.probe.reply({ token, error: e.name === 'PasswordException' ? 'password' : e.message });
  }
});
