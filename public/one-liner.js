// Text to at most max characters: cut at a word when one ends in the second half, with an ellipsis. No imports, so the server and the first page load can use it.
export function cutAtWord(text,max){
  if(text.length<=max)return text;
  if(max<=0)return '';
  const cut=text.slice(0,max-1),space=cut.lastIndexOf(' ');
  return (space>max*.5?cut.slice(0,space):cut).trimEnd()+'…';
}

// First sentence of a message as a short line, capped at max characters with an ellipsis at a word boundary.
export function oneLiner(text,max=40){
  // Markdown marks go; an underscore inside a name (push_files) stays.
  const sentence=String(text??'').replace(/[*#>`]/g,'').replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g,'').split(/[.!?]+(?=\s|$)|[\r\n]/).map(s=>s.replace(/^[.!?\s]+/,'').replace(/\s+/g,' ').trim()).find(Boolean)||'';
  return cutAtWord(sentence,max);
}
