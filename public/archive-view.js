// The Town Archive: a full-screen layer that lists what the cats have made and opens one to read. The town square's notice
// board and its label fly the camera there first (memorial-transition.js with the board's shot); artifact links in quests
// and chat open it straight on one artifact. The layer is a Memorial-style <dialog> (memorial-view.js) on its own event,
// so it pauses the town without the Memorial's music. The list and the reader are the Gallery's (gallery-view.js), with
// the reader mounted inside the dialog so it sits in the same top layer.
import {createGalleryView} from './gallery-view.js';
import {createMemorialView,ARCHIVE_EVENT} from './memorial-view.js';

export function createArchiveView({dialog,body,dock=null,catName}){
  const gallery=createGalleryView(body,{host:dialog,catName});
  // Escape closes an open artifact first and the Archive on the next press. Added before the view's own cancel handler.
  dialog.addEventListener('cancel',event=>{if(!gallery.viewing)return;event.preventDefault();event.stopImmediatePropagation();gallery.close();});
  // A card's title clamps to two lines (immersive.css); the full title shows on hover, and the reader shows it whole.
  const titles=()=>{for(const card of body.querySelectorAll('.gallery-card')){const t=card.querySelector('.gallery-meta strong')?.textContent;if(t)card.title=t;}};
  const view=createMemorialView({dialog,dock,closeId:'archive-close',eventName:ARCHIVE_EVENT,focusEvent:null});
  dialog.addEventListener('close',()=>gallery.close());
  return {
    dialog,show:view.show,close:view.close,announce:view.announce,intercept:view.intercept,load:()=>Promise.resolve(gallery.load()).then(titles),
    /** Opens the reader on one artifact, reloading the list once if it is not there yet. An unknown id says so in the list. */
    async openArtifact(id){if(!gallery.openArtifact(id)){await gallery.load();gallery.openArtifact(id);}},
    get count(){return gallery.count;},
    get isOpen(){return view.isOpen;},
  };
}
