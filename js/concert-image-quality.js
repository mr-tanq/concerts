// A source-site logo is not concert artwork. This shared check protects
// the parser, saved planned records, cache fallbacks, and browser rendering.
const GENERIC_FILE=/(?:^|[-_])(?:placeholder|no[-_]?image|noavatar|default[-_]?image|dummy[-_]?image|missing[-_]?image|image[-_]?not[-_]?found)(?:[-_.]|$)/i;
const SOCIAL_LOGO=/^(?:facebook|instagram|twitter|x|youtube|tiktok|pinterest|linkedin)(?:[-_](?:logo|icon|share))?\.(?:png|jpe?g|gif|webp|svg)$/i;
const SITE_BADGE=/^(?:podiuminfo|festivalinfo)(?:[-_](?:rond|round|logo|icon))?\.(?:png|jpe?g|gif|webp|svg)$/i;
export function usableConcertImage(raw) {
  if(typeof raw!=='string'||!raw.trim())return null;
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password)return null;
    const f=decodeURIComponent(u.pathname.split('/').at(-1)||'');
    if(!f||GENERIC_FILE.test(f)||SOCIAL_LOGO.test(f)||SITE_BADGE.test(f)
      ||/^(?:favicon|apple-touch-icon|site-logo)\b/i.test(f))return null;
    return u.href;
  }catch{return null;}
}
export function podiuminfoArtistImage(raw) {
  const url=usableConcertImage(raw);
  if(!url)return null;
  const u=new URL(url);
  if(!['podiuminfo.nl','www.podiuminfo.nl','festivalinfo.nl','www.festivalinfo.nl'].includes(u.hostname)
     ||!/\/img\/artist\/\d+\/[^/]+\.(?:jpe?g|png|webp)$/i.test(u.pathname))return null;
  return url;
}
