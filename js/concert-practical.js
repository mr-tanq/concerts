const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function updatePractical(data,id,changes) {
  const c=data.concerts?.find(c=>c.id===id);
  if(!c) throw new Error('This concert is no longer in Going.');
  const next={...c.practical};
  if(Object.hasOwn(changes,'ticketBought')) next.ticketBought=changes.ticketBought===true;
  if(Object.hasOwn(changes,'note')) {
    if(typeof changes.note!=='string' || changes.note.length>1000) throw new Error('Keep the note under 1,000 characters.');
    next.note=changes.note.trim();
  }
  c.practical=next;
  return next;
}
export function mountPractical(host,concert,save) {
  const p=concert.practical || {};
  const destination=[concert.venue,concert.city,concert.country].filter(Boolean).join(', ');
  host.innerHTML=`<section aria-label="Concert essentials" style="border-top:1px solid var(--hair);padding:20px 0"><p class="whisper">For the night</p><div class="act-row" style="padding:0"><button type="button" class="plain-act" data-ticket aria-pressed="${p.ticketBought===true}">${p.ticketBought===true?'Ticket bought ✓':'Mark ticket as bought'}</button>${destination?`<a class="plain-act" href="https://www.google.com/maps/dir/?api=1&amp;destination=${escapeHTML(encodeURIComponent(destination))}" target="_blank" rel="noopener noreferrer">Directions ↗</a>`:''}</div><details style="margin-top:18px"><summary>${p.note?'Concert note':'Add a note'}</summary><form style="margin-top:12px"><label class="footnote" style="display:block">Concert note<textarea class="note-field" rows="3" maxlength="1000" placeholder="A reminder for this show" style="display:block;width:100%;box-sizing:border-box">${escapeHTML(p.note || '')}</textarea></label><p class="footnote">Saved in your public GitHub repository. Do not include ticket codes or private details.</p><button class="plain-act" type="submit">Save note</button></form></details><p class="status" role="status" aria-live="polite"></p></section>`;
  const ticket=host.querySelector('[data-ticket]'),form=host.querySelector('form'),status=host.querySelector('[role="status"]');
  let busy=false;
  async function persist(changes) {
    if(busy)return;
    busy=true;ticket.disabled=true;form.querySelector('button').disabled=true;status.textContent='Saving…';
    try {
      const practical=await save(changes);
      concert.practical=practical;
      if(!host.isConnected)return;
      ticket.textContent=practical.ticketBought?'Ticket bought ✓':'Mark ticket as bought';
      ticket.setAttribute('aria-pressed',String(practical.ticketBought===true));
      host.querySelector('summary').textContent=practical.note?'Concert note':'Add a note';
      status.textContent='Saved.';
    } catch(e){if(host.isConnected) status.textContent='Could not save. '+e.message;}
    finally{busy=false;ticket.disabled=false;form.querySelector('button').disabled=false;}
  }
  ticket.addEventListener('click',()=>persist({ticketBought:concert.practical?.ticketBought!==true}));
  form.addEventListener('submit',e=>{e.preventDefault();persist({note:form.querySelector('textarea').value});});
}
