// "Jump to latest" arrow for chat-shaped scroll containers. The threshold helpers are pure so the tests can load them.
export const SCROLL_LATEST_THRESHOLD=80;
const SIZE=44,GAP=12;

/** Pixels between the bottom of the visible area and the end of the content. */
export const distanceFromBottom=m=>m.scrollHeight-m.scrollTop-m.clientHeight;
/** The arrow shows only once the reader is more than the threshold above the bottom. */
export const showScrollLatest=(m,threshold=SCROLL_LATEST_THRESHOLD)=>distanceFromBottom(m)>threshold;

/**
 * Adds the arrow beside scrollEl (inside its panel, so it never scrolls with the messages and sits above the composer).
 * Existing auto-scroll on new messages is untouched; the arrow only shows a dot when messages arrive while scrolled up.
 */
export function attachScrollLatest(scrollEl){
  const host=scrollEl.parentElement;
  if(getComputedStyle(host).position==='static')host.style.position='relative';
  const btn=document.createElement('button');
  btn.type='button';btn.className='scroll-latest';btn.hidden=true;
  btn.setAttribute('aria-label','Scroll to latest message');
  btn.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9.5l6 6 6-6"/></svg><span class="scroll-latest-dot" aria-hidden="true"></span>';
  host.insertBefore(btn,scrollEl.nextSibling);
  let known=scrollEl.childElementCount,unseen=false;
  const metrics=()=>({scrollTop:scrollEl.scrollTop,scrollHeight:scrollEl.scrollHeight,clientHeight:scrollEl.clientHeight});

  const place=()=>{
    if(!scrollEl.getClientRects().length){btn.hidden=true;return;}
    // Offsets are in the host's content space, so the arrow scrolls with the host like the pane does, and stays in place when the host is scrolled.
    btn.style.left=`${scrollEl.offsetLeft+scrollEl.clientLeft+scrollEl.clientWidth-SIZE-GAP}px`;
    btn.style.top=`${scrollEl.offsetTop+scrollEl.clientTop+scrollEl.clientHeight-SIZE-GAP}px`;
    const show=showScrollLatest(metrics());
    btn.hidden=!show;
    btn.classList.toggle('has-new',show&&unseen);
  };
  const settle=()=>{if(!showScrollLatest(metrics())){unseen=false;known=scrollEl.childElementCount;}};

  btn.onclick=()=>{
    const reduce=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scrollEl.scrollTo({top:scrollEl.scrollHeight,behavior:reduce?'auto':'smooth'});
  };
  scrollEl.addEventListener('scroll',()=>{settle();place();},{passive:true});
  new MutationObserver(()=>{
    if(!showScrollLatest(metrics()))settle();
    else if(scrollEl.childElementCount>known)unseen=true;
    place();
  }).observe(scrollEl,{childList:true});
  if(globalThis.ResizeObserver){const ro=new ResizeObserver(place);ro.observe(scrollEl);ro.observe(host);}
  place();
}
