export function shareConcertImage(concert, dateLabel, imageURL) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'concert-share-icon';
  button.title = 'Share concert';
  button.setAttribute('aria-label', `Share ${concert.artist} concert image`);
  button.style.cssText = 'display:inline-grid;place-items:center;min-width:44px;min-height:44px;background:none;border:0;color:var(--bone-dim,#aaa);cursor:pointer';
  button.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>';

  button.onclick = async event => {
    event.stopPropagation();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Concert image preview');
    dialog.style.cssText = 'background:#101010;color:#eee;border:1px solid #444;padding:20px;width:min(440px,calc(100vw - 32px));max-height:88dvh;overflow:auto;box-sizing:border-box';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'min-height:44px;padding:8px 16px';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Preparing image…';
    dialog.append(close, status);
    document.body.append(dialog);
    let objectURL;
    close.onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
      if (objectURL) URL.revokeObjectURL(objectURL);
      dialog.remove();
      button.focus();
    }, { once: true });
    dialog.showModal();

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1080;
      canvas.height = 1350;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.fillStyle = '#090909';
      ctx.fillRect(0, 0, 1080, 1350);
      let hasPhoto = false;

      if (imageURL && !/e23066163f21176a822b54001ee648a2|placeholder/i.test(imageURL)) {
        try {
          const url = new URL(imageURL, location.href);
          if (!/^https?:$/.test(url.protocol)) throw new Error('Invalid image');
          const response = await fetch(url, {
            signal: AbortSignal.timeout(12000)
          });
          if (!response.ok) throw new Error('Photo unavailable');
          const bitmap = await createImageBitmap(await response.blob());
          const scale = Math.max(1080 / bitmap.width, 1080 / bitmap.height);
          ctx.drawImage(
            bitmap,
            (1080 - bitmap.width * scale) / 2,
            (1080 - bitmap.height * scale) / 2,
            bitmap.width * scale,
            bitmap.height * scale
          );
          bitmap.close();
          hasPhoto = true;
        } catch {}
      }

      const fade = ctx.createLinearGradient(0, 630, 0, 1160);
      fade.addColorStop(0, 'rgba(9,9,9,0)');
      fade.addColorStop(1, '#090909');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 630, 1080, 720);

      await Promise.race([
        document.fonts.load('90px "Instrument Serif"').catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);

      function wrap(text, font) {
        ctx.font = font;
        const lines = [];
        let line = '';
        for (const word of String(text || '').trim().split(/\s+/)) {
          const next = line ? `${line} ${word}` : word;
          if (line && ctx.measureText(next).width > 960) {
            lines.push(line);
            line = word;
          } else {
            line = next;
          }
        }
        if (line) lines.push(line);
        return lines;
      }

      let size = 104;
      let title;
      do {
        title = wrap(concert.artist || 'Live concert',
          `${size}px "Instrument Serif", Georgia, serif`);
        if (title.length <= 3) break;
        size -= 4;
      } while (size > 40);

      ctx.textBaseline = 'top';
      ctx.fillStyle = '#f0eee7';
      let y = 1090 - title.length * size * 1.04;
      for (const line of title) {
        ctx.fillText(line, 60, y, 960);
        y += size * 1.04;
      }

      ctx.fillStyle = '#bbb9b0';
      ctx.font = '28px monospace';
      ctx.fillText(
        String(dateLabel || concert.date || '').toUpperCase(),
        60, 1140, 960
      );
      const venue = [concert.venue, concert.city]
        .filter(Boolean).join(' · ').toUpperCase();
      wrap(venue, '28px monospace').forEach((line, i) => {
        ctx.fillText(line, 60, 1200 + i * 36, 960);
      });

      const blob = await new Promise(resolve =>
        canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Image unavailable');
      if (!dialog.isConnected) return;

      objectURL = URL.createObjectURL(blob);
      const preview = document.createElement('img');
      preview.src = objectURL;
      preview.alt = `${concert.artist} concert poster`;
      preview.style.cssText = 'display:block;width:100%;height:auto;margin:16px 0';
      dialog.insertBefore(preview, status);
      status.textContent = hasPhoto
        ? 'Ready to share.'
        : 'Photo unavailable. This preview contains the concert details only.';

      const filename = (
        String(concert.artist || 'concert')
          .replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 70)
      ) + '.png';
      const file = new File([blob], filename, { type: 'image/png' });

      if (navigator.canShare?.({ files: [file] })) {
        const share = document.createElement('button');
        share.type = 'button';
        share.textContent = 'Share image';
        share.style.cssText = 'min-height:44px;padding:12px';
        share.onclick = async () => {
          try {
            await navigator.share({ files: [file] });
          } catch (error) {
            if (error.name !== 'AbortError') {
              status.textContent = 'Use Download image if sharing is unavailable.';
            }
          }
        };
        dialog.append(share);
      }

      const download = document.createElement('a');
      download.href = objectURL;
      download.download = filename;
      download.textContent = 'Download image';
      download.style.cssText = 'display:inline-block;color:#eee;padding:12px';
      dialog.append(download);
    } catch {
      if (dialog.isConnected) {
        status.textContent = 'Could not prepare the image. Close and try again.';
      }
    }
  };

  return button;
}
