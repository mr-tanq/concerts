const key = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const codes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const countries = new Map(codes.map(code=>[code.toLowerCase(),code]));
const english = new Intl.DisplayNames(['en'],{type:'region'});
for (const language of ['en','el','nl']) {
  const names=new Intl.DisplayNames([language],{type:'region'});
  for (const code of codes) countries.set(key(names.of(code)),code);
}
for (const [code,names] of Object.entries({GR:['Ελλάδα','Ελλάς','Hellas','EL'],NL:['Ολλανδία','Holland','The Netherlands'],GB:['UK','Great Britain','Britain','England','Αγγλία'],US:['USA','United States of America'],MK:['Macedonia'],CZ:['Czech Republic'],TR:['Turkey','Türkiye']})) {
  for (const name of names) countries.set(key(name),code);
}
export function countryCode(value) {
  return countries.get(key(typeof value==='object' && value ? value.name || value.identifier : value)) || null;
}
export const countryName = code => code==='NL' ? 'the Netherlands' : countryCode(code) ? english.of(countryCode(code)) : '';
export function searchLocation(value) {
  const raw=String(value || '').trim();
  if (!raw) return {country:'NL',place:'',label:'the Netherlands'};
  const code=countryCode(raw);
  if (code) return {country:code,place:'',label:countryName(code)};
  const parts=raw.split(',').map(s=>s.trim()), suffix=parts.length>1 ? countryCode(parts.at(-1)) : null;
  if (suffix && parts.slice(0,-1).every(Boolean)) {
    const place=parts.slice(0,-1).join(', ');
    return {country:suffix,place,label:`${place}, ${countryName(suffix)}`};
  }
  return {country:null,place:raw,label:raw};
}
const cityAliases = new Map(Object.entries({athens:'athens',athina:'athens',αθηνα:'athens',thessaloniki:'thessaloniki',θεσσαλονικη:'thessaloniki',patras:'patras',patra:'patras',πατρα:'patras',piraeus:'piraeus',πειραιας:'piraeus'}));
export function locationKey(value) { const normal=key(value);return cityAliases.get(normal) || normal; }
export function matchesLocation(concert, scope) {
  return (!scope.country || countryCode(concert.country)===scope.country) && (!scope.place || [concert.city,concert.venue].some(v=>locationKey(v).includes(locationKey(scope.place))));
}
// Only unambiguous venue zones used by the schedule. Countries spanning several
// time zones need a venue-specific zone; an Amsterdam clock is never substituted.
const zones={NL:'Europe/Amsterdam',BE:'Europe/Brussels',GR:'Europe/Athens',CY:'Asia/Nicosia',GB:'Europe/London',IE:'Europe/Dublin',DE:'Europe/Berlin',FR:'Europe/Paris',IT:'Europe/Rome',AT:'Europe/Vienna',CH:'Europe/Zurich',LU:'Europe/Luxembourg',PL:'Europe/Warsaw',CZ:'Europe/Prague',SK:'Europe/Bratislava',HU:'Europe/Budapest',RO:'Europe/Bucharest',BG:'Europe/Sofia',HR:'Europe/Zagreb',SI:'Europe/Ljubljana',RS:'Europe/Belgrade',MK:'Europe/Skopje',AL:'Europe/Tirane',ME:'Europe/Podgorica',BA:'Europe/Sarajevo',MT:'Europe/Malta',DK:'Europe/Copenhagen',SE:'Europe/Stockholm',NO:'Europe/Oslo',FI:'Europe/Helsinki',IS:'Atlantic/Reykjavik',EE:'Europe/Tallinn',LV:'Europe/Riga',LT:'Europe/Vilnius',TR:'Europe/Istanbul',JP:'Asia/Tokyo',KR:'Asia/Seoul',SG:'Asia/Singapore'};
export const countryZone = value => zones[countryCode(value)] || null;
